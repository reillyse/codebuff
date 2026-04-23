## 1. Dependencies & Configuration

- [x] 1.1 Add `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` to the appropriate `package.json` (likely `common/`) via `bun add`, not by hand-editing versions
- [x] 1.2 Document `HONEYCOMB_API_KEY`, `HONEYCOMB_DATASET`, `SPARROW_TELEMETRY_CAPTURE_PROMPTS` in `docs/environment-variables.md`
- [x] 1.3 Add an entry to `SPARROW_CHANGES.md` noting the new Sparrow telemetry module and its touch points for future upstream-merge audits

## 2. Telemetry Core Module (`common/src/sparrow/telemetry/`)

- [x] 2.1 Create `index.ts` exporting the public API: `initTelemetry`, `shutdownTelemetry`, `withSpan`, `recordLlmCall`, `recordToolCall`, `withPromptSpan`, `withAgentRunSpan`, `withAgentStepSpan` (also exports `flushTelemetry`, `Attr`, `Events`, `SpanNames`, `classifyLlmRoute`, `shouldCapturePrompts`)
- [x] 2.2 Create `tracer-provider.ts` that builds a `BasicTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter` pointed at Honeycomb; guards on `HONEYCOMB_API_KEY`; silent no-op when absent
- [x] 2.3 Create `context-harvester.ts` with 5 s TTL cache, running `git remote get-url origin`, `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, `git rev-parse --show-toplevel`, `git status --porcelain`; normalize remote URL to `host/org/repo`, strip credentials and `.git` suffix
- [x] 2.4 Add Linear-issue extraction: regex `/([A-Z]{2,}-\d+)/` against branch name first, then against `git log -1 --pretty=%s`
- [x] 2.5 Create `span-helpers.ts` with `withSpan` (async function wrapper, error-safe) and typed span-ending helpers for each span type
- [x] 2.6 Create `cost-rollup.ts` that walks the active span stack on `gen_ai.chat` span end and adds `codebuff.cost.usd` / `codebuff.cost.credits` / token counters to every ancestor's running total — writes attributes at span end, not during execution
- [x] 2.7 Create `attributes.ts` with typed constants for all attribute keys (`codebuff.route`, `gen_ai.*`, `git.*`, `linear.issue`, …) to prevent typos
- [x] 2.8 Wrap every public entry point in try/catch so telemetry failures never propagate
- [x] 2.9 Add a `DEBUG=sparrow:telemetry` diagnostic path that logs exporter errors at most once per session

## 3. Instrumentation — CLI Lifecycle

- [x] 3.1 Call `initTelemetry()` from `cli/src/index.tsx` immediately after env is loaded, before the TUI renders — mark with `// SPARROW:`
- [x] 3.2 Register `process.on('exit')`, `SIGINT`, `SIGTERM` handlers that call `shutdownTelemetry()` with a 2 s force-flush timeout — mark with `// SPARROW:` (wired via `installProcessCleanupHandlers({ beforeExitHook })` with a 2.5 s hard timeout; hook runs `flushTelemetry(1500)` then `shutdownTelemetry()`)
- [x] 3.3 Ensure no user-facing console output from init/shutdown (unless `DEBUG=sparrow:telemetry`)
- [x] 3.4 Add `/telemetry status|init|shutdown|flush` CLI commands for runtime inspection and manual flush (added beyond original scope)

## 4. Instrumentation — Prompt / Agent Run / Agent Step

- [x] 4.1 In `packages/agent-runtime/src/main-prompt.ts`, wrap the top-level prompt execution in `withPromptSpan(...)` so every user turn produces one root span; attach harvested context — mark with `// SPARROW:`
- [x] 4.2 In `packages/agent-runtime/src/run-agent-step.ts`, wrap each `runAgentStep` invocation in `withAgentStepSpan(...)` carrying `codebuff.step_number`, `codebuff.agent_id`, `codebuff.agent_display_id` — mark with `// SPARROW:`
- [x] 4.3 In the agent-run entry point (the function that orchestrates steps for a single agent), wrap with `withAgentRunSpan(...)` carrying `codebuff.agent_id` and `codebuff.parent_agent_id` if present — mark with `// SPARROW:`
- [x] 4.4 Confirm sub-agent spawns nest `agent.run` spans under the parent's active `agent.step` via OTel context propagation (implemented in `withSpan` via `trace.setSpan(context.active(), span)` + `context.with(ctx, fn)` — real `parent_span_id` tree nesting; covered by `coverage-gaps.test.ts` → `'sub-agent spawn nests agent.run under parent agent.step'`. Separately, `spawn_agents` tool.call spans also record `child.agent_id` attribute linkage for query convenience.)

## 5. Instrumentation — LLM Calls

- [x] 5.1 In `sdk/src/impl/llm.ts`, wrap the LLM dispatch in a `gen_ai.chat` span created with `recordLlmCall(...)`; span is sibling to tool calls within the agent step — mark with `// SPARROW:`
- [x] 5.2 Populate `gen_ai.request.model`, `gen_ai.system`, `codebuff.route`, `codebuff.route_attempt` before the network call
- [x] 5.3 In `onCostCalculated`, populate `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `codebuff.cost.credits`, `codebuff.cost.usd`, `codebuff.tool_calls_emitted`, `gen_ai.response.finish_reason`
- [x] 5.4 Fix the pre-existing `if (costOverrideDollars)` zero-cost bug (or explicitly leave it as-is with a comment linking to this change) — decide once during implementation
- [x] 5.5 For OAuth fallback: record each attempt as a span event (`route_attempt_failed` or `route_attempt_succeeded`) with its own route/model attributes; final span attributes reflect the succeeding attempt only
- [x] 5.6 Trigger cost rollup to ancestor spans at span end (see 2.6)

## 6. Instrumentation — Tool Calls

- [x] 6.1 Identify the single tool dispatch site in `packages/agent-runtime/` and wrap with `recordToolCall(...)` producing a `tool.call` span sibling to `gen_ai.chat` — mark with `// SPARROW:` (in `packages/agent-runtime/src/tools/tool-executor.ts`; re-integrated onto upstream's atomic-pair `{toolUse, toolResult}` contract — commit `3d59dc997`)
- [x] 6.2 Record `tool.name`, `tool.success`, `tool.duration_ms`, `tool.bytes_in` (from JSON.stringify(args).length), `tool.bytes_out` (from JSON.stringify(result).length)
- [x] 6.3 Set span status to `ERROR` on thrown/rejected tool calls with error class name as description; never leak error message text by default
- [x] 6.4 Special case `spawn_agent`: also record `child.agent_id` attribute on the `tool.call` span (via `sparrowChildAgentIdsFromSpawn` helper; records `spawn_agents`' full list of child agent_types)

## 7. Privacy & Opt-in Content Capture

- [x] 7.1 Ensure default configuration records zero content — audit all `setAttribute` calls for accidental message/prompt/path leakage
- [x] 7.2 When `SPARROW_TELEMETRY_CAPTURE_PROMPTS=full`, emit a `prompt.messages` span event on `gen_ai.chat` containing the serialized message history
- [x] 7.3 Normalize git remote URLs to strip credentials before recording (`https://x-access-token:TOKEN@…` → `host/org/repo`)

## 8. Tests

- [x] 8.1 Unit test `context-harvester.ts`: caching, normalization, Linear extraction from branch and from commit subject, behavior outside a git repo, credential stripping
- [x] 8.2 Unit test `tracer-provider.ts`: no-op when `HONEYCOMB_API_KEY` absent; initialization when present; headers include `x-honeycomb-team` and dataset (also covers `flushTelemetry` fast-path, timeout, error, and inactive branches)
- [x] 8.3 Unit test `cost-rollup.ts`: two LLM calls in one step aggregate correctly on the step; rollups reach the root `prompt` span
- [x] 8.4 Integration test using an in-memory `InMemorySpanExporter`: one-prompt-one-agent-one-step-one-llm-one-tool scenario produces the expected span hierarchy with expected attributes
- [x] 8.5 Integration test: OAuth fallback produces exactly one `gen_ai.chat` span with two attempt events and final attributes matching the successful attempt
- [x] 8.6 Integration test: sub-agent spawn nests `agent.run` under parent's active `agent.step`
- [x] 8.7 Integration test: telemetry entry points called with uninitialized tracer are no-ops and return without throwing
- [x] 8.8 Integration test: privacy default — assert no span attribute contains prompt/message content with `SPARROW_TELEMETRY_CAPTURE_PROMPTS` unset

## 9. Manual Verification

- [ ] 9.1 Run the CLI locally with `HONEYCOMB_API_KEY` set, execute a multi-agent prompt, confirm trace appears in Honeycomb within ~10 s
- [ ] 9.2 Confirm `git.repo`, `git.branch`, `git.commit`, `git.worktree`, `linear.issue` populate correctly on a worktree with an issue-prefixed branch
- [ ] 9.3 Confirm `codebuff.cost.usd` on the `prompt` root equals the sum of `codebuff.cost.usd` across its `gen_ai.chat` descendants (within float tolerance)
- [ ] 9.4 Confirm a Honeycomb query `GROUP BY linear.issue SUM(codebuff.cost.usd)` returns per-issue spend
- [ ] 9.5 Confirm CLI behaves identically with `HONEYCOMB_API_KEY` unset (no new output, no errors, no latency regression)
- [ ] 9.6 Confirm flush-on-exit works: run a prompt, exit, confirm last spans appear in Honeycomb

## 10. Type-check & Lint

- [x] 10.1 Run typecheck across affected packages (`common`, `sdk`, `packages/agent-runtime`, `cli`)
- [ ] 10.2 Run lint across affected packages
- [ ] 10.3 Run the existing test suites for any package touched and confirm zero regressions
