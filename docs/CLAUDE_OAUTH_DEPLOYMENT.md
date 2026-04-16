# Deploying Codebuff-Lite with Claude OAuth

This guide explains how to deploy codebuff-lite containers that use your Claude Pro/Max subscription instead of Codebuff credits.

## Overview

Codebuff-lite can use your Claude subscription via OAuth, but Anthropic's OAuth implementation **rotates refresh tokens on every use**. This creates a challenge for multi-container deployments:

- Container A refreshes the token → gets a new refresh token
- Container B tries to refresh with the old token → **fails**

There are two deployment strategies depending on how many replicas you need.

---

## Choosing a Deployment Strategy

| | Shared Volume | Centralized Token Service |
|---|---|---|
| **Recommended for** | **1–3 replicas** ✅ | **4+ replicas** |
| Architecture | All pods mount a shared PVC and read/write `credentials.json` directly | A single-replica service holds the refresh token; pods fetch access tokens via HTTP |
| Extra infrastructure | ReadWriteMany PVC (NFS, EFS, CephFS) | Token service Deployment + PVC |
| Token refresh | SDK auto-refreshes with atomic writes + file locking | Token service handles all refreshes centrally |
| Race condition risk | Very low at 1–3 replicas (tokens last ~1 hour) | None — single process refreshes |
| Complexity | **Simple** — no extra services | Moderate — additional service to deploy and monitor |

### Option A: Shared Volume (Recommended for 1–3 Replicas)

All pods mount a **ReadWriteMany PVC** at `~/.config/manicode/`. The SDK reads credentials from the file and writes refreshed tokens back automatically using `atomicWriteFileSync` and `withCredentialFileLock`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Your Infrastructure                              │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  Shared PVC (ReadWriteMany)                                    │     │
│  │  ~/.config/manicode/credentials.json                           │     │
│  │  ← SDK reads & writes refreshed tokens here (atomic writes)   │     │
│  └──────────┬────────────┬────────────┬──────────────────────────┘     │
│             │            │            │                                  │
│       ┌─────▼─────┐┌────▼──────┐┌────▼──────┐                         │
│       │  Codebuff ││ Codebuff  ││ Codebuff  │                         │
│       │  Pod #1   ││ Pod #2    ││ Pod #3    │                         │
│       └───────────┘└───────────┘└───────────┘                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌──────────────────┐
                         │  Anthropic API   │
                         │  (Claude Models) │
                         └──────────────────┘
```

👉 **Full manifests and setup:** See [Kubernetes Deployment Guide](./k8s-deployment.md) — it uses this approach by default.

### Option B: Centralized Token Service (Recommended for 4+ Replicas)

A single-replica **Claude Token Service** holds the only refresh token and serves cached access tokens to all pods via HTTP. This eliminates refresh token rotation races entirely.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Your Infrastructure                              │
│                                                                          │
│  ┌──────────────────────┐                                               │
│  │  Claude Token Service│  ← Holds the ONLY refresh token               │
│  │  (single replica)    │  ← Refreshes tokens proactively               │
│  │  Port 8080           │  ← Caches access tokens (~1 hour)             │
│  └──────────┬───────────┘                                               │
│             │                                                            │
│             │  GET /token → { access_token, expires_in }                │
│             │                                                            │
│       ┌─────┴─────┬─────────────┬─────────────┐                         │
│       ▼           ▼             ▼             ▼                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                       │
│  │codebuff │ │codebuff │ │codebuff │ │codebuff │  ← All use same      │
│  │ -lite   │ │ -lite   │ │ -lite   │ │ -lite   │    access token      │
│  │   #1    │ │   #2    │ │   #3    │ │   #N    │                       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌──────────────────┐
                         │  Anthropic API   │
                         │  (Claude Models) │
                         └──────────────────┘
```

---

## Quick Start

### Step 1: Get a Refresh Token (One-Time Setup)

On a machine with a browser:

```bash
# Install/run the main Codebuff CLI
codebuff

# Connect your Claude subscription
/connect:claude

# Complete the OAuth flow in your browser
# Then extract the refresh token:
cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken'
```

Save this refresh token securely — you'll need it for the token service.

### Step 2: Generate an Auth Token

```bash
# Generate a secure random token to protect the token service API
openssl rand -hex 32
```

Save this as your `AUTH_TOKEN`.

### Step 3: Deploy

- **1–3 replicas (shared volume):** Follow the [Kubernetes Deployment Guide](./k8s-deployment.md) — it uses the shared volume approach with full manifests, init containers, and troubleshooting.
- **4+ replicas (token service):** See deployment options below (Docker Compose, Kubernetes, etc.)

> **If you chose the shared volume approach**, the [Kubernetes Deployment Guide](./k8s-deployment.md) has everything you need. The remainder of this document covers the **Token Service** approach.

### Step 4: Configure Codebuff-Lite Containers (Token Service Only)

Pass the access token to codebuff-lite via environment variable:

```bash
# Option A: Fetch token at container startup (recommended)
TOKEN=$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" \
  http://claude-token-service:8080/token | jq -r '.access_token')
CODEBUFF_CLAUDE_OAUTH_TOKEN="$TOKEN" codebuff-lite "your prompt"

# Option B: Use an entrypoint script (see examples below)
```

---

## Deployment Options

### Docker Compose (Recommended for Simple Deployments)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  # Centralized token service - MUST be single replica
  claude-token-service:
    build: ./services/claude-token-service
    # Or use a pre-built image:
    # image: your-registry/claude-token-service:latest
    ports:
      - "8080:8080"
    environment:
      CLAUDE_REFRESH_TOKEN: ${CLAUDE_REFRESH_TOKEN}
      AUTH_TOKEN: ${AUTH_TOKEN}
      PORT: "8080"
    volumes:
      - claude-tokens:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Codebuff-lite workers (can scale horizontally)
  codebuff-worker:
    image: your-codebuff-lite-image:latest
    depends_on:
      claude-token-service:
        condition: service_healthy
    environment:
      CODEBUFF_API_KEY: ${CODEBUFF_API_KEY}
      TOKEN_SERVICE_URL: http://claude-token-service:8080
      TOKEN_SERVICE_AUTH: ${AUTH_TOKEN}
    # Use entrypoint script to fetch token (see below)
    entrypoint: ["/app/entrypoint.sh"]
    deploy:
      replicas: 3  # Scale as needed

volumes:
  claude-tokens:
    driver: local
```

Create `.env` file:

```bash
# Get this from /connect:claude
CLAUDE_REFRESH_TOKEN=your-refresh-token-here

# Generate with: openssl rand -hex 32
AUTH_TOKEN=your-secure-auth-token

# Your Codebuff API key
CODEBUFF_API_KEY=your-codebuff-api-key
```

### Kubernetes

> **For 1–3 replicas**, use the **shared volume approach** from the [Kubernetes Deployment Guide](./k8s-deployment.md) instead — it's simpler and requires no extra services. The token service manifests below are for **4+ replicas** or strict reliability requirements where you need to eliminate refresh token rotation races entirely.

```yaml
# 1. Secrets
apiVersion: v1
kind: Secret
metadata:
  name: claude-oauth-secrets
  namespace: codebuff
type: Opaque
stringData:
  refresh-token: "your-refresh-token-from-connect-claude"
  auth-token: "your-secure-auth-token"
  codebuff-api-key: "your-codebuff-api-key"

---
# 2. Persistent storage for token rotation
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: claude-token-pvc
  namespace: codebuff
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Mi

---
# 3. Token Service Deployment (SINGLE REPLICA!)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-token-service
  namespace: codebuff
spec:
  replicas: 1  # ⚠️ CRITICAL: Must be exactly 1
  strategy:
    type: Recreate  # Don't run multiple during rollout
  selector:
    matchLabels:
      app: claude-token-service
  template:
    metadata:
      labels:
        app: claude-token-service
    spec:
      containers:
      - name: token-service
        image: your-registry/claude-token-service:latest
        ports:
        - containerPort: 8080
        env:
        - name: CLAUDE_REFRESH_TOKEN
          valueFrom:
            secretKeyRef:
              name: claude-oauth-secrets
              key: refresh-token
        - name: AUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: claude-oauth-secrets
              key: auth-token
        - name: PORT
          value: "8080"
        volumeMounts:
        - name: token-data
          mountPath: /data
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: token-data
        persistentVolumeClaim:
          claimName: claude-token-pvc

---
# 4. Token Service - Internal Service
apiVersion: v1
kind: Service
metadata:
  name: claude-token-service
  namespace: codebuff
spec:
  selector:
    app: claude-token-service
  ports:
  - port: 80
    targetPort: 8080

---
# 5. Codebuff-Lite Workers (scale as needed)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: codebuff-workers
  namespace: codebuff
spec:
  replicas: 5  # Scale as needed
  selector:
    matchLabels:
      app: codebuff-worker
  template:
    metadata:
      labels:
        app: codebuff-worker
    spec:
      initContainers:
      # Fetch token before main container starts
      - name: fetch-token
        image: curlimages/curl:latest
        command:
        - sh
        - -c
        - |
          TOKEN=$(curl -sf -H "Authorization: Bearer $AUTH_TOKEN" \
            http://claude-token-service/token | \
            sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
          echo "$TOKEN" > /shared/claude-token
        env:
        - name: AUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: claude-oauth-secrets
              key: auth-token
        volumeMounts:
        - name: shared
          mountPath: /shared
      containers:
      - name: codebuff-lite
        image: your-registry/codebuff-lite:latest
        env:
        - name: CODEBUFF_API_KEY
          valueFrom:
            secretKeyRef:
              name: claude-oauth-secrets
              key: codebuff-api-key
        - name: CODEBUFF_CLAUDE_OAUTH_TOKEN
          value: "$(cat /shared/claude-token)"
        # Or use entrypoint script approach
        volumeMounts:
        - name: shared
          mountPath: /shared
      volumes:
      - name: shared
        emptyDir: {}
```

---

## Entrypoint Script for Codebuff-Lite Containers

Create `entrypoint.sh` for your codebuff-lite container:

```bash
#!/bin/bash
set -e

# Configuration
TOKEN_SERVICE_URL="${TOKEN_SERVICE_URL:-http://claude-token-service:8080}"
TOKEN_SERVICE_AUTH="${TOKEN_SERVICE_AUTH}"
TOKEN_REFRESH_BUFFER=300  # Refresh 5 min before expiry

# Cached token
CACHED_TOKEN=""
CACHED_EXPIRES_AT=0

fetch_token() {
    local response
    response=$(curl -sf -H "Authorization: Bearer $TOKEN_SERVICE_AUTH" \
        "$TOKEN_SERVICE_URL/token" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to fetch token from $TOKEN_SERVICE_URL" >&2
        return 1
    fi
    
    CACHED_TOKEN=$(echo "$response" | jq -r '.access_token')
    CACHED_EXPIRES_AT=$(echo "$response" | jq -r '.expires_at')
    
    if [ -z "$CACHED_TOKEN" ] || [ "$CACHED_TOKEN" = "null" ]; then
        echo "ERROR: Invalid token response" >&2
        return 1
    fi
    
    echo "Token fetched, expires at $(date -d @$CACHED_EXPIRES_AT 2>/dev/null || date -r $CACHED_EXPIRES_AT)" >&2
}

get_valid_token() {
    local now=$(date +%s)
    local refresh_at=$((CACHED_EXPIRES_AT - TOKEN_REFRESH_BUFFER))
    
    if [ -z "$CACHED_TOKEN" ] || [ $now -ge $refresh_at ]; then
        fetch_token || return 1
    fi
    
    echo "$CACHED_TOKEN"
}

# Initial token fetch
if ! fetch_token; then
    echo "FATAL: Cannot start without valid Claude OAuth token" >&2
    exit 1
fi

# Export for codebuff-lite
export CODEBUFF_CLAUDE_OAUTH_TOKEN="$CACHED_TOKEN"

# Run codebuff-lite with all arguments
exec codebuff-lite "$@"
```

Make it executable:
```bash
chmod +x entrypoint.sh
```

---

## Environment Variables Reference

### Claude Token Service

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_REFRESH_TOKEN` | Yes* | - | OAuth refresh token from `/connect:claude` |
| `AUTH_TOKEN` | No | - | Bearer token to protect API endpoints |
| `CREDENTIALS_FILE` | No | `/data/credentials.json` | Path to persist rotated tokens |
| `PORT` | No | `8080` | HTTP server port |

*Required unless a valid credentials file exists

### Codebuff-Lite

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CODEBUFF_API_KEY` | Yes | - | Your Codebuff API key |
| `CODEBUFF_CLAUDE_OAUTH_TOKEN` | No | - | Claude access token (from token service) |
| `CODEBUFF_DEFAULT_MODE` | No | `MAX` | Agent mode: `DEFAULT`, `MAX`, or `PLAN` |
| `CODEBUFF_VERBOSE` | No | `0` | Verbose output (disabled by default, set to `1` to enable) |

---

## Token Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Token Service Lifecycle                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. STARTUP                                                              │
│     ├── Load refresh token from CLAUDE_REFRESH_TOKEN env var            │
│     ├── Or load from /data/credentials.json if exists                   │
│     └── Perform initial token exchange → get access token (~1hr)        │
│                                                                          │
│  2. RUNTIME                                                              │
│     ├── Background goroutine refreshes 5 min before expiry              │
│     ├── Any GET /token request returns cached token (or refreshes)      │
│     └── If Anthropic rotates refresh token → save to credentials file   │
│                                                                          │
│  3. SHUTDOWN                                                             │
│     └── Graceful shutdown on SIGTERM/SIGINT                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     Codebuff-Lite Token Usage                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. STARTUP                                                              │
│     ├── Entrypoint fetches token from token service                     │
│     ├── Sets CODEBUFF_CLAUDE_OAUTH_TOKEN env var                        │
│     └── checkClaudeSubscription() validates token                       │
│                                                                          │
│  2. RUNTIME                                                              │
│     ├── SDK uses token for Anthropic API calls                          │
│     ├── If token expires → container should refresh from token service  │
│     └── If refresh fails → exits (won't silently use Codebuff credits)  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### 1. Protect the Token Service

**Always set `AUTH_TOKEN`** — without it, anyone on your network can get access tokens:

```bash
# Generate secure token
AUTH_TOKEN=$(openssl rand -hex 32)
```

### 2. Network Isolation

- Keep the token service on an internal network
- Don't expose port 8080 to the internet
- Use Kubernetes NetworkPolicies or Docker networks

### 3. Secrets Management

- Use Kubernetes Secrets, HashiCorp Vault, AWS Secrets Manager, etc.
- Don't commit tokens to git
- Rotate the `AUTH_TOKEN` periodically

### 4. Persistent Storage

- The token service persists rotated refresh tokens to `/data/credentials.json`
- Use a persistent volume to survive restarts
- Without persistence, you'll need to re-run `/connect:claude` after every restart

---

## Troubleshooting

### "Claude subscription credentials are expired and could not be refreshed"

**Cause:** codebuff-lite couldn't validate the token at startup.

**Fix:**
1. Check token service health: `curl http://claude-token-service:8080/health`
2. Check token service logs for errors
3. Verify `CODEBUFF_CLAUDE_OAUTH_TOKEN` is set correctly
4. If refresh token is invalid, re-run `/connect:claude`

### "No refresh token available" (token service)

**Cause:** Token service started without a refresh token.

**Fix:**
1. Set `CLAUDE_REFRESH_TOKEN` environment variable
2. Or mount a credentials file with a valid refresh token

### "token refresh failed (status 401)" (token service)

**Cause:** Refresh token was invalidated (used by another client).

**Fix:**
1. Re-run `/connect:claude` to get a fresh refresh token
2. Ensure only ONE token service instance is running
3. Check no other process is using the same refresh token

### "unauthorized" response from token service

**Cause:** Missing or incorrect `Authorization` header.

**Fix:**
1. Include header: `Authorization: Bearer <AUTH_TOKEN>`
2. Verify `AUTH_TOKEN` matches what the service was started with

### Token expires mid-task

**Cause:** Long-running tasks may outlive the ~1 hour token.

**Fix:**
1. For long tasks, implement token refresh in your entrypoint
2. Or use shorter-lived containers with fresh tokens
3. The SDK will attempt refresh if `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` is set

---

## Monitoring

### Health Checks

```bash
# Token service health (no auth required)
curl http://claude-token-service:8080/health
# Returns: 200 OK

# Token service status (auth required)
curl -H "Authorization: Bearer $AUTH_TOKEN" \
  http://claude-token-service:8080/status
# Returns:
# {
#   "has_access_token": true,
#   "healthy": true,
#   "expires_at": 1774404450,
#   "expires_in": 3540
# }
```

### Prometheus Metrics (if needed)

The token service logs key events. For Prometheus, you could add a `/metrics` endpoint or use a log-based exporter to track:

- Token refresh count
- Refresh failures
- Token requests served
- Time until token expiry

---

## FAQ

**Q: Can I run multiple token service replicas?**

A: No. Anthropic rotates refresh tokens on every use. Multiple replicas would invalidate each other's tokens. Always run exactly 1 replica.

**Q: What happens if the token service goes down?**

A: Existing containers with cached tokens continue working until their tokens expire (~1 hour). New containers can't start. Use liveness/readiness probes and auto-restart.

**Q: Can I use this without the token service?**

A: Yes — and for **1–3 replicas it's the recommended approach**. Use a shared ReadWriteMany volume so the SDK reads and writes `credentials.json` directly. The SDK handles token refresh with atomic writes and file locking, which works reliably at low replica counts since access tokens last ~1 hour and simultaneous refresh races are rare. See the [Kubernetes Deployment Guide](./k8s-deployment.md) for full manifests and setup.

For **4+ replicas** or strict reliability, use the token service to eliminate races entirely.

**Q: How often does Anthropic rotate refresh tokens?**

A: On every token refresh. The token service handles this automatically and persists new tokens.

**Q: What's the access token lifetime?**

A: Approximately 1 hour. The token service refreshes 5 minutes before expiry.

---

## Support

- **Codebuff Docs:** https://codebuff.com/docs
- **Token Service Source:** `services/claude-token-service/`
- **Issues:** Contact your Codebuff support channel
