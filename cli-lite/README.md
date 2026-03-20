# Codebuff Lite

A TUI-free, lightweight CLI for Codebuff powered by the SDK. No React, no terminal UI framework — just stdin/stdout.

## Usage

### Interactive REPL

```bash
# Start an interactive session
bun run --cwd cli-lite src/index.ts

# Or from the repo root
bun dev:lite
```

### Single-shot mode

```bash
# Run a single prompt and exit
bun run --cwd cli-lite src/index.ts "explain what this project does"
```

### Options

```
-a, --agent <id>     Agent to use (default: codebuff/base2@latest)
-c, --cwd <dir>      Working directory (default: current directory)
-v, --verbose        Show tool calls and subagent activity
-k, --api-key <key>  Codebuff API key (or set CODEBUFF_API_KEY env var)
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `/new`, `/clear` | Start a new conversation |
| `/help` | Show help |
| `/exit`, `/quit` | Exit |

## Architecture

- **No TUI dependencies** — No React, OpenTUI, yoga-layout, or terminal UI frameworks
- **SDK-powered** — Uses `@codebuff/sdk` CodebuffClient directly
- **Streaming output** — Agent responses stream to stdout in real-time
- **Tool visibility** — Tool calls and subagent activity shown on stderr (with `--verbose`)
- **Multi-turn** — Supports continuing conversations in REPL mode
- **Pipe-friendly** — stdout has only agent output; all UI chrome goes to stderr
- **Cancellable** — Ctrl+C aborts the running request gracefully

## Requirements

- Bun runtime
- `CODEBUFF_API_KEY` environment variable (get one at https://codebuff.com/api-keys)
