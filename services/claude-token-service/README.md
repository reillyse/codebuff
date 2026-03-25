# Claude Token Service

A centralized OAuth token service for managing Claude OAuth credentials across multiple containers. This service solves the problem of refresh token rotation by being the **single source of truth** for token management.

## The Problem

Anthropic's OAuth implementation rotates refresh tokens on every use. This means:
- When Container A uses the refresh token, it gets a new one
- The old refresh token (that Container B might have) is now invalid
- Container B's requests fail with "Invalid authentication credentials"

## The Solution

This service acts as a centralized token manager:
1. **One service holds the refresh token** and performs all token refreshes
2. **Containers request access tokens** from this service (not refresh tokens)
3. **Access tokens are valid for ~1 hour** and can be used by multiple containers simultaneously
4. **Token rotation is handled automatically** - new refresh tokens are stored and persisted

```
┌──────────────────────┐
│  Claude Token Service│  ← Single refresh token holder
│  (this service)      │
└──────────┬───────────┘
           │ GET /token → access_token
     ┌─────┴─────┬─────────────┐
     ▼           ▼             ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Container│ │Container│ │Container│
│    A    │ │    B    │ │    C    │
└─────────┘ └─────────┘ └─────────┘
```

## Quick Start

### 1. Get a Refresh Token

On a machine with a browser:

```bash
# Start Codebuff and connect your Claude subscription
codebuff
/connect:claude

# Complete OAuth flow in browser, then extract refresh token:
cat ~/.config/manicode/credentials.json | jq -r '.claudeOAuth.refreshToken'
```

### 2. Run the Service

#### Docker

```bash
docker build -t claude-token-service .

docker run -d \
  --name claude-token-service \
  -p 8080:8080 \
  -e CLAUDE_REFRESH_TOKEN="your-refresh-token" \
  -e AUTH_TOKEN="your-secret-auth-token" \
  -v token-data:/data \
  claude-token-service
```

#### Binary

```bash
cd services/claude-token-service
go build -o claude-token-service .

CLAUDE_REFRESH_TOKEN="your-refresh-token" \
AUTH_TOKEN="your-secret-auth-token" \
./claude-token-service
```

#### Docker Compose

```yaml
version: '3.8'
services:
  claude-token-service:
    build: .
    ports:
      - "8080:8080"
    environment:
      - CLAUDE_REFRESH_TOKEN=${CLAUDE_REFRESH_TOKEN}
      - AUTH_TOKEN=${AUTH_TOKEN}
    volumes:
      - claude-tokens:/data

volumes:
  claude-tokens:
```

#### Kubernetes

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: claude-oauth
type: Opaque
stringData:
  refresh-token: "your-refresh-token-here"
  auth-token: "your-secret-auth-token"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-token-service
spec:
  replicas: 1  # IMPORTANT: Only 1 replica!
  selector:
    matchLabels:
      app: claude-token-service
  template:
    metadata:
      labels:
        app: claude-token-service
    spec:
      containers:
      - name: claude-token-service
        image: claude-token-service:latest
        ports:
        - containerPort: 8080
        env:
        - name: CLAUDE_REFRESH_TOKEN
          valueFrom:
            secretKeyRef:
              name: claude-oauth
              key: refresh-token
        - name: AUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: claude-oauth
              key: auth-token
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: claude-token-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: claude-token-service
spec:
  selector:
    app: claude-token-service
  ports:
  - port: 80
    targetPort: 8080
```

### 3. Use from Containers

Set `CLAUDE_TOKEN_SERVICE_URL` and `AUTH_TOKEN` in your containers:

```bash
docker run \
  -e CLAUDE_TOKEN_SERVICE_URL=http://claude-token-service:8080 \
  -e TOKEN_SERVICE_AUTH="your-secret-auth-token" \
  your-app
```

Then fetch tokens when needed:

```bash
# Get a valid access token (with authentication)
curl -H "Authorization: Bearer your-secret-auth-token" \
  http://claude-token-service:8080/token

# Response:
{
  "access_token": "sk-ant-...",
  "expires_at": 1234567890,
  "expires_in": 3540
}
```

## API Endpoints

### GET /token

Returns a valid access token, refreshing if necessary. **Requires authentication** if `AUTH_TOKEN` is set.

**Headers:**
```
Authorization: Bearer <AUTH_TOKEN>
```

**Response:**
```json
{
  "access_token": "sk-ant-...",
  "expires_at": 1774404450,
  "expires_in": 3540
}
```

### GET /health

Health check endpoint. **No authentication required.**

**Response:** `200 OK`

### GET /status

Service status with token information. **Requires authentication** if `AUTH_TOKEN` is set.

**Response:**
```json
{
  "has_access_token": true,
  "healthy": true,
  "expires_at": 1774404450,
  "expires_in": 3540
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_REFRESH_TOKEN` | OAuth refresh token from `/connect:claude` | (required) |
| `AUTH_TOKEN` | Bearer token to protect `/token` and `/status` endpoints | (none - unprotected) |
| `CREDENTIALS_FILE` | Path to persist credentials | `/data/credentials.json` |
| `PORT` | HTTP server port | `8080` |

## Security

**Important:** Set `AUTH_TOKEN` to protect the `/token` endpoint. Without it, anyone on the network can obtain access tokens for your Claude subscription.

```bash
# Generate a secure random token
openssl rand -hex 32
```

## Integration with Codebuff Lite

To use this service with Codebuff Lite containers, set the access token via environment variable:

```bash
# Fetch token from service
TOKEN=$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" \
  http://claude-token-service:8080/token | jq -r '.access_token')

# Run Codebuff Lite with the token
docker run -e CODEBUFF_CLAUDE_OAUTH_TOKEN="$TOKEN" codebuff-lite "your prompt"
```

Or integrate token fetching into your container startup script.

## Token Lifecycle

1. **Startup**: Service loads refresh token from env var or credentials file
2. **First request**: Exchanges refresh token for access token (~1 hour validity)
3. **Token rotation**: If Anthropic returns a new refresh token, it's stored
4. **Background refresh**: Proactively refreshes 5 minutes before expiry
5. **On-demand refresh**: Any `/token` request triggers refresh if needed
6. **Persistence**: Credentials saved to file for restart resilience
7. **Graceful shutdown**: Handles SIGTERM/SIGINT for clean container lifecycle

## Important Notes

1. **Single replica only**: Run exactly ONE instance of this service. Multiple instances would cause refresh token conflicts.

2. **Persistent storage**: Use a volume to persist `/data/credentials.json`. This stores the rotated refresh token.

3. **Token caching**: Containers should cache the access token and only request a new one when it's about to expire (check `expires_in`).

4. **Security**: Set `AUTH_TOKEN` to protect the `/token` endpoint. The access token grants access to your Claude subscription.

## Troubleshooting

### "No refresh token available"
- Set `CLAUDE_REFRESH_TOKEN` environment variable
- Or mount a credentials file with a valid refresh token

### "token refresh failed (status 401)"
- The refresh token has been invalidated (used by another client)
- Re-run `/connect:claude` to get a new refresh token

### "token refresh failed (status 429)"
- Rate limited by Anthropic
- The service will retry automatically

### "unauthorized" response
- Include `Authorization: Bearer <AUTH_TOKEN>` header in requests
- Verify the token matches what the service was started with

## Building

```bash
# Build binary
go build -o claude-token-service .

# Build Docker image
docker build -t claude-token-service .
```

## License

Same as Codebuff.
