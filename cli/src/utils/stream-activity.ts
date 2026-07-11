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
