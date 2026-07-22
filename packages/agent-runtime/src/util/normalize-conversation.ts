import { errorToolResult } from '@codebuff/common/util/messages'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  AssistantMessage,
  Message,
  ToolMessage,
  UserMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type {
  TextPart,
  ToolCallPart,
} from '@codebuff/common/types/messages/content-part'

export type ViolationKind =
  | 'unbalanced_tool_use'
  | 'trailing_assistant'
  | 'consecutive_same_role'
  | 'orphan_tool_result'

export type NormalizeMode = 'repair' | 'throw'

export interface NormalizeOptions {
  mode?: NormalizeMode
  agentId: string
  stepIndex: number
  logger: Logger
}

export class ConversationShapeError extends Error {
  public readonly metadata: {
    violation: ViolationKind
    agentId: string
    stepIndex: number
  }

  constructor(params: {
    violation: ViolationKind
    agentId: string
    stepIndex: number
    message: string
  }) {
    super(params.message)
    this.name = 'ConversationShapeError'
    this.metadata = {
      violation: params.violation,
      agentId: params.agentId,
      stepIndex: params.stepIndex,
    }
  }
}

/**
 * Reads the CODEBUFF_STRICT_CONVERSATION environment variable. Returns
 * `'throw'` if the value is `'1'` or `'true'` (case-insensitive), else
 * `'repair'`. Backend/CI dev flag — always optional; same pattern as `IS_CI`
 * in `common/src/env.ts`.
 */
export function getDefaultNormalizeMode(): NormalizeMode {
  const value = process.env.CODEBUFF_STRICT_CONVERSATION
  if (typeof value !== 'string') return 'repair'
  const lower = value.trim().toLowerCase()
  if (lower === '1' || lower === 'true') return 'throw'
  return 'repair'
}

const MISSING_TOOL_RESULT_MARKER =
  '[runtime] tool result missing — synthesized to maintain conversation shape'

const TRAILING_ASSISTANT_CONTINUATION =
  '[runtime] continuing after assistant notes'

function getToolCallParts(msg: Message): ToolCallPart[] {
  if (msg.role !== 'assistant') return []
  const parts = msg.content
  if (!Array.isArray(parts)) return []
  return parts.filter(
    (p): p is ToolCallPart =>
      typeof p === 'object' &&
      p !== null &&
      (p as { type?: string }).type === 'tool-call',
  )
}

/**
 * Detect whether the messages array violates any Anthropic-shape invariant we
 * enforce. Fast path so already-valid conversations are returned as-is without
 * emitting telemetry (idempotence).
 *
 * Tradeoff: this re-implements the detection logic that the repair passes
 * below would also emit. We accept the O(2n) cost in exchange for: (a) zero
 * telemetry noise on valid conversations (the common case), and (b)
 * guaranteed idempotence — calling `normalizeConversation` on an already-
 * valid result returns the same array reference with no log lines. Keep the
 * checks here in sync with the pass bodies below if either changes.
 */
function conversationHasViolation(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const toolCalls = getToolCallParts(msg)
    if (toolCalls.length > 0) {
      const expected = new Set(toolCalls.map((c) => c.toolCallId))
      const provided = new Set<string>()
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        provided.add((messages[j] as ToolMessage).toolCallId)
        j++
      }
      for (const id of expected) {
        if (!provided.has(id)) return true
      }
    }
    if (msg.role === 'tool') {
      const tid = (msg as ToolMessage).toolCallId
      let preceding: Message | undefined
      for (let k = i - 1; k >= 0; k--) {
        if (messages[k].role === 'tool') continue
        preceding = messages[k]
        break
      }
      if (!preceding || preceding.role !== 'assistant') {
        return true
      }
      const callIds = getToolCallParts(preceding).map((c) => c.toolCallId)
      if (!callIds.includes(tid)) {
        return true
      }
    }
  }

  if (messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last.role === 'assistant') return true
  }

  // Only assistant-role consecutive messages are invalid (prefill shape).
  // Consecutive user messages are API-valid and MUST NOT be merged — upstream
  // code (loopAgentSteps) intentionally emits USER_PROMPT and
  // INSTRUCTIONS_PROMPT as separate user messages so tags, TTLs, and prompt-
  // caching boundaries are preserved.
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]
    const cur = messages[i]
    if (prev.role === 'assistant' && cur.role === 'assistant') {
      return true
    }
  }

  return false
}

/**
 * Pre-model-call normalization pass. Enforces Anthropic-API shape invariants:
 *   1. No consecutive assistant-role messages (invalid prefill shape).
 *   2. No orphan `tool-result` (no preceding assistant with matching id).
 *   3. Every `tool-call` has an immediately-following matching `tool-result`.
 *   4. The conversation does not end with a trailing assistant message.
 *
 * Pass order matters: merging consecutive assistants MUST run before orphan
 * detection, because the only way to legitimately have `[assistant(A),
 * assistant(B), tool_result A, tool_result B]` is for A and B to belong to
 * the same (unmerged) assistant turn — merging first produces
 * `[assistant(A+B), tool_result A, tool_result B]` which is valid. If we
 * orphan-detect first, `tool_result A` would be incorrectly dropped (its
 * preceding assistant is assistant(B), whose id set is {B}).
 *
 * In `'repair'` mode returns a new array with structured WARN/DEBUG logs per
 * repair (lossless repairs like consecutive-assistant merges log at DEBUG;
 * data-synthesizing or data-dropping repairs log at WARN). In `'throw'` mode throws `ConversationShapeError` on the first
 * **data-synthesizing** violation found (unbalanced tool_use, trailing
 * assistant). Lossless repairs (consecutive-assistant merge, orphan
 * tool_result drop) log at debug/warn depending on violation kind — they
 * represent either normal runtime shapes (`end_turn` excluded from history
 * produces back-to-back assistants) or safe cleanup with no fabricated data.
 * Idempotent on already-valid conversations.
 */
export function normalizeConversation(
  messages: Message[],
  opts: NormalizeOptions,
): Message[] {
  const mode: NormalizeMode = opts.mode ?? getDefaultNormalizeMode()
  const { agentId, stepIndex, logger } = opts

  if (!conversationHasViolation(messages)) {
    return messages
  }

  // Severity split:
  //   * `emitRepair` — lossless cleanup of shapes that occur organically at
  //     runtime (e.g., back-to-back assistants when `excludeToolFromMessageHistory`
  //     tools like `end_turn` fire consecutively; orphan tool_results from
  //     upstream bugs we want to DROP rather than fabricate data for). These
  //     always warn, never throw — strict mode has no useful signal to add
  //     because no data is being synthesized.
  //   * `emitSynthesis` — lossy repairs that fabricate conversation data to
  //     keep the model happy (missing tool_result synthesized; trailing
  //     assistant → fabricated user continuation). These indicate an upstream
  //     bug that should surface at PR time in strict mode.
  const emitRepair = (violation: ViolationKind, message: string) => {
    // consecutive_same_role is an expected, lossless runtime shape (back-to-back
    // assistant turns from excludeToolFromMessageHistory tools like end_turn).
    // Downgrade to debug to avoid noise in normal operation. All other lossless
    // repairs (e.g. orphan_tool_result drops data) stay at warn.
    const logFn =
      violation === 'consecutive_same_role' ? logger.debug : logger.warn
    logFn(
      {
        event: 'conversation.shape.repaired',
        violation,
        agentId,
        stepIndex,
        repaired: true,
      },
      message,
    )
  }
  const emitSynthesis = (violation: ViolationKind, message: string) => {
    if (mode === 'throw') {
      throw new ConversationShapeError({
        violation,
        agentId,
        stepIndex,
        message,
      })
    }
    logger.warn(
      {
        event: 'conversation.shape.repaired',
        violation,
        agentId,
        stepIndex,
        repaired: true,
      },
      message,
    )
  }

  let repaired: Message[] = [...messages]

  // Pass 1: Merge consecutive assistant-role messages first. Anthropic's API
  // accepts one assistant message with mixed content parts (text + tool-use)
  // but rejects two separate consecutive assistant messages. Merging first
  // preserves downstream invariants for pass 2/3 — e.g., if two unmerged
  // assistants each carry a tool_use whose results follow them both, only the
  // merged form has both tool_results correctly preceded by their assistant.
  {
    const out: Message[] = []
    for (const msg of repaired) {
      const prev = out[out.length - 1]
      if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
        emitRepair(
          'consecutive_same_role',
          `Consecutive assistant-role messages (agent=${agentId} step=${stepIndex}): merging into a single message.`,
        )
        const prevAssistant = prev as AssistantMessage
        const curAssistant = msg as AssistantMessage
        const prevContent =
          typeof prevAssistant.content === 'string'
            ? [
                {
                  type: 'text' as const,
                  text: prevAssistant.content,
                } satisfies TextPart,
              ]
            : prevAssistant.content
        const curContent =
          typeof curAssistant.content === 'string'
            ? [
                {
                  type: 'text' as const,
                  text: curAssistant.content,
                } satisfies TextPart,
              ]
            : curAssistant.content
        // Merge semantics: the earlier assistant's metadata wins — tags,
        // timeToLive, providerOptions, sentAt all come from `prev`. Any such
        // metadata on the second assistant is intentionally dropped, since
        // the merged turn is semantically a continuation of the first. For
        // organic runtime shapes (back-to-back `end_turn` with
        // `excludeToolFromMessageHistory: true`) neither assistant carries
        // meaningful metadata, so this is a no-op in practice.
        const merged: AssistantMessage = {
          ...prevAssistant,
          role: 'assistant',
          content: [
            ...(prevContent as AssistantMessage['content']),
            ...(curContent as AssistantMessage['content']),
          ],
        }
        out[out.length - 1] = merged
        continue
      }
      out.push(msg)
    }
    repaired = out
  }

  // Pass 2: Drop orphan tool_results. A tool_result is an orphan if the
  // nearest preceding non-tool message is not an assistant whose tool-call
  // parts include the matching id.
  {
    const out: Message[] = []
    for (let i = 0; i < repaired.length; i++) {
      const msg = repaired[i]
      if (msg.role !== 'tool') {
        out.push(msg)
        continue
      }
      const tid = (msg as ToolMessage).toolCallId
      let preceding: Message | undefined
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].role === 'tool') continue
        preceding = out[k]
        break
      }
      const matches =
        preceding &&
        preceding.role === 'assistant' &&
        getToolCallParts(preceding)
          .map((c) => c.toolCallId)
          .includes(tid)
      if (!matches) {
        emitRepair(
          'orphan_tool_result',
          `Orphan tool_result detected (agent=${agentId} step=${stepIndex} toolCallId=${tid}): dropping.`,
        )
        continue
      }
      out.push(msg)
    }
    repaired = out
  }

  // Pass 3: Unbalanced tool_use detection — synthesize missing tool_results.
  {
    const out: Message[] = []
    for (let i = 0; i < repaired.length; i++) {
      const msg = repaired[i]
      out.push(msg)
      const toolCalls = getToolCallParts(msg)
      if (toolCalls.length === 0) continue

      const nextIdx = i + 1
      const existingResultIds = new Set<string>()
      let j = nextIdx
      while (j < repaired.length && repaired[j].role === 'tool') {
        existingResultIds.add((repaired[j] as ToolMessage).toolCallId)
        j++
      }

      const missing = toolCalls.filter(
        (c) => !existingResultIds.has(c.toolCallId),
      )
      if (missing.length === 0) continue

      emitSynthesis(
        'unbalanced_tool_use',
        `Unbalanced tool_use detected (agent=${agentId} step=${stepIndex}): synthesized ${missing.length} missing tool_result(s).`,
      )

      for (let k = nextIdx; k < j; k++) {
        out.push(repaired[k])
      }
      for (const call of missing) {
        out.push(
          errorToolResult({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            errorMessage: MISSING_TOOL_RESULT_MARKER,
          }),
        )
      }
      i = j - 1
    }
    repaired = out
  }

  // Pass 4: Trailing-assistant detection (pre-model-call).
  if (repaired.length > 0) {
    const last = repaired[repaired.length - 1]
    if (last.role === 'assistant') {
      const hasToolCall = getToolCallParts(last).length > 0
      if (hasToolCall) {
        const calls = getToolCallParts(last)
        emitSynthesis(
          'unbalanced_tool_use',
          `Trailing assistant with unbalanced tool_use (agent=${agentId} step=${stepIndex}): synthesized ${calls.length} tool_result(s).`,
        )
        for (const call of calls) {
          repaired.push(
            errorToolResult({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              errorMessage: MISSING_TOOL_RESULT_MARKER,
            }),
          )
        }
      } else {
        emitSynthesis(
          'trailing_assistant',
          `Trailing assistant message before model call (agent=${agentId} step=${stepIndex}): appending user-role continuation.`,
        )
        const continuation: UserMessage = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: TRAILING_ASSISTANT_CONTINUATION,
            } satisfies TextPart,
          ],
          sentAt: Date.now(),
        }
        repaired.push(continuation)
      }
    }
  }

  return repaired
}
