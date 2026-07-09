import { getEmptyResponseFallbackModel } from '@codebuff/common/constants/model-config'

import type { Model } from '@codebuff/common/constants/model-config'

/**
 * Session-scoped "empty-response cooldown".
 *
 * When a model returns an EMPTY response (a dropped/truncated provider stream
 * that finished "cleanly" — no content, no tool calls), retrying that same
 * model immediately rarely recovers. Beyond the per-step model-fallback ladder,
 * we also want the model to stay "cooled off" for the rest of the session: once
 * a model drops a stream, we avoid *starting* a new turn on it for a while so we
 * don't keep hitting the same bad model/capacity pool at the top of every turn.
 *
 * State is keyed by `clientSessionId` (NOT process-global) so it never leaks
 * across sessions/users when this runtime is shared server-side. Entries are
 * lazily pruned when they expire.
 */

/** How long a model stays on cooldown after an empty response (30 minutes). */
export const EMPTY_RESPONSE_COOLDOWN_MS = 30 * 60 * 1000

// sessionId -> (model -> cooldown-until epoch ms)
//
// NOTE: a session's inner Map is pruned only when it becomes empty (all its
// models expired and were lazily removed). A session that ends while a cooldown
// is still active leaves a small entry until the next time that session is
// checked. For the local CLI (one process per session) this is a non-issue; if
// this runtime is shared long-lived server-side, add periodic eviction here.
const cooldownsBySession = new Map<string, Map<string, number>>()

// (sessionId -> set of models we've already emitted a user-visible cooldown
// notice for) so we don't spam the transcript at the start of every turn while
// a model is cooled. Cleared when the cooldown is (re)recorded.
const noticedBySession = new Map<string, Set<string>>()

/** Injectable clock so tests can control time deterministically. */
let now: () => number = () => Date.now()

/** Test-only: override the clock used for cooldown expiry. */
export function __setEmptyResponseCooldownClock(clock: () => number): void {
  now = clock
}

/** Test-only: reset the clock and clear all cooldown state. */
export function __resetEmptyResponseCooldowns(): void {
  now = () => Date.now()
  cooldownsBySession.clear()
  noticedBySession.clear()
}

/**
 * Record that `model` returned an empty response in `sessionId`. The model is
 * put on cooldown until `now + EMPTY_RESPONSE_COOLDOWN_MS`.
 */
export function recordEmptyResponseCooldown(
  sessionId: string,
  model: Model,
): void {
  let sessionCooldowns = cooldownsBySession.get(sessionId)
  if (!sessionCooldowns) {
    sessionCooldowns = new Map()
    cooldownsBySession.set(sessionId, sessionCooldowns)
  }
  sessionCooldowns.set(model, now() + EMPTY_RESPONSE_COOLDOWN_MS)
  // A fresh cooldown means the user should be told once more if we start a turn
  // on a fallback because of it.
  noticedBySession.get(sessionId)?.delete(model)
}

/**
 * Returns true at most once per (session, model) cooldown, so callers can emit a
 * single user-visible notice instead of repeating it on every turn while the
 * model stays cooled. Resets when the cooldown is (re)recorded.
 */
export function shouldNotifyCooldownOnce(
  sessionId: string,
  model: Model,
): boolean {
  let noticed = noticedBySession.get(sessionId)
  if (!noticed) {
    noticed = new Set()
    noticedBySession.set(sessionId, noticed)
  }
  if (noticed.has(model)) return false
  noticed.add(model)
  return true
}

/** Whether `model` is currently on cooldown for `sessionId`. */
export function isModelOnCooldown(sessionId: string, model: Model): boolean {
  const sessionCooldowns = cooldownsBySession.get(sessionId)
  if (!sessionCooldowns) return false
  const until = sessionCooldowns.get(model)
  if (until === undefined) return false
  if (until <= now()) {
    // Expired — prune lazily.
    sessionCooldowns.delete(model)
    if (sessionCooldowns.size === 0) cooldownsBySession.delete(sessionId)
    return false
  }
  return true
}

/**
 * Pick the model to START a turn with, skipping any models that are on
 * cooldown for this session. Starting at `preferredModel`, we step down the
 * empty-response fallback ladder (e.g. sonnet-5 -> sonnet-4.6 -> opus -> gpt-5)
 * until we find a model that is not on cooldown.
 *
 * If every model on the ladder is cooled down (or the ladder terminates), we
 * fall back to the last model considered so the turn can still proceed.
 */
export function pickStartModelSkippingCooldown(
  sessionId: string,
  preferredModel: Model,
): Model {
  let candidate: Model = preferredModel
  const seen = new Set<Model>()
  while (isModelOnCooldown(sessionId, candidate)) {
    seen.add(candidate)
    const next = getEmptyResponseFallbackModel(candidate)
    // Ladder terminated, or looped back to something we've already tried:
    // nothing better is available, so use the current (cooled) candidate.
    if (!next || seen.has(next)) return candidate
    candidate = next
  }
  return candidate
}
