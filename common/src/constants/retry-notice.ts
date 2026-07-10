/**
 * Stable marker embedded in the user-visible retry notice the agent step retry
 * ladder emits (see packages/agent-runtime/src/run-agent-step.ts). The CLI uses
 * this marker to detect that a NEW retry attempt is beginning so it can re-arm
 * the stream-activity heartbeat (see cli/src/utils/sdk-event-handlers.ts and
 * cli/src/utils/stream-activity.ts).
 *
 * Keeping it here — shared by the emitter (agent-runtime) and the detector
 * (CLI) — means the two can't silently drift apart: the "stalled Ns" indicator
 * would climb across the whole run again if the CLI stopped recognizing the
 * notice.
 */
export const RETRY_NOTICE_MARKER = 'retrying in'
