## Why

We have no way to answer "how much did we spend — in time, tokens, or dollars — working on feature X with Sparrow Codebuff?" Every LLM call, every agent step, every tool invocation happens in the dark. We need project-level and session-level telemetry so we can aggregate by repo, worktree, commit, branch, and (opportunistically) Linear issue, and slice by route (Claude OAuth vs ChatGPT OAuth vs Codebuff backend vs direct provider) to understand cost and routing behavior in real time.

## What Changes

- **NEW**: Introduce Sparrow-only OpenTelemetry instrumentation that emits to Honeycomb. Zero manual configuration beyond `HONEYCOMB_API_KEY`; missing key is a silent no-op.
- **NEW**: Auto-harvest git/project/session context (repo, branch, commit, worktree, dirty flag, Linear issue extracted from branch/commit) and attach as span attributes on every trace. Re-resolved per prompt with a short TTL.
- **NEW**: Span hierarchy `prompt → agent.run → agent.step → (gen_ai.chat | tool.call)`. Sub-agent `agent.run` nests under the parent `agent.step`. LLM and tool spans are siblings — not nested — to keep model latency clean.
- **NEW**: Record on `gen_ai.chat` spans: model requested, model actually served, route, input/output/cache-read/cache-creation tokens, finish reason, `codebuff.cost.credits`, `codebuff.cost.usd`, OAuth fallback attempts as span events.
- **NEW**: Record on `tool.call` spans: tool name, success, duration, byte sizes (never content).
- **NEW**: Running cost totals (`codebuff.cost.usd`, `codebuff.cost.credits`, token counts) rolled up to each ancestor span so Honeycomb queries can `GROUP BY git.repo, linear.issue` and sum.
- **NEW**: Privacy defaults — counts, IDs, routes, git metadata always captured; prompt/message content never captured unless a Sparrow-only env flag opts in.
- **NEW**: Sparrow-isolated code location (`common/src/sparrow/telemetry/`, `// SPARROW:` markers) so upstream merges stay clean.
- Files modified: `sdk/src/impl/llm.ts` (instrument LLM dispatch), `packages/agent-runtime/src/run-agent-step.ts` + `main-prompt.ts` (instrument agent step/run), `cli/src/index.tsx` (init + shutdown).
- **Does NOT**: replace PostHog, touch the web/server, require user commands, alter billing behavior, or affect freebuff/upstream Codebuff.

## Capabilities

### New Capabilities
- `sparrow-telemetry`: OpenTelemetry tracer provider, Honeycomb OTLP/HTTP exporter, auto-context harvester, and instrumentation shims at every LLM-call / agent-step / tool-call site. Exposes a small internal API (`withSpan`, `recordLlmCall`, `recordToolCall`) consumed by existing Sparrow code paths. Silent no-op when disabled.

### Modified Capabilities
- None. This is additive-only and Sparrow-scoped; no existing specs require modification.

## Impact

- **Code**: New module at `common/src/sparrow/telemetry/` (tracer, exporter, context harvester, span helpers, cost calculator adapter). Thin instrumentation edits in three hot-path files — guarded to be zero-cost when telemetry is disabled.
- **Dependencies**: +3 npm packages (`@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`). Total footprint ~200 KB. No `@opentelemetry/sdk-node` (avoids Bun-incompat auto-instrumentation).
- **Config**: `HONEYCOMB_API_KEY` (required to activate), `HONEYCOMB_DATASET` (optional, defaults to `sparrow-codebuff`), `SPARROW_TELEMETRY_CAPTURE_PROMPTS=full` (optional, dev-only).
- **Performance**: Batched span export (hard-coded 5s / 512-span queue), off the hot path. Expected overhead: <1 ms per LLM call on the issuing process, zero network work on the client request path (exporter flushes asynchronously, with best-effort flush on CLI exit).
- **Runtime**: CLI (Bun) and SDK-as-library callers. Server side (`web/`) explicitly out of scope for v1.
- **Observability surface**: New Honeycomb dataset `sparrow-codebuff` with span attributes documented in `specs/sparrow-telemetry/spec.md`.
- **Risk**: Git-context shell-outs (cached, 5s TTL) add minimal overhead. Error in the exporter must never crash the CLI — all telemetry code wrapped to swallow failures.
