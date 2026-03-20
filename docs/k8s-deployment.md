# Codebuff: Kubernetes Deployment Guide

This guide covers deploying Codebuff (the `reillyse/hippo-integration` fork) in Kubernetes. It assumes the infra team has access to the repo and can build the binary.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Building the Binary](#building-the-binary)
4. [Authentication](#authentication)
5. [Environment Variables Reference](#environment-variables-reference)
6. [K8s Manifests](#k8s-manifests)
7. [Hippo Memory (Optional)](#hippo-memory-optional)
8. [Token Lifecycle](#token-lifecycle)
9. [Health Checks](#health-checks)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  K8s Pod                                            │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────────┐   │
│  │  Codebuff   │───▶│  Codebuff Web API        │   │
│  │  CLI Binary  │    │  (www.codebuff.com)      │   │
│  └──────┬──────┘    └──────────────────────────┘   │
│         │                                           │
│         │  Claude OAuth (direct)                    │
│         ├───▶ api.anthropic.com                     │
│         │                                           │
│         │  Hippo memory (optional)                  │
│         └───▶ Neo4j (separate service)              │
│                                                     │
└─────────────────────────────────────────────────────┘
```

Codebuff authenticates two ways:
1. **Codebuff account** — via `~/.config/manicode/credentials.json` (device fingerprint + session)
2. **Claude subscription** — via OAuth refresh token → direct Anthropic API calls (bypasses Codebuff credit system)

---

## Prerequisites

- **Bun** ≥ 1.3 (for building the binary)
- **Node.js** ≥ 18 (npm global bin for install target)
- A **Codebuff account** at [codebuff.com](https://codebuff.com)
- A **Claude Pro or Max subscription** at [claude.ai](https://claude.ai)
- `jq` (for extracting tokens)

---

## Building the Binary

The binary is a self-contained Bun-compiled executable. No runtime dependencies needed in the container.

```bash
# Clone the fork
git clone -b reillyse/hippo-integration <repo-url>
cd codebuff

# Build
./scripts/build-codebuff.sh

# Binary output
ls -la cli/bin/codebuff
```

The binary is at `cli/bin/codebuff`. Copy this into your container image.

### Container Image

```dockerfile
FROM ubuntu:22.04

# Runtime dependencies for the CLI
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the pre-built binary
COPY codebuff /usr/local/bin/codebuff
RUN chmod +x /usr/local/bin/codebuff

# Codebuff stores credentials and settings here
RUN mkdir -p /home/codebuff/.config/manicode
ENV HOME=/home/codebuff

WORKDIR /workspace
```

> **Note:** The Codebuff binary is compiled with Bun and is fully self-contained. No Node.js or Bun runtime is needed in the container. Git is needed for codebase operations.

---

## Authentication

### Step 1: Get Codebuff Credentials

Authenticate on a machine with a browser first:

```bash
codebuff
# Follow the login prompts in the browser
```

This creates `~/.config/manicode/credentials.json` containing your Codebuff session. You'll mount or inject this into the container.

### Step 2: Get Claude OAuth Refresh Token

This is the key piece for K8s — the refresh token is long-lived and allows the SDK to auto-refresh short-lived access tokens without a browser.

```bash
# Connect your Claude subscription (requires browser)
codebuff
/connect:claude
# Complete the OAuth flow in your browser

# Extract the refresh token
cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken'
```

Save this refresh token — you'll store it as a K8s Secret.

### Step 3: Create K8s Secrets

The easiest way is to use the included script that extracts all tokens and generates both Secret manifests:

```bash
# Generate and apply secrets in one shot
./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -

# Or write to a file for review first
./scripts/generate-k8s-secrets.sh -n codebuff -o k8s-secrets.yaml
cat k8s-secrets.yaml   # review
kubectl apply -f k8s-secrets.yaml
```

The script reads `~/.config/manicode/credentials.json` and generates two Secrets:
- `codebuff-claude` — the refresh token (for the `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` env var)
- `codebuff-credentials` — the full credentials file (mounted into the pod)

Run `./scripts/generate-k8s-secrets.sh --help` for all options (custom namespace, custom credentials path, etc.).

<details>
<summary>Manual alternative (without the script)</summary>

```bash
# Create the secret with the refresh token
kubectl create secret generic codebuff-claude \
  --from-literal=refresh-token="$(cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken')"

# Create the Codebuff credentials secret (the whole file)
kubectl create secret generic codebuff-credentials \
  --from-file=credentials.json=$HOME/.config/manicode/credentials.json
```

</details>

---

## Environment Variables Reference

### Required

| Variable | Description | Example |
|---|---|---|
| `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` | Long-lived refresh token from Claude OAuth. Enables auto-refresh of access tokens. | `ref_abc123...` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CODEBUFF_CLAUDE_OAUTH_ENABLED` | `true` | Claude OAuth feature flag. Set to `false` to disable and fall back to Codebuff backend credits. |
| `CODEBUFF_CLAUDE_OAUTH_TOKEN` | _(empty)_ | Short-lived access token. Usually not needed — the SDK auto-refreshes using the refresh token. |
| `CODEBUFF_API_KEY` | _(from credentials file)_ | Codebuff API key. Alternative to mounting the credentials file. |
| `NEXT_PUBLIC_CB_ENVIRONMENT` | `prod` | Environment identifier (`prod`, `dev`). Affects the credentials file path (`~/.config/manicode/` for prod, `~/.config/manicode-dev/` for dev). |
| `NEXT_PUBLIC_CODEBUFF_APP_URL` | `https://www.codebuff.com` | Codebuff API endpoint. |

### Hippo Memory (Optional)

| Variable | Description |
|---|---|
| _No env vars_ | Hippo uses the `hippo` binary in `PATH`. It connects to Neo4j via its own configuration. See [Hippo Memory](#hippo-memory-optional) section. |

---

## K8s Manifests

### Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: codebuff-claude
  namespace: codebuff
type: Opaque
stringData:
  refresh-token: "<your-claude-oauth-refresh-token>"
```

### Credentials ConfigMap (or Secret)

If mounting the full credentials file:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: codebuff-credentials
  namespace: codebuff
type: Opaque
stringData:
  credentials.json: |
    {
      "default": {
        "id": "<your-user-id>",
        "apiKey": "<your-codebuff-api-key>",
        "email": "<your-email>"
      },
      "claudeOAuth": {
        "accessToken": "",
        "refreshToken": "<your-refresh-token>",
        "expiresAt": 0,
        "connectedAt": 0
      }
    }
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: codebuff
  namespace: codebuff
spec:
  replicas: 1
  selector:
    matchLabels:
      app: codebuff
  template:
    metadata:
      labels:
        app: codebuff
    spec:
      containers:
        - name: codebuff
          image: <your-registry>/codebuff:latest
          env:
            # Claude OAuth — refresh token for auto-refresh
            - name: CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: codebuff-claude
                  key: refresh-token

            # Codebuff API config
            - name: NEXT_PUBLIC_CB_ENVIRONMENT
              value: "prod"
            - name: NEXT_PUBLIC_CODEBUFF_APP_URL
              value: "https://www.codebuff.com"

          volumeMounts:
            # Mount credentials file for Codebuff account auth
            - name: codebuff-credentials
              mountPath: /home/codebuff/.config/manicode/credentials.json
              subPath: credentials.json
              readOnly: true

            # Mount the target codebase
            - name: workspace
              mountPath: /workspace

          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "2Gi"
              cpu: "1000m"

      volumes:
        - name: codebuff-credentials
          secret:
            secretName: codebuff-credentials

        - name: workspace
          # Your codebase — PVC, git-sync sidecar, or emptyDir
          emptyDir: {}
```

### Minimal Deployment (Refresh Token Only)

If you prefer env-var-only auth (no credentials file mount):

```yaml
env:
  # Claude OAuth
  - name: CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN
    valueFrom:
      secretKeyRef:
        name: codebuff-claude
        key: refresh-token

  # Codebuff API key (instead of mounting credentials.json)
  - name: CODEBUFF_API_KEY
    valueFrom:
      secretKeyRef:
        name: codebuff-credentials
        key: api-key
```

> **Note:** With the `CODEBUFF_API_KEY` env var, you don't need to mount the credentials file. However, the refresh token env var is essential for Claude subscription routing.

---

## Hippo Memory (Optional)

Hippo provides persistent cross-session memory via a Neo4j knowledge graph. If you want memory in K8s:

### Requirements

1. **Hippo binary** — a separate Go binary (`hippo`), not bundled with Codebuff. Must be in `PATH`.
2. **Neo4j instance** — Hippo connects to Neo4j for graph storage. Deploy as a separate StatefulSet or use a managed Neo4j service.

### Hippo Binary in Container

```dockerfile
# Add to your Dockerfile
COPY hippo /usr/local/bin/hippo
RUN chmod +x /usr/local/bin/hippo
```

### Neo4j StatefulSet (Example)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: neo4j
  namespace: codebuff
spec:
  serviceName: neo4j
  replicas: 1
  selector:
    matchLabels:
      app: neo4j
  template:
    metadata:
      labels:
        app: neo4j
    spec:
      containers:
        - name: neo4j
          image: neo4j:5-community
          ports:
            - containerPort: 7474  # HTTP
            - containerPort: 7687  # Bolt
          env:
            - name: NEO4J_AUTH
              value: "neo4j/your-password"
          volumeMounts:
            - name: neo4j-data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: neo4j-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: neo4j
  namespace: codebuff
spec:
  selector:
    app: neo4j
  ports:
    - name: bolt
      port: 7687
    - name: http
      port: 7474
```

Hippo's own configuration handles the Neo4j connection URL. Refer to hippo documentation for its config file location and format.

---

## Token Lifecycle

Understanding how tokens work is important for long-running deployments:

```
┌─────────────────────────────────────────────────────────┐
│  Startup                                                 │
│                                                          │
│  1. SDK reads CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN        │
│  2. No access token cached → expiresAt = 0               │
│  3. First API call triggers auto-refresh                  │
│     POST https://console.anthropic.com/v1/oauth/token    │
│     { grant_type: "refresh_token", ... }                 │
│  4. Response: { access_token, expires_in: 3600, ... }    │
│  5. Access token cached in-memory for ~1 hour            │
│                                                          │
│  Steady State                                            │
│                                                          │
│  - Access token used directly for Anthropic API calls    │
│  - Token auto-refreshes 5 min before expiry              │
│  - Refresh token is long-lived (months)                  │
│  - In-memory cache prevents redundant refresh calls      │
│                                                          │
│  Failure Modes                                           │
│                                                          │
│  - Refresh fails → falls back to Codebuff backend        │
│    (uses Codebuff credits instead of Claude subscription) │
│  - Refresh token revoked → re-authenticate on laptop     │
│    and update the K8s Secret                              │
│                                                          │
│  File System                                             │
│                                                          │
│  - Credential file writes are wrapped in try-catch       │
│  - Read-only filesystem is fully supported               │
│  - All state is kept in-memory after first refresh       │
└─────────────────────────────────────────────────────────┘
```

**Key points for infra:**
- The refresh token does **not** expire quickly — it's valid for months.
- Access tokens last ~1 hour and are refreshed automatically.
- No persistent storage is needed for the OAuth flow — everything works with env vars + in-memory cache.
- If the filesystem is read-only, that's fine — credential saves are best-effort with error handling.

---

## Health Checks

Codebuff is a CLI tool, not a long-running server. Health checks depend on your usage pattern:

### For batch/job workloads

```yaml
# No liveness/readiness probes needed for K8s Jobs
apiVersion: batch/v1
kind: Job
metadata:
  name: codebuff-task
spec:
  template:
    spec:
      containers:
        - name: codebuff
          image: <your-registry>/codebuff:latest
          command: ["codebuff", "--prompt", "fix the bug in auth.ts"]
          # ... env vars as above
      restartPolicy: OnFailure
```

### For interactive/long-running pods

If running Codebuff interactively (e.g., via a web terminal or exec):

```yaml
livenessProbe:
  exec:
    command: ["codebuff", "--version"]
  initialDelaySeconds: 5
  periodSeconds: 60
```

---

## Troubleshooting

### Claude OAuth not working

```bash
# Verify the refresh token is set
kubectl exec -it <pod> -- env | grep CODEBUFF_CLAUDE_OAUTH

# Test token refresh manually
kubectl exec -it <pod> -- curl -s -X POST \
  https://console.anthropic.com/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"refresh_token","refresh_token":"<your-token>","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}' \
  | jq .
```

Expected response:
```json
{
  "access_token": "ant-oct_...",
  "refresh_token": "ant-rt_...",
  "expires_in": 3600,
  "token_type": "bearer"
}
```

If you get `401` or `400`, the refresh token has been revoked. Re-authenticate on your laptop:
```bash
codebuff
/connect:claude
# Then update the K8s Secret with the new refresh token
```

### Codebuff account auth not working

```bash
# Check credentials file is mounted
kubectl exec -it <pod> -- cat /home/codebuff/.config/manicode/credentials.json | jq .

# Check the API key env var (alternative)
kubectl exec -it <pod> -- env | grep CODEBUFF_API_KEY
```

### Hippo not connecting

```bash
# Check hippo binary is in PATH
kubectl exec -it <pod> -- which hippo

# Test hippo directly
kubectl exec -it <pod> -- hippo snapshot --json

# Check Neo4j connectivity
kubectl exec -it <pod> -- hippo sessions
```

### Falling back to Codebuff credits

If Claude OAuth fails, Codebuff silently falls back to routing through its own backend (using your Codebuff account credits). To verify you're using Claude directly:

```bash
# In the Codebuff CLI, check the status bar — it should show:
# "Claude: connected" (green dot)
# If it shows nothing about Claude, OAuth isn't working.

# Or run /connect:claude:status in the CLI
```

---

## Rotating Secrets

When the refresh token needs rotation (rare — typically only if revoked):

```bash
# 1. Re-authenticate on your laptop
codebuff
/connect:claude

# 2. Regenerate and apply secrets
./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -

# 3. Restart pods to pick up new secret
kubectl rollout restart deployment/codebuff -n codebuff
```

<details>
<summary>Manual alternative</summary>

```bash
NEW_TOKEN=$(cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken')
kubectl create secret generic codebuff-claude \
  --from-literal=refresh-token="$NEW_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
```

</details>

---

## Quick Start Checklist

- [ ] Build the Codebuff binary from the `reillyse/hippo-integration` branch
- [ ] Authenticate locally: `codebuff` → login → `/connect:claude`
- [ ] Generate K8s Secrets: `./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -`
- [ ] Build and push container image with binary + git
- [ ] Deploy with the env vars and volume mounts from this guide
- [ ] Verify: exec into pod, run `codebuff --version`, confirm Claude OAuth works
- [ ] (Optional) Deploy Neo4j + hippo binary for persistent memory
