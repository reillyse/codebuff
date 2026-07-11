import type { StreamStatus } from '../hooks/use-message-queue'
import type { RetryActivity } from './stream-activity'

export type StatusIndicatorState =
  | { kind: 'idle' }
  | { kind: 'clipboard'; message: string }
  | { kind: 'ctrlC' }
  | { kind: 'connecting' }
  | { kind: 'retrying' }
  | { kind: 'waiting' }
  | { kind: 'streaming' }
  | { kind: 'retrying-attempt'; attempt: number; total: number }
  | { kind: 'stalled'; sinceMs: number }
  | { kind: 'searching-memory' }
  | { kind: 'reconnected' }
  | { kind: 'paused' }

/**
 * How long the stream may be silent (no chunk) while in the waiting/streaming
 * phase before the UI surfaces a "stalled" indicator. This is purely a UX
 * signal so the user knows the CLI is waiting on the provider, not frozen; the
 * actual recovery is the SDK-side stream-stall timeout + retry ladder. Kept a
 * bit below the SDK's mid-stream stall timeout so "stalled..." appears before a
 * retry notice does.
 */
export const STALL_INDICATOR_THRESHOLD_MS = 20_000

export type AuthStatus = 'ok' | 'retrying' | 'unreachable'

export type StatusIndicatorStateArgs = {
  statusMessage?: string | null
  streamStatus: StreamStatus
  nextCtrlCWillExit: boolean
  isConnected: boolean
  authStatus?: AuthStatus
  isRetrying?: boolean
  /**
   * Whether to show a transient "Reconnected" status message.
   * This should only be true for a short period after a reconnection event.
   */
  showReconnectionMessage?: boolean
  /**
   * Whether the ask_user tool is currently active (waiting for user input).
   * When true, hides the "working..." and "thinking..." indicators.
   */
  isAskUserActive?: boolean
  /**
   * Whether hippo memory search is currently in progress.
   * When true, shows "searching memory..." instead of "thinking...".
   */
  isSearchingMemory?: boolean
  /**
   * Timestamp (ms) of the last stream activity (chunk received or stream
   * started). When the stream is in the waiting/streaming phase and this is
   * older than {@link STALL_INDICATOR_THRESHOLD_MS}, a 'stalled' indicator is
   * shown. `null`/undefined disables stall detection.
   */
  lastStreamActivityAt?: number | null
  /**
   * Active retry-attempt state while the SDK retry ladder is backing off before
   * the next attempt. When set and the backoff window (`until`) hasn't elapsed,
   * an honest "retrying (attempt N/M)" indicator is shown instead of a
   * misleading "stalled Ns". `null`/undefined means no retry is in progress.
   */
  retryActivity?: RetryActivity | null
  /** Injectable clock for testing; defaults to Date.now. */
  now?: number
}

/**
 * Determines the status indicator state based on current context.
 *
 * State priority (highest to lowest):
 * 1. nextCtrlCWillExit - User pressed Ctrl+C once, warn about exit
 * 2. statusMessage - Temporary feedback for clipboard operations
 * 3. connecting - Not connected to backend
 * 4. waiting - Waiting for AI response to start
 * 5. streaming - AI is actively responding
 * 6. idle - No activity
 *
 * @param args - Context for determining indicator state
 * @returns The appropriate state indicator
 */
export const getStatusIndicatorState = ({
  statusMessage,
  streamStatus,
  nextCtrlCWillExit,
  isConnected,
  authStatus = 'ok',
  isRetrying = false,
  showReconnectionMessage = false,
  isAskUserActive = false,
  isSearchingMemory = false,
  lastStreamActivityAt = null,
  retryActivity = null,
  now = Date.now(),
}: StatusIndicatorStateArgs): StatusIndicatorState => {
  if (nextCtrlCWillExit) {
    return { kind: 'ctrlC' }
  }

  if (statusMessage) {
    return { kind: 'clipboard', message: statusMessage }
  }

  // Transient reconnection indicator takes precedence over other status
  if (showReconnectionMessage) {
    return { kind: 'reconnected' }
  }

  // If we're online but the auth request hit a retryable error and is auto-retrying,
  // surface that explicitly to the user.
  if (authStatus === 'retrying') {
    return { kind: 'retrying' }
  }
  if (isRetrying) {
    return { kind: 'retrying' }
  }

  // Show connecting if service is disconnected OR auth service is unreachable
  if (!isConnected || authStatus === 'unreachable') {
    return { kind: 'connecting' }
  }

  // Show paused state when ask_user is active (timer stays visible but frozen)
  if (isAskUserActive) {
    return { kind: 'paused' }
  }

  if (isSearchingMemory) {
    return { kind: 'searching-memory' }
  }

  // Stall detection: while waiting for / receiving a response, if we haven't
  // seen any stream activity for a while, surface a 'stalled' indicator so the
  // user knows the CLI is blocked on the provider (not frozen). Recovery is
  // handled SDK-side; this is purely the UX signal.
  const isActivePhase =
    streamStatus === 'waiting' || streamStatus === 'streaming'

  // Honest retry indicator: while the SDK retry ladder is backing off before
  // the next attempt, show "retrying (attempt N/M)" instead of "stalled Ns".
  // Gated on `now < until` (the backoff window) so that if the *next* attempt
  // itself hangs, the indicator correctly falls through to 'stalled' rather
  // than getting stuck on "retrying" forever. Takes precedence over stalled.
  if (
    isActivePhase &&
    retryActivity != null &&
    now < retryActivity.until
  ) {
    return {
      kind: 'retrying-attempt',
      attempt: retryActivity.attempt,
      total: retryActivity.total,
    }
  }

  if (
    isActivePhase &&
    lastStreamActivityAt != null &&
    now - lastStreamActivityAt >= STALL_INDICATOR_THRESHOLD_MS
  ) {
    return { kind: 'stalled', sinceMs: now - lastStreamActivityAt }
  }

  if (streamStatus === 'waiting') {
    return { kind: 'waiting' }
  }

  if (streamStatus === 'streaming') {
    return { kind: 'streaming' }
  }

  return { kind: 'idle' }
}
