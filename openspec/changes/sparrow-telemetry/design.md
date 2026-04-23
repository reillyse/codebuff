## Context

Sparrow Codebuff is our in-house fork of the Codebuff CLI. We run it across multiple repos, worktrees, and feature branches and have no way to answer basic cost/engineering-budget questions after the fact: *how much did feature X cost across all the agents that touched it?* Existing analytics (`common/src/analytics.ts` → PostHog) are oriented at product funnels (logins, billing, signups) and cannot answer structured-trace questions. No OpenTelemetry wiring exists yet; greenfield.

The CLI already has every piece of data we need at the point of each LLM call:

- `sdk/src/impl/llm.ts` is the single choke point for *all* model dispatches. It already selects a route (Claude OAuth / ChatGPT OAuth / Codebuff backend / direct provider), receives usage back from providers via a `onCostCalculated` callback, and knows the agent id via `codebuff_metadata`.
- `packages/agent-runtime/src/run-agent-step.ts` and `main-prompt.ts` are the choke points for agent step execution and tool dispatch. They know the agent id, step number, tool name, and parent/child relationships for spawned agents.
- `cli/src/index.tsx` is the CLI process entry point — where init and flush-on-exit must live.

The pain point this solves: **we want to point Honeycomb at a query like `GROUP BY linear.issue SUM(codebuff.cost.usd)` and get a live feature-cost breakdown.** Everything else follows from that.

We are explicitly **not** building this for upstream Codebuff. Sparrow-isolated code, `// SPARROW:` markers, upstream-merge-safe.

## Goals / Non-Goals

**Goals:**
- Zero manual input. The user never runs a `/feature` command or tags anything. Presence of `HONEYCOMB_API_KEY` is the sole activation signal.
- Auto-harvest all available context: git repo/branch/commit/worktree/dirty, cwd, host, user, session id, Linear issue from branch or commit message.
- One `prompt` span per user turn, nested agent runs, nested agent steps, with LLM calls and tool calls as siblings under the step.
- Rich attributes on `gen_ai.chat`: route, model requested vs. served, tokens (input / output / cache-read / cache-create), finish reason, `codebuff.cost.credits`, `codebuff.cost.usd`, latency (span duration).
- Running cost totals rolled up to every ancestor span so `SUM(codebuff.cost.usd)` on the root returns the turn's total.
- Privacy by default — no prompt/message content in spans unless opted in.
- Zero overhead when disabled. Silent no-op on any telemetry failure.
- Stays 100% additive; no refactoring of existing code paths, no touching PostHog, no server-side work.

**Non-Goals:**
- Distributed tracing through the server (`web/`). Deferred until we actually need it.
- Metrics or logs pillars. Spans only.
- Replacing or bridging PostHog. Different job, leave it alone.
- Freebuff or upstream Codebuff support.
- Per-user feature tagging UX. Future extension if `linear.issue` extraction proves insufficient.
- Alerting, dashboards as code, or SLOs. Honeycomb queries are manual.
- Sampling cleverness beyond batch export. Volume is bounded; ship 100%.

## Decisions

### D1 — Honeycomb via OTLP/HTTP, no collector

Direct export to `https://api.honeycomb.io/v1/traces` with the `x-honeycomb-team` header. No intermediate collector. Eliminates operational surface area and a deployment dependency. Re-evaluate only if we need tail sampling or multi-destination.

### D2 — `@opentelemetry/sdk-trace-base`, not `sdk-node`

`sdk-node` pulls auto-instrumentations that assume Node internals and do not all work under Bun. We manually instantiate `BasicTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter`. Dependency surface: 3 packages, ~200 KB. All span context propagation inside the CLI is in-process, so we don't need the full SDK.

### D3 — Sparrow-isolated module at `common/src/sparrow/telemetry/`

New files live under a `sparrow/` folder; every call site adds a one-line import and a one-line wrap with a `// SPARROW:` marker. Matches the existing pattern (`cli/src/sparrow/openspec-commands.ts`). Keeps upstream merges trivial.

### D4 — Silent no-op when `HONEYCOMB_API_KEY` is absent

`withSpan`, `recordLlmCall`, `recordToolCall` all early-return a passthrough when the tracer provider was never activated. No logs, no warnings, no errors. This is critical for contributors without a key.

### D5 — Span hierarchy

```
prompt                       (root; one per user turn)
└── agent.run                (root agent invocation)
    └── agent.step           (one per iteration)
        ├── gen_ai.chat      (every LLM call — sibling to tools)
        ├── tool.call        (every tool dispatch)
        └── agent.run        (sub-agent; nests back into its own .step hierarchy)
```

LLM and tool spans are **siblings, not nested**. Model latency is the duration of `gen_ai.chat` alone; wrapping the tool call inside it would inflate latency by the tool's runtime. This is the bug-hunt pass's most important finding.

### D6 — Attribute schema (minimal, stable)

On **every span** (resource + inherited):
- `service.name` = `sparrow-codebuff`
- `service.version` = CLI package version
- `host.name`, `os.type`, `process.pid`
- `user.email`, `user.name` (from `git config`)

On the **`prompt` root** (auto-harvested, re-resolved per prompt, 5 s TTL cache):
- `cwd`
- `git.repo` (normalized, no credentials)
- `git.branch`
- `git.commit`
- `git.worktree` (`git rev-parse --show-toplevel`)
- `git.dirty` (boolean)
- `linear.issue` (regex `[A-Z]{2,}-\d+` over branch name, fallback to HEAD commit subject)
- `session.id` (reuse existing `clientSessionId`)
- `codebuff.cost.usd` / `codebuff.cost.credits` / token totals (running, updated as children end)

On **`agent.run`**:
- `codebuff.agent_id`, `codebuff.agent_display_id`
- `codebuff.parent_agent_id` when applicable
- Running cost/token totals

On **`agent.step`**:
- `codebuff.step_number`
- Running cost/token totals

On **`gen_ai.chat`** (the money span):
- `gen_ai.system` (`anthropic` | `openai` | `google` | `openrouter` | …)
- `gen_ai.request.model` (what the agent asked for)
- `gen_ai.response.model` (what we actually got)
- `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`
- `gen_ai.response.finish_reason`
- `codebuff.route` = `claude_oauth` | `chatgpt_oauth` | `codebuff_backend` | `direct_<provider>`
- `codebuff.route_attempt` (1 for primary, 2+ for fallback)
- `codebuff.cost.credits` (0 for OAuth routes)
- `codebuff.cost.usd` (computed from tokens × published price even for OAuth, to visualize "savings")
- `codebuff.tool_calls_emitted` (count)

On **`tool.call`**:
- `tool.name`, `tool.success`, `tool.duration_ms`
- `tool.bytes_in`, `tool.bytes_out` (sizes, never content)
- For `spawn_agent`: `child.agent_id`

### D7 — Running cost rollups via finalize-time walk

When a `gen_ai.chat` span ends, we compute its `codebuff.cost.usd` and walk up the active span stack, atomically adding the value to each ancestor's running counter. Counters are written as span attributes **at span end**, so rollups are correct when the span is exported. This avoids the classic race where `onCostCalculated` fires after `span.end()`.

### D8 — OAuth fallback recorded as one span with attempt events

Claude OAuth fallback to Codebuff backend is **one logical `gen_ai.chat` span**. Each attempt is recorded as a span event (`route_attempt_failed`, `route_attempt_succeeded`) with its own route/model attributes. The final span attributes reflect the attempt that actually streamed content. Gives Honeycomb a clean per-request view while preserving the fallback timeline.

### D9 — Git context auto-harvest

A dedicated `ContextHarvester` runs `git` commands via `spawnSync` with a 5-second in-memory TTL cache. Each command: `git remote get-url origin`, `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, `git rev-parse --show-toplevel`, `git status --porcelain | head -n 1`. All commands are wrapped in try/catch; any failure is silently omitted. Remote URLs are normalized (`git@github.com:x/y.git` → `github.com/x/y`, strip creds). Linear issue extraction: `/^[A-Z]{2,}-\d+/` match on branch name first, then on `git log -1 --pretty=%s`.

### D10 — Privacy

Default: no prompt/message content, no tool-argument content, no file paths beyond `cwd` and `git.worktree`. `tool.bytes_in/out` are byte counts, not payloads. `SPARROW_TELEMETRY_CAPTURE_PROMPTS=full` (dev-only, undocumented outside the spec) enables message content as span events with a `prompt.messages` attribute. Never default true.

### D11 — Flush on exit

`cli/src/index.tsx` registers `process.on('exit')`, `SIGINT`, and `SIGTERM` handlers that call `tracerProvider.forceFlush()` with a 2-second timeout. We cannot block CLI shutdown indefinitely; better to lose a tail span than hang the terminal.

### D12 — Error isolation

Every telemetry entry point is a try/catch. The exporter is wrapped so a network failure writes at most one debug log (gated behind `DEBUG=sparrow:telemetry`) and is swallowed. Telemetry MUST NOT throw into user code under any circumstances.

## Risks / Trade-offs

- **Git shell-outs on the hot path**: Mitigated by 5 s TTL cache. First prompt in a session pays ~15–30 ms for five sequential `git` calls (can be parallelized if measured as problematic).
- **Cost attribution accuracy for OAuth**: `codebuff.cost.usd` is a *modeled* cost for OAuth routes using published provider prices — not a billed amount. Documented clearly in spec. The "how much did we save by using OAuth?" question is answerable only against this modeled cost.
- **Route attribute drift**: If new routes are added in upstream Codebuff, our `codebuff.route` enum will silently default to `direct_<provider>`. Acceptable; rename in a follow-up.
- **Bun compatibility**: `@opentelemetry/sdk-trace-base` is pure TS/JS with no Node-specific deps. Exporter uses `fetch`. Verified to work under Bun in similar projects.
- **Batch loss on hard crash**: `BatchSpanProcessor` can lose up to 5 s / 512 spans on hard-kill. Acceptable given additive usage and flush-on-exit hook for clean shutdowns.
- **Honeycomb cost**: Each span is one event. A busy session is maybe ~100–500 spans. Multiple sessions a day across a small team stays well inside Honeycomb free/pro tier.
- **Future distributed tracing**: If/when we want server-side spans, W3C `traceparent` injection in `getProviderOptions()` is a one-line add; we're leaving the code shape amenable.
- **Drift vs. GenAI semantic conventions**: OTel's `gen_ai.*` semconv is still experimental. We pin to the minimal stable subset (model, tokens, finish_reason) and carry our own `codebuff.*` namespace for everything else so semconv evolution doesn't force schema migrations in Honeycomb.
