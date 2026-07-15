/**
 * Module-level stream-activity heartbeat.
 *
 * The SDK stream handlers call {@link markStreamActivity} whenever any chunk
 * (text/reasoning/tool) arrives, and {@link resetStreamActivity} when a run
 * starts or ends. The status bar reads {@link getLastStreamActivityAt} on its
 * render timer to decide whether to show a "stalled..." indicator (see
 * status-indicator-state.ts).
 *
 * This is intentionally a simple module singleton rather than React state:
 * chunk arrival is high-frequency and originates deep in the SDK event
 * handlers, so routing every chunk through a setState would cause excessive
 * re-renders. The status bar already re-renders on a 1s timer while active, so
 * polling this value there is sufficient and cheap.
 */

let lastStreamActivityAt: number | null = null

/**
 * Active retry-attempt state, set while the agent-runtime retry ladder is
 * backing off before the next attempt. The status bar reads this (via
 * {@link getRetryActivity}) to show an honest "retrying (attempt N/M)"
 * indicator during the backoff sleep instead of a misleading "stalled Ns".
 *
 * - `attempt`/`total`: 1-based attempt counter parsed from the retry notice.
 * - `until`: wall-clock ms when the backoff window ends (now + delaySec). After
 *   this, the indicator falls back to the normal waiting/streaming/stalled
 *   states, so a genuinely hung *next* attempt still surfaces as stalled.
 */
export type RetryActivity = {
  attempt: number
  total: number
  until: number
}

let retryActivity: RetryActivity | null = null

/**
 * Details of a tool call that is currently executing (between its `tool_call`
 * and `tool_result` events).
 */
export type InFlightToolInfo = {
  toolCallId: string
  toolName: string
  /** Wall-clock ms when the tool started executing. */
  startedAt: number
}

/**
 * Tool calls that are currently executing (between their `tool_call` and
 * `tool_result` events). A local tool (e.g. a terminal command running tests)
 * produces no stream chunks while it runs, so without this the chunk-based
 * heartbeat would go silent and the status bar would wrongly show
 * "waiting on provider (stalled Ns)" — even though the CLI is legitimately busy
 * running a local tool, not waiting on the provider. While any tool is in
 * flight, the 'stalled' indicator is suppressed (see status-indicator-state.ts).
 *
 * We also surface these (name + start time) so the UI can show an expandable
 * "tools running" box detailing long-running tools (see in-flight-tools-box.tsx).
 *
 * Keyed by toolCallId (not a counter) so it's idempotent and balances naturally
 * for spawn_agents (one tool_call id + one tool_result with the same id). The
 * map is cleared on every run boundary via {@link resetStreamActivity}, so a
 * result-less control tool (e.g. end_turn) can never permanently suppress the
 * indicator beyond the current run.
 */
const inFlightToolCalls = new Map<string, InFlightToolInfo>()

/** Record that stream activity just occurred (a chunk arrived). */
export const markStreamActivity = (now: number = Date.now()): void => {
  lastStreamActivityAt = now
}

/**
 * Reset the heartbeat. Pass a timestamp (e.g. run start) to arm stall
 * detection, or `null` (run end) to disable it until the next run.
 */
export const resetStreamActivity = (value: number | null = Date.now()): void => {
  lastStreamActivityAt = value
  // In-flight tools never outlive a run boundary (start/end/abort), so a
  // result-less tool_call can't permanently suppress the 'stalled' indicator.
  inFlightToolCalls.clear()
}

/** The timestamp (ms) of the last recorded stream activity, or null. */
export const getLastStreamActivityAt = (): number | null => lastStreamActivityAt

/**
 * Record that a retry attempt is beginning (the retry ladder is backing off).
 * `until` is the wall-clock ms when the backoff window ends.
 */
export const markRetryActivity = (activity: RetryActivity): void => {
  retryActivity = activity
}

/**
 * Clear any active retry state. Called when real (non-notice) content arrives
 * (the attempt recovered) and at run start/end.
 */
export const clearRetryActivity = (): void => {
  retryActivity = null
}

/** The current retry-attempt state, or null when not retrying. */
export const getRetryActivity = (): RetryActivity | null => retryActivity

/**
 * Record that a local tool call started executing (chunk-less work begins).
 * Also re-arms the heartbeat so the moment isn't already "stale".
 */
export const markToolCallStarted = (
  toolCallId: string,
  toolName: string,
  now: number = Date.now(),
): void => {
  inFlightToolCalls.set(toolCallId, { toolCallId, toolName, startedAt: now })
  markStreamActivity(now)
}

/**
 * Record that a local tool call finished. Re-arms the heartbeat so the
 * subsequent provider-wait window starts fresh from ~now instead of counting
 * the tool's execution time toward a "stall".
 */
export const markToolCallFinished = (toolCallId: string): void => {
  inFlightToolCalls.delete(toolCallId)
  markStreamActivity()
}

/** Whether any local tool call is currently executing. */
export const hasInFlightToolCalls = (): boolean => inFlightToolCalls.size > 0

/** Snapshot of the currently-executing tool calls (insertion order). */
export const getInFlightTools = (): InFlightToolInfo[] =>
  Array.from(inFlightToolCalls.values())
