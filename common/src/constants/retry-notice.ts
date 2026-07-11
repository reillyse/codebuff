/**
 * Shared contract for the user-visible retry notice the agent step retry ladder
 * emits (see packages/agent-runtime/src/run-agent-step.ts).
 *
 * The emitter (agent-runtime) builds the notice via {@link formatRetryNoticeCore}
 * and the detector (CLI) recognizes it via {@link RETRY_NOTICE_MARKER} and
 * extracts the attempt/delay via {@link parseRetryNotice}. Keeping both sides
 * here means they can't silently drift apart: if the wording changed on one side
 * only, the "stalled Ns" indicator would climb across the whole run again and the
 * honest "retrying (attempt N/M)" indicator would stop appearing.
 */

/**
 * Stable marker embedded in the retry notice. The CLI uses this cheap substring
 * check to decide whether a chunk is a retry notice before doing the fuller
 * {@link parseRetryNotice} regex match.
 */
export const RETRY_NOTICE_MARKER = 'retrying in'

/**
 * Builds the core (marker + delay + attempt counter) of a retry notice, e.g.
 * `retrying in 4s (attempt 2/3)`. Callers prepend the reason / model-switch
 * context and wrap in `⚠️ ... ...` decoration. Centralizing this string here
 * keeps it in lock-step with {@link parseRetryNotice}.
 *
 * @param delaySec  Backoff delay before the next attempt, in whole seconds.
 * @param attempt   1-based number of the attempt that is about to start.
 * @param total     Total number of attempts (initial try + retries).
 */
export const formatRetryNoticeCore = (
  delaySec: number,
  attempt: number,
  total: number,
): string => `${RETRY_NOTICE_MARKER} ${delaySec}s (attempt ${attempt}/${total})`

/**
 * Matches the core produced by {@link formatRetryNoticeCore}. Captures:
 *   1: delaySec, 2: attempt, 3: total
 * Kept module-private; use {@link parseRetryNotice} instead.
 */
const RETRY_NOTICE_REGEX = /retrying in (\d+)s \(attempt (\d+)\/(\d+)\)/

export type ParsedRetryNotice = {
  /** Backoff delay before the next attempt, in whole seconds. */
  delaySec: number
  /** 1-based number of the attempt that is about to start. */
  attempt: number
  /** Total number of attempts (initial try + retries). */
  total: number
}

/**
 * Extracts the retry metadata from a chunk of text if it contains a retry
 * notice, or `null` otherwise. Cheap-rejects via {@link RETRY_NOTICE_MARKER}
 * before running the regex.
 */
export const parseRetryNotice = (text: string): ParsedRetryNotice | null => {
  if (!text.includes(RETRY_NOTICE_MARKER)) {
    return null
  }
  const match = text.match(RETRY_NOTICE_REGEX)
  if (!match) {
    return null
  }
  const delaySec = Number(match[1])
  const attempt = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isFinite(delaySec) ||
    !Number.isFinite(attempt) ||
    !Number.isFinite(total)
  ) {
    return null
  }
  return { delaySec, attempt, total }
}
