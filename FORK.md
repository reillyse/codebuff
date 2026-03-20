# Fork: reillyse/hippo-integration

This fork extends Codebuff with **Hippo memory integration** and **Claude OAuth enabled by default**.

## What's Different

### Claude OAuth (Enabled by Default)

Claude OAuth is **on by default** in this fork — no build-time flag flipping needed. This means `/connect:claude` works out of the box, routing requests directly through your Claude Pro/Max subscription.

To disable: set `CODEBUFF_CLAUDE_OAUTH_ENABLED=false` in your environment.

### K8s / Headless Deployment

For containerized environments where browser-based OAuth isn't possible:

1. **Authenticate once on your laptop:**
   ```bash
   codebuff
   /connect:claude
   ```

2. **Extract the refresh token:**
   ```bash
   cat ~/.config/manicode/credentials.json | jq '.claudeOAuth.refreshToken'
   ```

3. **Set as a K8s Secret:**
   ```yaml
   env:
     - name: CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN
       valueFrom:
         secretKeyRef:
           name: codebuff-claude
           key: refresh-token
   ```

The SDK will auto-refresh expired access tokens using the long-lived refresh token. Credentials are cached in-memory so token refreshes only happen when needed, not on every API call.

**Environment variables:**

| Variable | Purpose |
|---|---|
| `CODEBUFF_CLAUDE_OAUTH_ENABLED` | Feature flag (default: `true` in this fork) |
| `CODEBUFF_CLAUDE_OAUTH_TOKEN` | Access token override (short-lived, auto-populated by `/connect:claude`) |
| `CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN` | Refresh token for K8s/headless (long-lived, enables auto-refresh) |

### Hippo Memory Integration

Hippo provides persistent memory across coding sessions via a Neo4j-backed graph database. When enabled, Codebuff:

- Stores run summaries (input, output, files changed, outcome) after each interaction
- Recalls relevant context from past sessions when processing new queries
- Stores lightweight pruning events when context is pruned mid-session

**Commands:**
- `/hippo:enable` / `/hippo:disable` — toggle hippo memory
- `/hippo:status` — show connection status, binary location, debug logging
- `/hippo:retry` — retry a failed hippo connection
- `/hippo:log:enable` / `/hippo:log:disable` — toggle debug logging

**Status indicator:** The bottom status bar shows a colored dot for hippo:
- 🟢 Green — connected and active
- 🟡 Yellow — disconnected (hover for error details, click [retry])
- 🔵 Blue — retrying connection
- ⚪ Gray — idle / not checked
- 🔴 Red — binary not found

## Building

```bash
./scripts/build-codebuff.sh
```

No manual flag flipping is needed — Claude OAuth is enabled by default in the source.

## Development

```bash
bun up        # start web server
bun start-cli # start CLI (separate terminal)
```
