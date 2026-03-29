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
┌─────────────────────────────────────────────────────────┐
│  K8s Namespace                                          │
│                                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │  Shared PVC (ReadWriteMany)                     │    │
│  │  ~/.config/manicode/credentials.json            │    │
│  │  ← SDK reads & writes refreshed tokens here     │    │
│  └──────────┬────────────┬────────────┬───────────┘    │
│             │            │            │                  │
│       ┌─────▼─────┐┌────▼──────┐┌────▼──────┐         │
│       │  Codebuff ││ Codebuff  ││ Codebuff  │         │
│       │  Pod #1   ││ Pod #2    ││ Pod #N    │         │
│       └──────┬────┘└─────┬─────┘└─────┬─────┘         │
│              │           │            │                  │
│              ▼           ▼            ▼                  │
│       ┌──────────────────────────────────────┐         │
│       │  Codebuff Web API                     │         │
│       │  (www.codebuff.com)                   │         │
│       └──────────────────────────────────────┘         │
│              │                                          │
│              │  Claude OAuth (direct)                   │
│              ├───▶ api.anthropic.com                    │
│              │                                          │
│              │  Hippo memory (optional)                 │
│              └───▶ Neo4j (separate service)             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Codebuff authenticates two ways:
1. **Codebuff account** — via `~/.config/manicode/credentials.json` (device fingerprint + session)
2. **Claude subscription** — via OAuth refresh token → direct Anthropic API calls (bypasses Codebuff credit system)

All pods share a **writable PVC** mounted at `~/.config/manicode/`. The SDK reads credentials from this file and writes refreshed tokens back automatically using atomic file writes (`atomicWriteFileSync`) and in-process locking (`withCredentialFileLock`).

---

## Prerequisites

- **Bun** ≥ 1.3 (for building the binary)
- **Node.js** ≥ 18 (npm global bin for install target)
- A **Codebuff account** at [codebuff.com](https://codebuff.com)
- A **Claude Pro or Max subscription** at [claude.ai](https://claude.ai)
- `jq` (for extracting tokens)
- A **ReadWriteMany**-capable storage class (e.g. NFS, EFS, CephFS, Longhorn)

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

# Codebuff stores credentials and settings here — the PVC mounts over this
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

This creates `~/.config/manicode/credentials.json` containing your Codebuff session.

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

### Step 3: Create K8s Secrets (Seed Data)

The Secret stores the **initial** credentials that seed the shared volume on first boot. After that, the SDK keeps the file up to date with refreshed tokens.

The easiest way is to use the included script:

```bash
# Generate and apply secrets in one shot
./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -

# Or write to a file for review first
./scripts/generate-k8s-secrets.sh -n codebuff -o k8s-secrets.yaml
cat k8s-secrets.yaml   # review
kubectl apply -f k8s-secrets.yaml
```

The script reads `~/.config/manicode/credentials.json` and generates two Secrets:
- `codebuff-claude` — the refresh token (for the `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` env var fallback)
- `codebuff-credentials` — the full credentials file (used to seed the shared volume)

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

No env vars are strictly required when using the shared volume — credentials are read from `credentials.json` on the PVC.

> **ℹ️ `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` is safe to set alongside the shared volume** — the SDK treats it as a **fallback**. The file's credentials always take priority. The env var is only used if the file has no `claudeOAuth` section (e.g., if the init container fails, or the file is manually deleted). Once the first token refresh writes updated credentials to the file, the env var is ignored.

### Optional

| Variable | Default | Description |
|---|---|---|
| `CODEBUFF_CLAUDE_OAUTH_ENABLED` | `true` | Claude OAuth feature flag. Set to `false` to disable and fall back to Codebuff backend credits. |
| `CODEBUFF_CLAUDE_OAUTH_TOKEN` | _(empty)_ | Short-lived access token. Usually not needed — the SDK auto-refreshes using the refresh token. |
| `CODEBUFF_API_KEY` | _(from credentials file)_ | Codebuff API key. Alternative to using the shared volume credentials file. |
| `NEXT_PUBLIC_CB_ENVIRONMENT` | `prod` | Environment identifier (`prod`, `dev`). Affects the credentials file path (`~/.config/manicode/` for prod, `~/.config/manicode-dev/` for dev). |
| `NEXT_PUBLIC_CODEBUFF_APP_URL` | `https://www.codebuff.com` | Codebuff API endpoint. |

### Hippo Memory (Optional)

| Variable | Description |
|---|---|
| _No env vars_ | Hippo uses the `hippo` binary in `PATH`. It connects to Neo4j via its own configuration. See [Hippo Memory](#hippo-memory-optional) section. |

---

## K8s Manifests

### Secret (Seed Data)

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

### Credentials Secret (Initial Seed for Shared Volume)

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

### Shared Volume (PersistentVolumeClaim)

The shared volume stores `credentials.json` and allows the SDK to write refreshed tokens back to disk. All pods mount this volume read-write.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: codebuff-config
  namespace: codebuff
spec:
  accessModes:
    - ReadWriteMany   # All pods read and write to the same volume
  resources:
    requests:
      storage: 100Mi
  # Use a storage class that supports ReadWriteMany (NFS, EFS, CephFS, etc.)
  # storageClassName: efs-sc
```

> **Note:** `ReadWriteMany` requires a storage class that supports it. Common options:
> - **AWS:** EFS via `efs.csi.aws.com`
> - **GCP:** Filestore via `filestore.csi.storage.gke.io`
> - **On-prem:** NFS, CephFS, Longhorn (with NFS support)
>
> If your cluster only supports `ReadWriteOnce`, limit the Deployment to a **single replica**.

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: codebuff
  namespace: codebuff
spec:
  replicas: 2
  selector:
    matchLabels:
      app: codebuff
  template:
    metadata:
      labels:
        app: codebuff
    spec:
      initContainers:
        # Seed the shared volume with credentials.json from the Secret
        # Only copies if the file doesn't already exist (preserves refreshed tokens)
        - name: seed-credentials
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              if [ ! -f /config/credentials.json ]; then
                echo "Seeding credentials.json from Secret..."
                cp /seed/credentials.json /config/credentials.json
                chmod 600 /config/credentials.json
              else
                echo "credentials.json already exists, skipping seed."
              fi
          volumeMounts:
            - name: codebuff-config
              mountPath: /config
            - name: seed-credentials
              mountPath: /seed
              readOnly: true

      containers:
        - name: codebuff
          image: <your-registry>/codebuff:latest
          env:
            # CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN is optional here —
            # the SDK treats it as a fallback (file takes priority).
            # Uncomment to provide a bootstrap fallback:
            # - name: CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN
            #   valueFrom:
            #     secretKeyRef:
            #       name: codebuff-claude
            #       key: refresh-token

            # Codebuff API config
            - name: NEXT_PUBLIC_CB_ENVIRONMENT
              value: "prod"
            - name: NEXT_PUBLIC_CODEBUFF_APP_URL
              value: "https://www.codebuff.com"

          volumeMounts:
            # Shared writable volume for credentials
            - name: codebuff-config
              mountPath: /home/codebuff/.config/manicode

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
        # Shared writable PVC for credentials.json
        - name: codebuff-config
          persistentVolumeClaim:
            claimName: codebuff-config

        # Secret used only by the init container to seed the PVC
        - name: seed-credentials
          secret:
            secretName: codebuff-credentials

        - name: workspace
          # Your codebase — PVC, git-sync sidecar, or emptyDir
          emptyDir: {}
```

**How the init container works:**

1. **First deploy:** The PVC is empty, so the init container copies `credentials.json` from the Secret into the shared volume.
2. **Subsequent restarts:** The file already exists on the PVC (with SDK-refreshed tokens), so the init container skips the copy — preserving the latest tokens.
3. **Force re-seed:** Delete `credentials.json` from the PVC and restart the pods. The init container will copy the Secret's version again.

### Minimal Deployment (Env-Var Only, No Shared Volume)

If you prefer env-var-only auth (no shared volume or credentials file):

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

> **Note:** With the `CODEBUFF_API_KEY` env var, you don't need a credentials file at all. The SDK reads the refresh token from the env var and caches refreshed access tokens in memory. However, refreshed tokens won't persist across pod restarts — each new pod will re-exchange the refresh token.

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
│  1. Init container seeds credentials.json from Secret    │
│     (only if file doesn't already exist on the PVC)      │
│  2. SDK reads credentials from the shared volume         │
│  3. If access token expired → auto-refresh via           │
│     POST https://console.anthropic.com/v1/oauth/token    │
│  4. Response: { access_token, expires_in: 3600, ... }    │
│  5. SDK writes refreshed tokens back to the shared       │
│     volume using atomicWriteFileSync (atomic rename)     │
│                                                          │
│  Steady State                                            │
│                                                          │
│  - Access token used directly for Anthropic API calls    │
│  - Token auto-refreshes 5 min before expiry              │
│  - Refresh token is long-lived (months)                  │
│  - Refreshed tokens (including rotated refresh tokens)   │
│    are persisted to the shared volume automatically      │
│  - withCredentialFileLock prevents intra-process races   │
│  - atomicWriteFileSync prevents file corruption          │
│                                                          │
│  Failure Modes                                           │
│                                                          │
│  - Refresh fails → falls back to env var refresh token   │
│  - Refresh token revoked → re-authenticate on laptop     │
│    and update the K8s Secret + delete credentials.json   │
│    from the PVC so the init container re-seeds it        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### ⚠️ Multi-Replica Warning: Refresh Token Rotation

Anthropic **rotates the refresh token on every token refresh**. This creates a race condition with multiple replicas:

1. Pod A's access token expires → Pod A sends a refresh request
2. Anthropic returns a new access token **and a new refresh token**, invalidating the old one
3. Pod A writes the new refresh token to the shared volume
4. Pod B's access token expires → Pod B reads the (now-updated) refresh token from disk and refreshes successfully

This works **most of the time** because:
- Access tokens last ~1 hour, so refreshes are infrequent
- `atomicWriteFileSync` ensures Pod B reads a complete file (never a partial write)
- The SDK caches access tokens in memory, reducing disk reads

**However**, if two pods try to refresh at the exact same moment (both read the old refresh token before either writes the new one), one will succeed and the other will fail — Anthropic will reject the now-stale refresh token.

**Recommendations:**
- For **1–3 replicas**: the shared volume approach works well. Simultaneous refresh races are rare since tokens last an hour and pods rarely expire at the exact same moment.
- For **many replicas** or strict reliability requirements: use the centralized [Claude Token Service](./CLAUDE_OAUTH_DEPLOYMENT.md) instead, which ensures a single process handles all token refreshes.

**Key points for infra:**
- The refresh token does **not** expire quickly — it's valid for months.
- Access tokens last ~1 hour and are refreshed automatically.
- The shared volume persists refreshed tokens across pod restarts — no need to re-seed from the Secret unless the refresh token is revoked.
- If a pod fails to refresh, it will retry on the next API call and likely pick up the updated token from the shared volume.

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

# Check credentials file on the shared volume
kubectl exec -it <pod> -- cat /home/codebuff/.config/manicode/credentials.json | jq .

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
# Then update the K8s Secret and re-seed the shared volume:
./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -
kubectl exec -it <pod> -- rm /home/codebuff/.config/manicode/credentials.json
kubectl rollout restart deployment/codebuff -n codebuff
```

### Shared volume issues

```bash
# Check the PVC is bound
kubectl get pvc codebuff-config -n codebuff

# Check the volume is writable from the pod
kubectl exec -it <pod> -- touch /home/codebuff/.config/manicode/test && echo "writable"

# Check file permissions
kubectl exec -it <pod> -- ls -la /home/codebuff/.config/manicode/

# If credentials.json has wrong permissions after seeding
kubectl exec -it <pod> -- chmod 600 /home/codebuff/.config/manicode/credentials.json
```

Common volume issues:
- **PVC stuck in Pending**: no storage class supports `ReadWriteMany` — check `kubectl get storageclass`
- **Permission denied on write**: the container user doesn't have write access — check `securityContext` or use `fsGroup`
- **Stale credentials after Secret rotation**: delete `credentials.json` from the PVC and restart pods to re-seed:
  ```bash
  kubectl exec -it <pod> -- rm /home/codebuff/.config/manicode/credentials.json
  kubectl rollout restart deployment/codebuff -n codebuff
  ```

### Codebuff account auth not working

```bash
# Check credentials file is on the shared volume
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

If Claude OAuth fails, Codebuff falls back to routing through its own backend (using your Codebuff account credits). To verify you're using Claude directly:

```bash
# In the Codebuff CLI, check the status bar — it should show:
# "Claude: connected" (green dot)
# If it shows nothing about Claude, OAuth isn't working.

# Or run /connect:claude:status in the CLI
```

### Refresh token rotation race (multi-replica)

If you see intermittent `401` errors from Claude OAuth with multiple replicas:

1. Check if two pods refreshed at the same time (look for "Claude OAuth token refresh failed" in logs)
2. The failing pod should recover automatically on its next API call by reading the updated token from the shared volume
3. If it doesn't recover, delete `credentials.json` from the PVC and restart pods to re-seed from the Secret
4. For persistent issues, reduce replicas or switch to the [Claude Token Service](./CLAUDE_OAUTH_DEPLOYMENT.md)

---

## Rotating Secrets

When the refresh token needs rotation (rare — typically only if revoked):

```bash
# 1. Re-authenticate on your laptop
codebuff
/connect:claude

# 2. Regenerate and apply the seed Secret
./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -

# 3. Delete the old credentials from the shared volume so the init container re-seeds
kubectl exec -it <any-codebuff-pod> -- rm /home/codebuff/.config/manicode/credentials.json

# 4. Restart pods to trigger the init container
kubectl rollout restart deployment/codebuff -n codebuff
```

<details>
<summary>Manual alternative</summary>

```bash
NEW_TOKEN=$(cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken')
kubectl create secret generic codebuff-claude \
  --from-literal=refresh-token="$NEW_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

# Also update the env var fallback
kubectl rollout restart deployment/codebuff -n codebuff
```

</details>

---

## Quick Start Checklist

- [ ] Build the Codebuff binary from the `reillyse/hippo-integration` branch
- [ ] Authenticate locally: `codebuff` → login → `/connect:claude`
- [ ] Generate K8s Secrets: `./scripts/generate-k8s-secrets.sh -n codebuff | kubectl apply -f -`
- [ ] Create the `codebuff-config` PVC with `ReadWriteMany` access
- [ ] Build and push container image with binary + git
- [ ] Deploy with the shared volume, init container, and env vars from this guide
- [ ] Verify: exec into pod, check `credentials.json` exists on the PVC, confirm Claude OAuth works
- [ ] (Optional) Deploy Neo4j + hippo binary for persistent memory
