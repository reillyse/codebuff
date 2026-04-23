## ADDED Requirements

### Requirement: Telemetry Activation
The system SHALL activate OpenTelemetry export to Honeycomb if and only if the `HONEYCOMB_API_KEY` environment variable is set and non-empty at CLI startup. When the key is absent, all telemetry entry points MUST behave as silent no-ops — no initialization, no logs, no warnings, no network activity.

#### Scenario: API key present
- **WHEN** the CLI starts with `HONEYCOMB_API_KEY=hcik_...` in the environment
- **THEN** a `BasicTracerProvider` is registered with a `BatchSpanProcessor` and an `OTLPTraceExporter` targeting `https://api.honeycomb.io/v1/traces` with header `x-honeycomb-team: <key>` and `x-honeycomb-dataset: sparrow-codebuff` (or the value of `HONEYCOMB_DATASET` if set)

#### Scenario: API key absent
- **WHEN** the CLI starts without `HONEYCOMB_API_KEY`
- **THEN** no tracer provider is registered, `withSpan`/`recordLlmCall`/`recordToolCall` are passthrough no-ops, and no log line is emitted

#### Scenario: Exporter failure
- **WHEN** the OTLP exporter returns a non-2xx response or the network call rejects
- **THEN** the failure is swallowed, the CLI continues normally, and at most one debug line is written when `DEBUG=sparrow:telemetry` is set

### Requirement: Span Hierarchy
The system SHALL produce exactly one `prompt` root span per user turn, with nested `agent.run` and `agent.step` descendants. LLM dispatches MUST emit a `gen_ai.chat` span and tool invocations MUST emit a `tool.call` span; both MUST be siblings under the owning `agent.step` — never nested inside each other.

#### Scenario: Single-agent single-step turn
- **WHEN** a user sends a prompt that runs one agent performing one step with one LLM call and one tool call
- **THEN** Honeycomb receives a trace with one `prompt` span, one `agent.run` child, one `agent.step` grandchild, and two great-grandchild siblings: `gen_ai.chat` and `tool.call`

#### Scenario: Sub-agent spawn
- **WHEN** a parent agent invokes `spawn_agent` to start a sub-agent
- **THEN** a new `agent.run` span is created under the parent's current `agent.step`, with attribute `codebuff.parent_agent_id` set to the parent agent's id, and the sub-agent's own `agent.step`/`gen_ai.chat`/`tool.call` spans nest beneath it

#### Scenario: LLM and tool latency isolation
- **WHEN** an LLM response contains a tool call that takes 3 s to execute
- **THEN** the `gen_ai.chat` span duration reflects only the model streaming time and the `tool.call` span is a sibling whose duration reflects only the tool execution time — the two do not overlap parent-child

### Requirement: Auto-Harvested Context Attributes
The `prompt` root span MUST carry auto-harvested project and session context attributes without any user action. Values are sourced via `git` shell-outs and process introspection, cached for 5 s, and re-resolved on each new prompt. Any value that cannot be resolved MUST be silently omitted (not set to empty or null).

#### Scenario: Inside a git worktree
- **WHEN** the CLI is invoked from `/path/to/feature-worktree` with HEAD at `abc123` on branch `sparrow/FOO-42-add-thing`
- **THEN** the `prompt` span carries `git.repo` (normalized), `git.branch=sparrow/FOO-42-add-thing`, `git.commit=abc123…`, `git.worktree=/path/to/feature-worktree`, `git.dirty` (boolean), `cwd`, `host.name`, `user.email`, `user.name`, `session.id`, and `linear.issue=FOO-42`

#### Scenario: Linear issue in commit message
- **WHEN** the current branch name contains no Linear issue but the HEAD commit subject starts with `BAR-17: fix thing`
- **THEN** `linear.issue=BAR-17` is recorded on the `prompt` span

#### Scenario: Not inside a git repo
- **WHEN** the CLI is invoked from a directory that is not inside any git repository
- **THEN** `cwd`, `host.name`, `user.email`, `user.name`, `session.id` are still recorded; all `git.*` and `linear.*` attributes are omitted; the CLI runs normally

#### Scenario: Remote URL contains credentials
- **WHEN** `git remote get-url origin` returns `https://x-access-token:ghp_abc@github.com/sparrow-io/x.git`
- **THEN** the `git.repo` attribute records `github.com/sparrow-io/x` with no credentials and no `.git` suffix

### Requirement: LLM Call Attributes
Every `gen_ai.chat` span MUST record the model requested, the model served, token usage, finish reason, route classification, computed USD cost, and consumed Codebuff credits. Route values MUST come from the fixed enumeration `claude_oauth`, `chatgpt_oauth`, `codebuff_backend`, or `direct_<provider>`.

#### Scenario: Direct provider call
- **WHEN** the SDK dispatches a completion to OpenRouter via the `codebuff_backend` route and the backend returns usage `{input: 1200, output: 340, cache_read: 800, cache_creation: 0}` with finish reason `stop` and a computed cost of 12.5 credits
- **THEN** the `gen_ai.chat` span carries `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens=1200`, `output_tokens=340`, `cache_read_tokens=800`, `cache_creation_tokens=0`, `gen_ai.response.finish_reason=stop`, `codebuff.route=codebuff_backend`, `codebuff.cost.credits=12.5`, and `codebuff.cost.usd` computed from the published price

#### Scenario: Claude OAuth route
- **WHEN** the SDK dispatches a completion via `claude_oauth`
- **THEN** `codebuff.route=claude_oauth`, `codebuff.cost.credits=0`, and `codebuff.cost.usd` is still populated using the published Anthropic price so that modeled savings are visible in Honeycomb

#### Scenario: OAuth fallback
- **WHEN** a `claude_oauth` attempt returns 429 and the SDK retries via `codebuff_backend` succeeding on the second attempt
- **THEN** exactly one `gen_ai.chat` span is emitted containing two span events `route_attempt_failed` (attempt 1, `claude_oauth`) and `route_attempt_succeeded` (attempt 2, `codebuff_backend`); the span's final `codebuff.route` attribute equals `codebuff_backend`, `codebuff.route_attempt=2`, and usage/cost attributes reflect the successful attempt only

### Requirement: Tool Call Attributes
Every `tool.call` span MUST record the tool name, success flag, duration, and byte sizes of the tool's serialized input and output. Tool argument and return payload content MUST NOT be recorded by default.

#### Scenario: Successful tool call
- **WHEN** a tool `read_files` completes successfully in 42 ms with a 1.2 KB input payload and an 8.4 KB output payload
- **THEN** the `tool.call` span carries `tool.name=read_files`, `tool.success=true`, `tool.duration_ms≈42`, `tool.bytes_in=1228`, `tool.bytes_out=8601` — and no attribute containing the serialized argument object or file contents

#### Scenario: Failed tool call
- **WHEN** a tool throws or returns an error envelope
- **THEN** `tool.success=false` and the span's OTel status is set to `ERROR` with the error class name as description; error message text MUST NOT be recorded unless explicitly enabled

#### Scenario: spawn_agent tool
- **WHEN** the `spawn_agent` tool is invoked to start agent id `sub-1234` of type `file-picker`
- **THEN** the `tool.call` span carries `tool.name=spawn_agent` and `child.agent_id=sub-1234`, and a separate `agent.run` span is created as a descendant of the current `agent.step`

### Requirement: Running Cost Rollups
Cost and token running totals MUST be propagated from each `gen_ai.chat` span to every ancestor span (`agent.step`, `agent.run`, `prompt`) at the moment the LLM span ends, such that the final emitted attribute values reflect the sum of all contained LLM calls when the ancestor span is exported.

#### Scenario: Two LLM calls in one step
- **WHEN** an `agent.step` contains two `gen_ai.chat` children with USD costs 0.02 and 0.03
- **THEN** the exported `agent.step` span carries `codebuff.cost.usd=0.05` (within float tolerance) and `codebuff.cost.credits` equal to the sum of both children's credits

#### Scenario: Full turn rollup
- **WHEN** a `prompt` turn invokes three agents with a combined six LLM calls totaling $0.47 and 230 credits
- **THEN** the exported `prompt` span carries `codebuff.cost.usd≈0.47`, `codebuff.cost.credits≈230`, and aggregated token counters covering all six calls

### Requirement: Privacy Defaults
By default, no prompt or message content, no tool argument payloads, and no file paths beyond `cwd` and `git.worktree` may be included in any span attribute or event. Opt-in content capture MUST be gated behind a named environment variable.

#### Scenario: Default run
- **WHEN** the CLI runs with telemetry enabled and `SPARROW_TELEMETRY_CAPTURE_PROMPTS` unset
- **THEN** no span attribute or event contains user prompt text, assistant output text, tool argument JSON, or file contents

#### Scenario: Explicit opt-in
- **WHEN** the environment variable `SPARROW_TELEMETRY_CAPTURE_PROMPTS=full` is set
- **THEN** `gen_ai.chat` spans MAY record a `prompt.messages` span event containing the serialized message history

### Requirement: Graceful Shutdown
The CLI MUST flush pending spans on normal exit, `SIGINT`, and `SIGTERM` with a bounded timeout no longer than 2 seconds; an in-progress flush MUST NOT delay shutdown beyond that bound.

#### Scenario: Clean exit
- **WHEN** the user exits the CLI normally
- **THEN** `tracerProvider.forceFlush()` is invoked with a 2 s timeout and the process exits after flush completion or timeout, whichever comes first

#### Scenario: SIGINT during flush
- **WHEN** the user presses Ctrl-C while a flush is in progress
- **THEN** the CLI waits at most 2 s for the flush to complete and then exits, even if the export is still pending

### Requirement: Error Isolation
No code path in the telemetry module may raise an exception into user code. All public entry points MUST wrap their implementation in try/catch and swallow errors.

#### Scenario: Tracer not initialized
- **WHEN** a code path calls `recordLlmCall` before telemetry initialization has completed
- **THEN** the call returns synchronously with no thrown error and no span is created

#### Scenario: Attribute serialization failure
- **WHEN** an attribute value fails to serialize (e.g., circular reference)
- **THEN** the offending attribute is dropped, the remaining attributes are recorded, and the span still exports
