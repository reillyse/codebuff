# Sparrow Telemetry (Honeycomb)

Sparrow ships a Sparrow-only OpenTelemetry tracer that exports to
[Honeycomb](https://honeycomb.io). It's off by default and silently no-ops
unless you've configured an API key.

## Quick Start

```bash
# From inside the CLI:
/telemetry enable hcik_...your_honeycomb_key...

# Or via env var (useful for CI):
export HONEYCOMB_API_KEY=hcik_...your_honeycomb_key...

# Check what's active and where each value came from:
/telemetry status
```

Changes via `/telemetry` take effect immediately — the tracer provider is
flushed and re-initialized in-process. Traces show up in the
`sparrow-codebuff` dataset within ~10 seconds.

## Configuration

### Where config lives

`~/.config/manicode/sparrow-config.json` (or `manicode-dev` / `manicode-test`
when `NEXT_PUBLIC_CB_ENVIRONMENT` is set). Example:

```json
{
  "telemetry": {
    "enabled": true,
    "honeycomb": {
      "apiKey": "hcik_...",
      "dataset": "sparrow-codebuff"
    },
    "capturePrompts": "off",
    "debug": false
  }
}
```

### Resolution precedence

For every field, the highest-precedence source that has a non-empty value
wins:

1. **Explicit arg** to `initTelemetry()` (rarely used — CLI leaves this
   empty so env / file drive config)
2. **Environment variable** (see below) — useful escape hatch for CI
3. **`sparrow-config.json`** on disk — the canonical user-facing setting
4. **Built-in default**

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HONEYCOMB_API_KEY` | — | Activates telemetry when non-empty. Overrides the config file. |
| `HONEYCOMB_DATASET` | `sparrow-codebuff` | Target Honeycomb dataset. |
| `SPARROW_TELEMETRY_CAPTURE_PROMPTS` | _(unset)_ | Set to `full` to attach prompt/message content as span events. Any other value (or unset) keeps capture off. |
| `DEBUG` (containing `sparrow:telemetry`) | _(unset)_ | Print exporter-level warnings to stderr. |

### `/telemetry` commands

| Command | Effect |
|---|---|
| `/telemetry` | Show resolved config + source for each value |
| `/telemetry status` | Same as above |
| `/telemetry enable [api-key]` | Set `enabled: true`, optionally set apiKey |
| `/telemetry disable` | Set `enabled: false` (keeps apiKey on disk) |
| `/telemetry dataset <name>` | Override dataset |
| `/telemetry capture-prompts on\|off` | Toggle prompt capture (privacy opt-in) |
| `/telemetry debug on\|off` | Toggle exporter debug logs |
| `/telemetry flush` | Push any pending spans to Honeycomb now (does not shut down the provider) |
| `/telemetry help` | Print usage |

All `/telemetry` subcommands that mutate config (`enable`, `disable`,
`dataset`, `capture-prompts`, `debug`) apply **immediately** by calling
`reinitTelemetry()` in-process: the existing provider is flushed + shut
down, then a new one is started from the updated config. No CLI restart
required. Env-var changes still require a restart (env is read at process
start).

## What gets traced

Every user prompt becomes a `prompt` root span that contains:

- `agent.run` spans (one per top-level agent invocation), which contain
  - `agent.step` spans (one per model-request round-trip), which contain
    - `gen_ai.chat` spans (one per LLM call, with `route_attempt_*` events
      on fallback)
    - `tool.call` spans (one per tool invocation, with `child_agent_id`
      linking into spawned agent runs)

Span attributes include model name, route (`codebuff_backend` / `direct_*`
/ `claude_oauth` / `chatgpt_oauth`), token counts, cost (USD + credits),
finish reason, and tool success/failure. See
`common/src/sparrow/telemetry/attributes.ts` for the full schema.

## Privacy

Default is **no content**. The tracer does not capture prompt/message
content, tool arguments, or tool output bodies. It does capture:

- model names (e.g. `anthropic/claude-opus-4`)
- route classifications
- token and byte counts
- span durations
- tool names + success/failure
- your cwd + git worktree path
- the current Linear issue key parsed from the branch/commit (if any)

To capture message content as span events (useful for local debugging,
**not** recommended for shared Honeycomb environments), opt in:

```bash
/telemetry capture-prompts on
# or
export SPARROW_TELEMETRY_CAPTURE_PROMPTS=full
```

## When spans are flushed to Honeycomb

The tracer uses OTel's `BatchSpanProcessor` — spans don't ship one-at-a-time
they sit in an in-process queue and get shipped when **any** of these happen:

1. **End of every top-level turn** — when the root `prompt` span closes,
   `withPromptSpan` fires a non-blocking `forceFlush()`. This is the common
   case: spans reach Honeycomb within ~1–2 seconds of the CLI finishing a
   response. The flush is fire-and-forget so it adds zero latency to the
   turn result, and errors are swallowed.
2. **5-second batch timer** — safety net for anything that accumulates
   outside a prompt span (e.g. long-running background operations).
3. **Batch size reached** (512 spans) — for bursty workloads.
4. **CLI exit** — the shutdown hook in `renderer-cleanup.ts` calls
   `shutdownTelemetry()` which flushes then shuts down the provider.
5. **Config changes** — `/telemetry enable|disable|dataset|capture-prompts`
   all flush before reinit so config edits never lose spans.

Manual `/telemetry flush` is rarely needed in normal use — the turn-end
auto-flush covers it. It's still useful for impatient debugging or when
you've just written something outside a prompt span.

## Failure modes

- **Honeycomb endpoint down / network broken:** the batched exporter
  retries internally and drops overflowing spans silently. At most one
  warning is logged per process when `DEBUG=sparrow:telemetry` or
  `telemetry.debug: true`.
- **Missing API key:** `initTelemetry()` is a silent no-op. No spans
  created, no network activity, no stdout/stderr output.
- **Corrupt `sparrow-config.json`:** treated as missing. No error thrown;
  telemetry falls back to env vars and defaults.
- **Unexpected exceptions anywhere in the tracer:** callers never observe
  them. CLI startup wraps `initTelemetry` in a try/catch as a final safety
  net.

## Module layout

- `common/src/sparrow/config/sparrow-config.ts` — load/save/resolve the
  shared Sparrow config file (not telemetry-specific — the `/telemetry`
  command happens to be the first consumer).
- `common/src/sparrow/telemetry/tracer-provider.ts` — OTel tracer setup.
- `common/src/sparrow/telemetry/span-helpers.ts` — ergonomic
  `withPromptSpan` / `withAgentRunSpan` / `recordLlmCall` / `recordToolCall`
  wrappers.
- `common/src/sparrow/telemetry/attributes.ts` — attribute + event + span
  name constants.
- `common/src/sparrow/telemetry/context-harvester.ts` — git/Linear context
  cache primed at startup.
- `cli/src/commands/telemetry.ts` — `/telemetry` command handlers.
