import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  getEmptyResponseFallbackModel,
  getOverloadFallbackModel,
} from '@codebuff/common/constants/model-config'
import { formatRetryNoticeCore } from '@codebuff/common/constants/retry-notice'
import {
  pickStartModelSkippingCooldown,
  recordEmptyResponseCooldown,
  shouldNotifyCooldownOnce,
} from './empty-response-cooldown'
import { supportsCacheControl } from '@codebuff/common/old-constants'
// SPARROW: telemetry — wrap agent runs and steps in dedicated spans
import {
  withAgentRunSpan,
  withAgentStepSpan,
} from '@codebuff/common/sparrow/telemetry'
import { TOOLS_WHICH_WONT_FORCE_NEXT_STEP } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import { AbortError, describeTransientApiError, getErrorObject, getErrorStatusCode, getTransientStatusCode, isAbortError, isNoOutputGeneratedError, isTransientApiError, parseApiErrorResponseBody } from '@codebuff/common/util/error'
import { abortableSleep } from '@codebuff/common/util/promise'
import { serializeCacheDebugCorrelation } from '@codebuff/common/util/cache-debug'
import { systemMessage, userMessage } from '@codebuff/common/util/messages'
import { APICallError, type ToolSet } from 'ai'
import { cloneDeep, mapValues } from 'lodash'

import { CACHE_DEBUG_FULL_LOGGING } from './constants'
import { callTokenCountAPI, MISSING_CODEBUFF_CREDENTIALS_ERROR } from './llm-api/codebuff-web-api'
import { getMCPToolData } from './mcp'
import { getAgentStreamFromTemplate } from './prompt-agent-stream'
import { runProgrammaticStep } from './run-programmatic-step'
import { additionalSystemPrompts } from './system-prompt/prompts'
import { getAgentTemplate } from './templates/agent-registry'
import { buildAgentToolSet } from './templates/prompts'
import { getAgentPrompt } from './templates/strings'
import { getToolSet } from './tools/prompts'
import { processStream } from './tools/stream-parser'
import { getAgentOutput } from './util/agent-output'
import { logRawApiRequest } from './util/api-request-logger'
import {
  getDefaultNormalizeMode,
  normalizeConversation,
} from './util/normalize-conversation'
import {
  createCacheDebugSnapshot,
  enrichCacheDebugSnapshotWithProviderRequest,
  enrichCacheDebugSnapshotWithUsage,
} from './util/cache-debug'
import {
  withSystemInstructionTags,
  withSystemTags as withSystemTags,
  buildUserMessageContent,
  expireMessages,
} from './util/messages'
import { countTokensJson } from './util/token-counter'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@codebuff/common/types/contracts/database'
import type { CacheDebugUsageData, PromptAiSdkFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  ParamsExcluding,
} from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  AgentTemplateType,
  AgentState,
  AgentOutput,
} from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

/** Max additional retry attempts for a single agent step on transient API errors */
const MAX_STEP_RETRIES = 2

/** Base delay in ms before the first retry (doubles each attempt, with jitter) */
const STEP_RETRY_BASE_DELAY_MS = 2000

/** Maximum delay in ms between retries (cap for exponential backoff) */
const STEP_RETRY_MAX_DELAY_MS = 30_000

/**
 * No-progress NUDGE threshold: after this many CONSECUTIVE steps that keep the
 * loop alive without making any tool progress (no non-excluded tool result and
 * no task_completed/end_turn), we inject ONE corrective nudge message — we do
 * NOT force the turn to end.
 *
 * Rationale: a model producing text/reasoning every step IS the agent working;
 * previously we misclassified that as "no progress" and hard-quit at 8 steps
 * (the "8 responses in a row" symptom). Now we give it plenty of room and, if
 * it keeps narrating without acting, prod it to emit an actual tool call or
 * finish. The ultimate backstop against a runaway loop remains the
 * `stepsRemaining` ceiling (MAX_AGENT_STEPS_DEFAULT = 100).
 *
 * Note: truly-empty steps (no text, no reasoning, no tool call) are a DIFFERENT
 * case handled by the empty-response retry ladder below, which already retries
 * with backoff and ends the turn on give-up.
 */
const NO_PROGRESS_NUDGE_STEP = 30

/**
 * When the local token estimate for the (post-prune) history meets or exceeds
 * this many tokens, skip the remote token-count round-trip entirely and use the
 * local estimate. At this size the exact count changes no decision (we're well
 * past every threshold), and the remote call — a full-history JSON.stringify +
 * upload — is a per-step latency/hang contributor we want to avoid.
 */
const TOKEN_COUNT_REMOTE_SKIP_THRESHOLD = 500_000

/**
 * Log a WARN when a single token-count round-trip takes at least this long, so
 * slow per-step token counting (a hang contributor on bloated histories) is
 * visible in the logs.
 */
const TOKEN_COUNT_SLOW_WARN_MS = 3_000

/**
 * Warn in cli.jsonl when the local token estimate approaches the safe input
 * budget for a 200k-window model (200k context − 64k max_output = 136k input).
 * At this level the next pruning cycle may not bring us back under budget.
 */
const CONTEXT_BUDGET_WARN_TOKENS = 120_000

/**
 * Log at ERROR when the estimate is likely OVER the safe budget. At this level
 * the model will almost certainly return an empty response (the classic
 * context-overflow symptom: dropped stream with no content or tool calls).
 */
const CONTEXT_BUDGET_ERROR_TOKENS = 140_000

/**
 * Emergency loop-breaker: after this many CONSECUTIVE steps whose context
 * estimate is at/above CONTEXT_BUDGET_ERROR_TOKENS, force-end the turn WITHOUT
 * calling the model. At that level the model returns empty responses (the
 * context-overflow loop: prune → overflow → empty → retry → prune …), so
 * calling it again just burns retries forever. Two consecutive CRITICAL steps
 * means the pruner already ran and could not bring us under budget — the
 * session is unrecoverable without a fresh start.
 */
const MAX_CONSECUTIVE_CONTEXT_OVERFLOW_STEPS = 2

const CONTEXT_OVERFLOW_FORCE_END_MESSAGE =
  '\n⚠️ CONTEXT WINDOW CRITICAL: Your context is full and the model cannot respond. Ending the turn now to prevent an infinite loop. Please start a new session (e.g. /new) to continue.\n\n'

async function additionalToolDefinitions(
  params: {
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
  } & ParamsExcluding<
    typeof getMCPToolData,
    'toolNames' | 'mcpServers' | 'writeTo'
  >,
): Promise<{
  customToolDefinitions: CustomToolDefinitions
  mcpLoadErrors: string[]
}> {
  const { agentTemplate, fileContext } = params

  const defs = cloneDeep(
    Object.fromEntries(
      Object.entries(fileContext.customToolDefinitions).filter(([toolName]) =>
        agentTemplate!.toolNames.includes(toolName),
      ),
    ),
  )
  return getMCPToolData({
    ...params,
    toolNames: agentTemplate!.toolNames,
    mcpServers: agentTemplate!.mcpServers,
    writeTo: defs,
  })
}

export const runAgentStep = async (
  params: {
    userId: string | undefined
    userInputId: string
    clientSessionId: string
    costMode?: string
    fingerprintId: string
    repoId: string | undefined
    onResponseChunk: (chunk: string | PrintModeEvent) => void

    agentType: AgentTemplateType
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
    agentState: AgentState
    localAgentTemplates: Record<string, AgentTemplate>

    prompt: string | undefined
    spawnParams: Record<string, any> | undefined
    system: string
    n?: number

    trackEvent: TrackEventFn
    promptAiSdk: PromptAiSdkFn

    // SPARROW: telemetry — real step number plumbed from loopAgentSteps so the
    // agent.step span carries the loop counter, not messageHistory.length.
    sparrowStepNumber?: number
  } & ParamsExcluding<
    typeof processStream,
    | 'agentContext'
    | 'agentState'
    | 'agentStepId'
    | 'agentTemplate'
    | 'fullResponse'
    | 'messages'
    | 'onCostCalculated'
    | 'repoId'
    | 'stream'
  > &
    ParamsExcluding<
      typeof getAgentStreamFromTemplate,
      | 'agentId'
      | 'includeCacheControl'
      | 'messages'
      | 'onCostCalculated'
      | 'template'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      'agentTemplate' | 'promptType' | 'agentState' | 'agentTemplates'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<
      PromptAiSdkFn,
      'messages' | 'model' | 'onCostCalculated' | 'n'
    >,
): Promise<{
  agentState: AgentState
  fullResponse: string
  shouldEndTurn: boolean
  messageId: string | null
  nResponses?: string[]
  isEmptyResponse: boolean
  hadToolProgress: boolean
}> => {
  // SPARROW: telemetry — wrap step in agent.step span. stepNumber is taken
  // from params.sparrowStepNumber if provided by the caller (loopAgentSteps),
  // otherwise falls back to messageHistory.length as a best-effort proxy.
  const sparrowStepNumber =
    params.sparrowStepNumber ?? params.agentState.messageHistory.length
  return withAgentStepSpan(
    {
      agentId: params.agentState.agentId,
      agentDisplayId: params.agentTemplate.id,
      stepNumber: sparrowStepNumber,
    },
    async () => {
  const {
    agentType,
    clientSessionId,
    fileContext,
    agentTemplate,
    fingerprintId,
    localAgentTemplates,
    logger,
    prompt,
    repoId,
    spawnParams,
    system,
    userId,
    userInputId,
    onResponseChunk,
    promptAiSdk,
    trackEvent,
    additionalToolDefinitions,
  } = params
  let agentState = params.agentState

  const { agentContext } = agentState

  const startTime = Date.now()

  // Generates a unique ID for each main prompt run (ie: a step of the agent loop)
  // This is used to link logs within a single agent loop
  const agentStepId = crypto.randomUUID()
  trackEvent({
    event: AnalyticsEvent.AGENT_STEP,
    userId: userId ?? '',
    properties: {
      agentStepId,
      clientSessionId,
      fingerprintId,
      userInputId,
      userId,
      repoName: repoId,
    },
    logger,
  })

  if (agentState.stepsRemaining <= 0) {
    logger.warn(
      `Detected too many consecutive assistant messages without user prompt`,
    )

    onResponseChunk(`${STEP_WARNING_MESSAGE}\n\n`)

    // Update message history to include the warning
    agentState = {
      ...agentState,
      messageHistory: [
        ...expireMessages(agentState.messageHistory, 'userPrompt'),
        userMessage(
          withSystemTags(
            `The assistant has responded too many times in a row. The assistant's turn has automatically been ended. The maximum number of responses can be configured via maxAgentSteps.`,
          ),
        ),
      ],
    }
    return {
      agentState,
      fullResponse: STEP_WARNING_MESSAGE,
      shouldEndTurn: true,
      messageId: null,
      isEmptyResponse: false,
      hadToolProgress: false,
    }
  }

  const stepPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'stepPrompt' },
    fileContext,
    agentState,
    agentTemplates: localAgentTemplates,
    logger,
    additionalToolDefinitions,
  })

  const agentMessagesUntruncated = buildArray<Message>(
    ...expireMessages(agentState.messageHistory, 'agentStep'),

    stepPrompt &&
    userMessage({
      content: stepPrompt,
      tags: ['STEP_PROMPT'],

      // James: Deprecate the below, only use tags, which are not prescriptive.
      timeToLive: 'agentStep' as const,
      keepDuringTruncation: true,
    }),
  )

  agentState.messageHistory = agentMessagesUntruncated

  const { model } = agentTemplate

  let stepCreditsUsed = 0

  const onCostCalculated = async (credits: number) => {
    stepCreditsUsed += credits
    agentState.creditsUsed += credits
    agentState.directCreditsUsed += credits
  }

  const iterationNum = agentState.messageHistory.length
  const systemTokens = countTokensJson(system)

  const cacheDebugCorrelation = CACHE_DEBUG_FULL_LOGGING
    ? createCacheDebugSnapshot({
        agentType: String(agentType),
        system,
        toolDefinitions: params.tools
          ? Object.fromEntries(
              Object.entries(params.tools).map(([name, tool]) => [
                name,
                {
                  description: tool.description,
                  inputSchema: tool.inputSchema as {},
                },
              ]),
            )
          : {},
        messages: [systemMessage(system), ...agentState.messageHistory],
        logger,
        projectRoot: fileContext.projectRoot,
        runId: agentState.runId,
        userInputId,
        agentStepId,
        model,
      })
    : undefined

  const onCacheDebugProviderRequestBuilt = ({
    provider,
    rawBody,
    normalizedBody,
  }: {
    provider: string
    rawBody: unknown
    normalizedBody?: unknown
  }) => {
    // Always log the EXACT wire body captured at build time (no reconstruction).
    // Gated internally by CODEBUFF_API_REQUEST_LOG.
    logRawApiRequest({
      projectRoot: fileContext.projectRoot,
      agentType: String(agentType),
      stepNumber: iterationNum,
      model,
      provider,
      rawBody,
    })
    if (cacheDebugCorrelation) {
      enrichCacheDebugSnapshotWithProviderRequest({
        correlation: cacheDebugCorrelation,
        provider,
        rawBody,
        normalized: normalizedBody ?? rawBody,
        logger,
      })
    }
  }

  const onCacheDebugUsageReceived =
    cacheDebugCorrelation
      ? (usage: CacheDebugUsageData) => {
          enrichCacheDebugSnapshotWithUsage({
            correlation: cacheDebugCorrelation,
            usage,
            logger,
          })
        }
      : undefined

  logger.debug(
    {
      iteration: iterationNum,
      runId: agentState.runId,
      model,
      duration: Date.now() - startTime,
      contextTokenCount: agentState.contextTokenCount,
      agentMessages: agentState.messageHistory.concat().reverse(),
      system,
      prompt,
      params: spawnParams,
      agentContext,
      systemTokens,
      agentTemplate,
      tools: params.tools,
    },
    `Start agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  // Normalize conversation immediately before the model call. This is the
  // model-call chokepoint: we guarantee the LLM receives a valid Anthropic-
  // shape payload regardless of how messageHistory was assembled upstream.
  agentState.messageHistory = normalizeConversation(agentState.messageHistory, {
    mode: getDefaultNormalizeMode(),
    agentId: agentTemplate.id,
    stepIndex: iterationNum,
    logger,
  })

  // Handle n parameter for generating multiple responses
  if (params.n !== undefined) {
    const result = await promptAiSdk({
      ...params,
      messages: agentState.messageHistory,
      model,
      n: params.n,
      onCostCalculated,
      cacheDebugCorrelation: cacheDebugCorrelation
        ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
        : undefined,
      onCacheDebugProviderRequestBuilt,
      onCacheDebugUsageReceived,
    })

    if (result.aborted) {
      return {
        agentState,
        fullResponse: '',
        shouldEndTurn: true,
        messageId: null,
        nResponses: undefined,
        isEmptyResponse: false,
        hadToolProgress: false,
      }
    }

    const responsesString = result.value
    let nResponses: string[]
    try {
      nResponses = JSON.parse(responsesString) as string[]
      if (!Array.isArray(nResponses)) {
        if (params.n > 1) {
          throw new Error(
            `Expected JSON array response from LLM when n > 1, got non-array: ${responsesString.slice(0, 50)}`,
          )
        }
        // If it parsed but isn't an array, treat as single response
        nResponses = [responsesString]
      }
    } catch (e) {
      if (params.n > 1) {
        throw e
      }
      // If parsing fails, treat as single raw response (common for n=1)
      nResponses = [responsesString]
    }

    return {
      agentState,
      fullResponse: responsesString,
      shouldEndTurn: false,
      messageId: null,
      nResponses,
      isEmptyResponse: false,
      // The `n`-parameter path generates candidate responses rather than
      // executing tools; treat it as progress so it never trips the
      // no-progress guard (it always advances via the programmatic step).
      hadToolProgress: true,
    }
  }

  let fullResponse = ''
  const toolResults: ToolMessage[] = []

  // Raw stream from AI SDK
  const stream = getAgentStreamFromTemplate({
    ...params,
    agentId: agentState.parentId ? agentState.agentId : undefined,
    costMode: params.costMode,
    cacheDebugCorrelation: cacheDebugCorrelation
      ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
      : undefined,
    includeCacheControl: supportsCacheControl(agentTemplate.model),
    messages: [systemMessage(system), ...agentState.messageHistory],
    onCacheDebugProviderRequestBuilt,
    onCacheDebugUsageReceived,
    template: agentTemplate,
    onCostCalculated,
  })

  const {
    fullResponse: fullResponseAfterStream,
    fullResponseChunks,
    hadToolCallError,
    hadReasoning,
    messageId,
    toolCalls,
    toolResults: newToolResults,
  } = await processStream({
    ...params,
    agentContext,
    agentState,
    agentStepId,
    agentTemplate,
    fullResponse,
    messages: agentState.messageHistory,
    repoId,
    stream,
    onCostCalculated,
  })

  toolResults.push(...newToolResults)

  fullResponse = fullResponseAfterStream

  agentState.messageHistory = expireMessages(
    agentState.messageHistory,
    'agentStep',
  )

  // Handle /compact command: replace message history with the summary
  const wasCompacted =
    prompt &&
    (prompt.toLowerCase() === '/compact' || prompt.toLowerCase() === 'compact')
  if (wasCompacted) {
    agentState.messageHistory = [
      userMessage(
        withSystemTags(
          `The following is a summary of the conversation between you and the user. The conversation continues after this summary:\n\n${fullResponse}`,
        ),
      ),
    ]
    logger.debug({ summary: fullResponse }, 'Compacted messages')
  }

  const hasNoToolResults =
    toolCalls.filter(
      (call) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(call.toolName),
    ).length === 0 &&
    toolResults.filter(
      (result) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(result.toolName),
    ).length === 0 &&
    !hadToolCallError // Tool call errors should also force another step so the agent can retry

  const hasTaskCompleted = toolCalls.some(
    (call) =>
      call.toolName === 'task_completed' || call.toolName === 'end_turn',
  )

  // Whether this step made real "progress": it either finished the turn
  // (task_completed/end_turn) or produced at least one non-excluded tool
  // result. A step that keeps the loop alive with NO tool result at all (e.g. a
  // malformed/partial tool call, which sets `hadToolCallError` but emits no
  // result, or a "think-only" response) is NOT progress. loopAgentSteps uses
  // this to detect and break degenerate no-progress loops before they exhaust
  // `stepsRemaining`.
  //
  // Note: this counts any non-excluded tool result as progress; it does NOT
  // distinguish successful results from error results. That's intentional — a
  // tool that runs and returns an error IS making progress (the agent gets
  // feedback and can adjust); the pathological case we're guarding against is
  // the model producing steps that yield no tool result at all.
  const hadToolResult =
    toolResults.filter(
      (result) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(result.toolName),
    ).length > 0
  const hadToolProgress = hasTaskCompleted || hadToolResult

  // If the response is only <think>...</think> tags with no other non-whitespace content,
  // the model was just thinking and should continue rather than end its turn.
  const responseWithoutThinkTags = fullResponse
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim()
  const isThinkOnly =
    hasNoToolResults &&
    responseWithoutThinkTags.length === 0 &&
    fullResponse.trim().length > 0

  // If the agent has the task_completed tool, it must be called to end its turn.
  const requiresExplicitCompletion =
    agentTemplate.toolNames.includes('task_completed')

  let shouldEndTurn: boolean
  if (requiresExplicitCompletion) {
    // For models requiring explicit completion, only end turn when:
    // - task_completed is called, OR
    // - end_turn is called (backward compatibility)
    shouldEndTurn = hasTaskCompleted
  } else {
    // For other models, also end turn when there are no tool calls
    // Exception: if the response is only <think> tags, continue the turn
    shouldEndTurn = hasTaskCompleted || (hasNoToolResults && !isThinkOnly)
  }

  // Detect a truly EMPTY turn: the turn is ending, but the model produced NO
  // tool calls, NO tool results, and NO text content. This is the classic
  // "stops randomly" symptom — a dropped/truncated provider stream (e.g. a
  // swallowed mid-stream 529) that the SDK finished as a normal completion.
  // We report it via `isEmptyResponse` so loopAgentSteps can RETRY it (with
  // backoff) before surfacing a warning and ending the turn.
  //
  // IMPORTANT: this must NOT be gated on `shouldEndTurn`. For agents that
  // require explicit completion (they have `task_completed`), `shouldEndTurn`
  // is `hasTaskCompleted` — which is `false` on an empty response — so gating on
  // it would make an empty stream invisible to the retry ladder. Such an agent
  // would then loop, re-empty, and only stop at the no-progress guard (~8 steps
  // of dead air) instead of retrying + ending the turn promptly. The condition
  // below (no completion, no tool results, no content) fully characterizes an
  // empty turn on its own; for non-explicit-completion agents `shouldEndTurn`
  // is already true whenever these hold, so dropping the gate is a no-op there.
  const isEmptyResponse =
    !hasTaskCompleted &&
    hasNoToolResults &&
    fullResponse.trim().length === 0 &&
    // Native reasoning tokens are streamed but NOT captured into fullResponse,
    // so a step that produced ONLY reasoning would otherwise look "empty". That
    // step is the agent THINKING, not a dropped stream — don't funnel it into
    // the empty-response retry ladder.
    !hadReasoning
  if (isEmptyResponse) {
    logger.debug(
      {
        iteration: iterationNum,
        agentType,
        agentId: agentState.agentId,
        model,
        runId: agentState.runId,
        finishReason: 'empty-response',
      },
      'Agent step returned an empty response (no content, no tool calls); loopAgentSteps will retry before ending the turn',
    )
  }

  agentState = {
    ...agentState,
    stepsRemaining: agentState.stepsRemaining - 1,
    agentContext,
  }

  logger.debug(
    {
      iteration: iterationNum,
      agentId: agentState.agentId,
      model,
      prompt,
      shouldEndTurn,
      duration: Date.now() - startTime,
      fullResponse,
      finalMessageHistoryWithToolResults: agentState.messageHistory.concat().reverse(),
      toolCalls,
      toolResults,
      agentContext,
      fullResponseChunks,
      stepCreditsUsed,
    },
    `End agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  return {
    agentState,
    fullResponse,
    shouldEndTurn,
    messageId,
    nResponses: undefined,
    isEmptyResponse,
    hadToolProgress,
  }
    },
  )
}

export async function loopAgentSteps(
  params: {
    addAgentStep: AddAgentStepFn
    agentState: AgentState
    agentType: string
    clearUserPromptMessagesAfterResponse?: boolean
    clientSessionId: string
    content?: Array<TextPart | ImagePart>
    costMode?: string
    fileContext: ProjectFileContext
    finishAgentRun: FinishAgentRunFn
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    parentSystemPrompt?: string
    parentTools?: ToolSet
    prompt: string | undefined
    signal: AbortSignal
    spawnParams: Record<string, any> | undefined
    startAgentRun: StartAgentRunFn
    userId: string | undefined
    userInputId: string
    agentTemplate?: AgentTemplate
  } & ParamsExcluding<typeof additionalToolDefinitions, 'agentTemplate'> &
    ParamsExcluding<
      typeof runProgrammaticStep,
      | 'agentState'
      | 'onCostCalculated'
      | 'prompt'
      | 'runId'
      | 'stepNumber'
      | 'stepsComplete'
      | 'system'
      | 'template'
      | 'toolCallParams'
      | 'tools'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      | 'agentTemplate'
      | 'promptType'
      | 'agentTemplates'
      | 'additionalToolDefinitions'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<StartAgentRunFn, 'agentId' | 'ancestorRunIds'> &
    ParamsExcluding<
      FinishAgentRunFn,
      'runId' | 'status' | 'totalSteps' | 'directCredits' | 'totalCredits'
    > &
    ParamsExcluding<
      typeof runAgentStep,
      | 'additionalToolDefinitions'
      | 'agentState'
      | 'agentTemplate'
      | 'prompt'
      | 'runId'
      | 'spawnParams'
      // SPARROW: internal telemetry plumbing, not a public knob on loopAgentSteps
      | 'sparrowStepNumber'
      | 'system'
      | 'tools'
    > &
    ParamsExcluding<
      AddAgentStepFn,
      | 'agentRunId'
      | 'stepNumber'
      | 'credits'
      | 'childRunIds'
      | 'messageId'
      | 'status'
      | 'startTime'
    >,
): Promise<{
  agentState: AgentState
  output: AgentOutput
}> {
  // SPARROW: telemetry — wrap entire agent run in `agent.run` span.
  return withAgentRunSpan(
    {
      agentId: params.agentState.agentId,
      agentDisplayId: params.agentTemplate?.id ?? params.agentType,
      parentAgentId: params.agentState.parentId,
    },
    async () => {
  const {
    addAgentStep,
    agentState: initialAgentState,
    agentType,
    clearUserPromptMessagesAfterResponse = true,
    clientSessionId,
    content,
    fileContext,
    finishAgentRun,
    localAgentTemplates,
    logger,
    parentSystemPrompt,
    onResponseChunk,
    parentTools,
    prompt,
    signal,
    spawnParams,
    startAgentRun,
    userId,
    userInputId,
    clientEnv,
    ciEnv,
  } = params

  let agentTemplate = params.agentTemplate
  if (!agentTemplate) {
    agentTemplate =
      (await getAgentTemplate({
        ...params,
        agentId: agentType,
      })) ?? undefined
  }
  if (!agentTemplate) {
    throw new Error(`Agent template not found for type: ${agentType}`)
  }

  if (signal.aborted) {
    return {
      agentState: initialAgentState,
      output: {
        type: 'error',
        message: 'Run cancelled by user',
      },
    }
  }

  const runId = await startAgentRun({
    ...params,
    agentId: agentTemplate.id,
    ancestorRunIds: initialAgentState.ancestorRunIds,
  })
  if (!runId) {
    throw new Error('Failed to start agent run')
  }
  initialAgentState.runId = runId

  let cachedAdditionalToolDefinitions: CustomToolDefinitions | undefined
  // Reasons any inherited/configured MCP servers failed to load their tools.
  // Populated lazily by getAdditionalToolDefs and surfaced to the model via a
  // system notice below so it can explain missing MCP tools to the user.
  let cachedMcpLoadErrors: string[] = []
  const getAdditionalToolDefs = async () => {
    if (!cachedAdditionalToolDefinitions) {
      const result = await additionalToolDefinitions({
        ...params,
        agentTemplate,
      })
      cachedAdditionalToolDefinitions = result.customToolDefinitions
      cachedMcpLoadErrors = result.mcpLoadErrors
    }
    return cachedAdditionalToolDefinitions
  }
  // Use parent's tools for prompt caching when inheritParentSystemPrompt is true
  const useParentTools =
    agentTemplate.inheritParentSystemPrompt && parentTools !== undefined

  // Initialize message history with user prompt and instructions on first iteration
  const instructionsPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'instructionsPrompt' },
    agentTemplates: localAgentTemplates,
    useParentTools,
    additionalToolDefinitions: getAdditionalToolDefs,
  })

  // Build the initial message history with user prompt and instructions
  // Generate system prompt once, using parent's if inheritParentSystemPrompt is true
  let system: string
  if (agentTemplate.inheritParentSystemPrompt && parentSystemPrompt) {
    system = parentSystemPrompt
  } else {
    const systemPrompt = await getAgentPrompt({
      ...params,
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      agentTemplates: localAgentTemplates,
      additionalToolDefinitions: getAdditionalToolDefs,
    })
    system = systemPrompt ?? ''
  }

  // Eagerly compute tool defs so any MCP load errors are available for the
  // system notice. When an MCP server (often an OAuth server inherited from the
  // parent) fails to load its tools, surface the reason to the model instead of
  // silently omitting the tools — this lets subagents explain to the user why
  // the tools are unavailable and how to fix it.
  await getAdditionalToolDefs()
  if (cachedMcpLoadErrors.length > 0) {
    const mcpErrorNotice = withSystemInstructionTags(
      `⚠️ The following MCP servers failed to load their tools and are UNAVAILABLE in this session:\n` +
        cachedMcpLoadErrors.map((e) => `- ${e}`).join('\n') +
        `\nIf the user asks about tools from these servers, inform them that authentication is required. They can run /connect:mcp to authenticate.`,
    )
    system = system + (system ? '\n\n' : '') + mcpErrorNotice
  }

  // Build agent tools (agents as direct tool calls) for non-inherited tools.
  // Skip entirely when spawn_agents is NOT in the agent's toolNames: such
  // agents can never spawn sub-agents, so building agent tool definitions is
  // pure token waste. Inherited/declared spawnableAgents can be 30+ agents
  // (~100k tokens of tool schemas) that would otherwise be injected into every
  // step of a leaf agent that can't use them — a major context-budget driver.
  const skipAgentToolsBecauseNoSpawnAgents =
    !useParentTools && !agentTemplate.toolNames.includes('spawn_agents')
  if (skipAgentToolsBecauseNoSpawnAgents) {
    logger.debug(
      {
        agentId: agentTemplate.id,
        spawnableAgentsCount: agentTemplate.spawnableAgents?.length ?? 0,
      },
      'Skipping buildAgentToolSet: spawn_agents not in toolNames (token bloat prevention)',
    )
  }
  const agentTools =
    useParentTools || skipAgentToolsBecauseNoSpawnAgents
      ? {}
      : await buildAgentToolSet({
        ...params,
        spawnableAgents: agentTemplate.spawnableAgents,
        agentTemplates: localAgentTemplates,
      })

  const tools = useParentTools
    ? parentTools
    : await getToolSet({
      toolNames: agentTemplate.toolNames,
      additionalToolDefinitions: getAdditionalToolDefs,
      agentTools,
      skills: fileContext.skills ?? {},
      includeCacheControl: supportsCacheControl(agentTemplate.model),
    })

  const hasUserMessage = Boolean(
    prompt ||
    (spawnParams && Object.keys(spawnParams).length > 0) ||
    (content && content.length > 0),
  )

  const initialMessages = buildArray<Message>(
    ...initialAgentState.messageHistory,

    hasUserMessage && [
      {
        // Actual user message!
        role: 'user' as const,
        content: buildUserMessageContent(prompt, spawnParams, content),
        tags: ['USER_PROMPT'],
        sentAt: Date.now(),

        // James: Deprecate the below, only use tags, which are not prescriptive.
        keepDuringTruncation: true,
      },
      prompt &&
      prompt in additionalSystemPrompts &&
      userMessage(
        withSystemInstructionTags(
          additionalSystemPrompts[
          prompt as keyof typeof additionalSystemPrompts
          ],
        ),
      ),
      ,
    ],

    instructionsPrompt &&
    userMessage({
      content: instructionsPrompt,
      tags: ['INSTRUCTIONS_PROMPT'],

      // James: Deprecate the below, only use tags, which are not prescriptive.
      keepLastTags: ['INSTRUCTIONS_PROMPT'],
    }),
  )

  // Convert tools to a serializable format for context-pruner token counting
  const toolDefinitions = mapValues(tools, (tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema as {},
  }))

  const additionalToolDefinitionsWithCache = getAdditionalToolDefs

  let currentAgentState: AgentState = {
    ...initialAgentState,
    messageHistory: initialMessages,
    systemPrompt: system,
    toolDefinitions,
  }
  let shouldEndTurn = false
  let hasRetriedOutputSchema = false
  let currentPrompt = prompt
  let currentParams = spawnParams
  let totalSteps = 0
  let nResponses: string[] | undefined = undefined
  // No-progress nudge: count CONSECUTIVE steps that kept the loop alive without
  // making any tool progress. Reset to 0 whenever a step makes progress (or ends
  // the turn). When it reaches NO_PROGRESS_NUDGE_STEP we inject ONE corrective
  // nudge (not a force-quit) so the model course-corrects; the run is otherwise
  // bounded by the stepsRemaining ceiling.
  let consecutiveNoProgressSteps = 0
  // Whether we've already nudged during the CURRENT no-progress streak. Reset
  // when a step makes progress so a later, separate streak can be nudged again.
  let hasNudgedForNoProgress = false
  // Emergency context-overflow loop-breaker: count CONSECUTIVE steps whose
  // context estimate is CRITICAL (>= CONTEXT_BUDGET_ERROR_TOKENS). One
  // CRITICAL step gets a chance (the pruner may still recover it); two in a
  // row means pruning already ran and failed — force-end the turn instead of
  // calling the model again (it would just return empty responses forever).
  let consecutiveContextOverflowSteps = 0

  try {
    while (true) {
      totalSteps++
      if (signal.aborted) {
        throw new AbortError()
      }

      const startTime = new Date()

      // 1. Run programmatic step first if it exists
      let n: number | undefined = undefined

      if (agentTemplate.handleSteps) {
        const programmaticResult = await runProgrammaticStep({
          ...params,

          agentState: currentAgentState,
          localAgentTemplates,
          nResponses,
          onCostCalculated: async (credits: number) => {
            currentAgentState.creditsUsed += credits
            currentAgentState.directCreditsUsed += credits
          },
          prompt: currentPrompt,
          runId,
          stepNumber: totalSteps,
          stepsComplete: shouldEndTurn,
          system,
          tools,
          template: agentTemplate,
          toolCallParams: currentParams,
        })
        const {
          agentState: programmaticAgentState,
          endTurn,
          stepNumber,
          generateN,
        } = programmaticResult
        n = generateN

        currentAgentState = programmaticAgentState
        totalSteps = stepNumber

        shouldEndTurn = endTurn
      }

      // Check context token count AFTER the programmatic step so the
      // context-pruner (which runs in handleSteps) has already shrunk the
      // history before we serialize + POST it. Running it beforehand meant a
      // bloated session paid the full un-pruned history cost (huge
      // JSON.stringify + upload) on EVERY step before the pruner could help.
      //
      // We also short-circuit the remote call entirely when the local estimate
      // is very large: at that size the exact count doesn't change any decision
      // (we're well past every threshold), and the round-trip is the expensive
      // part we're trying to avoid.
      // NOTE: this counts the post-prune message history WITHOUT the step
      // prompt (which runAgentStep appends internally). The step-prompt delta is
      // negligible for context-budget purposes, and counting the real history
      // here is what lets us short-circuit the remote call on huge sessions.
      const tokenCountStart = Date.now()
      const localTokenEstimate =
        countTokensJson(currentAgentState.messageHistory) +
        countTokensJson(system) +
        countTokensJson(toolDefinitions)
      if (localTokenEstimate >= TOKEN_COUNT_REMOTE_SKIP_THRESHOLD) {
        currentAgentState.contextTokenCount = localTokenEstimate
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
            totalSteps,
            localTokenEstimate,
            threshold: TOKEN_COUNT_REMOTE_SKIP_THRESHOLD,
          },
          'Skipping remote token count: local estimate exceeds threshold (history is very large); using local estimate to avoid an expensive round-trip on a bloated history',
        )
      } else {
        const tokenCountResult = await callTokenCountAPI({
          messages: currentAgentState.messageHistory,
          system,
          model: agentTemplate.model,
          fetch,
          logger,
          env: { clientEnv, ciEnv },
        })
        if (tokenCountResult.inputTokens !== undefined) {
          currentAgentState.contextTokenCount = tokenCountResult.inputTokens
        } else if (tokenCountResult.error) {
          // 'Missing Codebuff base URL or API key' is a BENIGN, expected
          // condition (e.g. Claude OAuth without a Codebuff API key): we fall
          // back to the local estimate. Log it at debug so it doesn't spam the
          // persistent log and bury real failures. All OTHER token-count errors
          // (real API/network failures) stay at warn so genuine problems
          // surface.
          const isNotConfigured =
            tokenCountResult.error === MISSING_CODEBUFF_CREDENTIALS_ERROR
          if (isNotConfigured) {
            logger.debug(
              { error: tokenCountResult.error },
              'Skipping remote token count (Codebuff base URL/API key not configured); using local estimate',
            )
          } else {
            logger.warn(
              { error: tokenCountResult.error },
              'Failed to get token count from Anthropic API',
            )
          }
          currentAgentState.contextTokenCount = localTokenEstimate
        }
      }
      const tokenCountDurationMs = Date.now() - tokenCountStart
      // Surface slow token-count round-trips: a multi-second count each step is
      // a hang contributor on bloated histories, and this pinpoints it.
      if (tokenCountDurationMs >= TOKEN_COUNT_SLOW_WARN_MS) {
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
            totalSteps,
            tokenCountDurationMs,
            localTokenEstimate,
            contextTokenCount: currentAgentState.contextTokenCount,
          },
          'Token count took a long time; large histories make this a per-step hang contributor',
        )
      }

      // Surface context-budget pressure in cli.jsonl so we can catch the
      // context-overflow loop without parsing api-request-log.txt. At
      // WARN level you'll see it in a simple `grep WARN cli.jsonl`; at
      // ERROR it means we're almost certainly going to get an empty
      // response on this step.
      const ctxEst = currentAgentState.contextTokenCount ?? localTokenEstimate
      if (ctxEst >= CONTEXT_BUDGET_ERROR_TOKENS) {
        consecutiveContextOverflowSteps++
        logger.error(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
            totalSteps,
            contextTokenEstimate: ctxEst,
            localTokenEstimate,
            warningThreshold: CONTEXT_BUDGET_WARN_TOKENS,
            errorThreshold: CONTEXT_BUDGET_ERROR_TOKENS,
            consecutiveContextOverflowSteps,
            systemTokens: countTokensJson(system),
            toolTokens: countTokensJson(toolDefinitions),
            messageTokens: countTokensJson(currentAgentState.messageHistory),
          },
          '🚨 Context budget CRITICAL: estimated tokens likely exceed safe input budget (200k − 64k output = 136k). Expect empty response / context-overflow loop on this step.',
        )
        // Emergency escape: on the 2nd+ consecutive CRITICAL step, the pruner
        // has already run (it fires every step via handleSteps) and could not
        // bring us under budget — the non-prunable floor (system prompt + tool
        // schemas) exceeds the safe input budget. Calling the model again just
        // yields another empty response and re-enters the loop. Force-end the
        // turn WITHOUT calling the model.
        if (
          consecutiveContextOverflowSteps >=
          MAX_CONSECUTIVE_CONTEXT_OVERFLOW_STEPS
        ) {
          logger.error(
            {
              agentType,
              agentId: currentAgentState.agentId,
              runId,
              totalSteps,
              contextTokenEstimate: ctxEst,
              consecutiveContextOverflowSteps,
              finishReason: 'context-overflow-force-end',
            },
            'Context overflow loop detected (consecutive CRITICAL steps after pruning); force-ending the turn without calling the model',
          )
          onResponseChunk(CONTEXT_OVERFLOW_FORCE_END_MESSAGE)
          currentAgentState.messageHistory = [
            ...currentAgentState.messageHistory,
            userMessage(
              withSystemTags(
                'The context window overflowed and the turn was automatically ended to prevent an infinite loop. The user should start a new session to continue.',
              ),
            ),
          ]
          shouldEndTurn = true
          break
        }
      } else if (ctxEst >= CONTEXT_BUDGET_WARN_TOKENS) {
        consecutiveContextOverflowSteps = 0
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
            totalSteps,
            contextTokenEstimate: ctxEst,
            localTokenEstimate,
            warningThreshold: CONTEXT_BUDGET_WARN_TOKENS,
            errorThreshold: CONTEXT_BUDGET_ERROR_TOKENS,
          },
          '⚠️ Context budget WARNING: approaching safe input budget limit (200k − 64k output = 136k). Pruning may not be sufficient.',
        )
      } else {
        consecutiveContextOverflowSteps = 0
      }

      // Check if output is required but missing
      if (
        agentTemplate.outputSchema &&
        currentAgentState.output === undefined &&
        shouldEndTurn &&
        !hasRetriedOutputSchema
      ) {
        hasRetriedOutputSchema = true
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
          },
          'Agent finished without setting required output, restarting loop',
        )

        // Add system message instructing to use set_output
        const outputSchemaMessage = withSystemTags(
          `You must use the "set_output" tool to provide a result that matches the output schema before ending your turn. The output schema is required for this agent.`,
        )

        currentAgentState.messageHistory = [
          ...currentAgentState.messageHistory,
          userMessage({
            content: outputSchemaMessage,
            keepDuringTruncation: true,
          }),
        ]

        // Reset shouldEndTurn to continue the loop
        shouldEndTurn = false
      }

      // End turn if programmatic step ended turn, or if the previous runAgentStep ended turn
      if (shouldEndTurn) {
        break
      }

      const creditsBefore = currentAgentState.directCreditsUsed
      const childrenBefore = currentAgentState.childRunIds.length

      // Retry transient API errors (e.g. Anthropic 500s) with exponential backoff
      let stepError: unknown
      let stepResult: Awaited<ReturnType<typeof runAgentStep>> | undefined
      // A successful-but-EMPTY step (no content, no tool calls) is treated like a
      // transient failure: it's the classic "stops randomly" symptom of a
      // dropped/truncated provider stream that finished "cleanly". We retry it
      // through the same backoff path, and only surface the give-up warning if
      // it's still empty after exhausting retries.
      let lastAttemptWasEmpty = false
      // Model-fallback ladder for Anthropic 529 (Overloaded): on a confirmed 529 we
      // switch to a sibling Anthropic model, then escalate to GPT-5 if it keeps
      // failing, so the retry doesn't just hit the same overloaded model again.
      //
      // Session-scoped empty-response cooldown: if the template's model dropped a
      // stream earlier in THIS session, it's on a 30-min cooldown, so we START
      // this turn on the next non-cooled rung of the empty-response ladder
      // (e.g. sonnet-4.6 cooled -> start on opus) instead of hitting the same
      // bad model at the top of every turn.
      let currentModel: string = pickStartModelSkippingCooldown(
        clientSessionId,
        agentTemplate.model,
      )
      let modelSwitchNotice: string | undefined
      if (currentModel !== agentTemplate.model) {
        logger.warn(
          {
            preferredModel: agentTemplate.model,
            startModel: currentModel,
            runId,
          },
          'Preferred model is on empty-response cooldown for this session; starting turn on fallback model',
        )
        // Only tell the user once per (session, model) cooldown so we don't spam
        // the transcript at the start of every turn for the full 30 minutes.
        if (shouldNotifyCooldownOnce(clientSessionId, agentTemplate.model)) {
          onResponseChunk(
            `\n⚠️ ${agentTemplate.model} recently returned an empty response in this session and is on cooldown — using ${currentModel} for now.\n\n`,
          )
        }
      }
      for (let retryAttempt = 0; retryAttempt <= MAX_STEP_RETRIES; retryAttempt++) {
        if (retryAttempt > 0) {
          if (signal.aborted) throw new AbortError()
          const baseDelay = Math.min(STEP_RETRY_BASE_DELAY_MS * Math.pow(2, retryAttempt - 1), STEP_RETRY_MAX_DELAY_MS)
          const jitter = 0.8 + Math.random() * 0.4
          const delay = Math.round(baseDelay * jitter)
          const delaySec = Math.round(delay / 1000)
          // Describe *why* we're retrying. This handles both pre-stream errors
          // (which carry a status code) and mid-stream failures like
          // AI_NoOutputGeneratedError / nested-cause overloads, so the user sees
          // a meaningful reason instead of a bare "Transient API error". When the
          // previous attempt returned an empty response (rather than throwing),
          // use an empty-response-specific reason.
          const reason = lastAttemptWasEmpty
            ? 'The model returned an empty response (the provider likely dropped the stream)'
            : describeTransientApiError(stepError)
          logger.warn(
            {
              attempt: retryAttempt + 1,
              maxAttempts: MAX_STEP_RETRIES + 1,
              delayMs: delay,
              modelSwitch: modelSwitchNotice,
              emptyResponse: lastAttemptWasEmpty,
              error: stepError ? getErrorObject(stepError) : undefined,
            },
            'Retrying agent step after transient API error or empty response',
          )
          // The retry-notice CORE ("retrying in Ns (attempt X/Y)") is built via
          // the shared formatRetryNoticeCore so the CLI can parse it (see
          // common/src/constants/retry-notice.ts). It's load-bearing: the CLI
          // detects it to re-arm the stream-activity heartbeat AND to show an
          // honest "retrying (attempt N/M)" indicator during the backoff sleep
          // instead of a misleading "stalled Ns". Keep the core intact.
          const retryNoticeCore = formatRetryNoticeCore(
            delaySec,
            retryAttempt + 1,
            MAX_STEP_RETRIES + 1,
          )
          onResponseChunk(
            modelSwitchNotice
              ? `\n⚠️ ${reason} — ${modelSwitchNotice}, ${retryNoticeCore}...\n\n`
              : `\n⚠️ ${reason}, ${retryNoticeCore}...\n\n`,
          )
          // Only surface the switch notice once per switch.
          modelSwitchNotice = undefined
          await abortableSleep(delay, signal)
          if (signal.aborted) throw new AbortError()
        }
        try {
          stepResult = await runAgentStep({
            ...params,

            agentState: currentAgentState,
            agentTemplate:
              currentModel === agentTemplate.model
                ? agentTemplate
                : { ...agentTemplate, model: currentModel },
            n,
            prompt: currentPrompt,
            runId,
            spawnParams: currentParams,
            // SPARROW: telemetry — forward the loop step number so the
            // agent.step span carries the actual loop counter.
            sparrowStepNumber: totalSteps,
            system,
            tools,
            additionalToolDefinitions: additionalToolDefinitionsWithCache,
          })
          // If the step succeeded but returned an EMPTY response (dropped/
          // truncated stream), retry it through the backoff path instead of
          // ending the turn silently. Clear any prior thrown error so the retry
          // notice uses the empty-response reason.
          if (
            stepResult.isEmptyResponse &&
            retryAttempt < MAX_STEP_RETRIES &&
            !signal.aborted
          ) {
            lastAttemptWasEmpty = true
            stepError = undefined
            // Put the model that just dropped the stream on a session-scoped
            // cooldown so future turns won't start on it for a while.
            recordEmptyResponseCooldown(clientSessionId, currentModel)
            // Switch models on empty (like the 529 ladder): retrying the SAME
            // model that just dropped the stream rarely recovers, so step down
            // the empty-response ladder (sonnet-4.6 -> opus -> gpt-5)
            // so the next attempt hits a different model/capacity pool.
            const fallbackModel = getEmptyResponseFallbackModel(currentModel)
            if (fallbackModel && fallbackModel !== currentModel) {
              logger.warn(
                {
                  fromModel: currentModel,
                  toModel: fallbackModel,
                  attempt: retryAttempt + 1,
                  runId,
                },
                'Empty response (dropped stream) — switching model for retry',
              )
              modelSwitchNotice = `switching to ${fallbackModel}`
              currentModel = fallbackModel
            }
            continue
          }
          break
        } catch (error) {
          stepError = error
          lastAttemptWasEmpty = false
          // Diagnostic: capture the FIRST occurrence of
          // AI_NoOutputGeneratedError (the retry-notice log below only fires on
          // retryAttempt > 0). getErrorObject walks the cause chain to surface
          // statusCode/responseBody, letting us confirm whether this masks a
          // transient 529/overload.
          if (isNoOutputGeneratedError(error)) {
            logger.warn(
              {
                site: 'agent-runtime/loopAgentSteps',
                error: getErrorObject(error),
                transientStatusCode: getTransientStatusCode(error),
                // Report the ACTUAL model used on this attempt (may have been
                // switched by the 529 fallback ladder), not the original template model.
                model: currentModel,
                attempt: retryAttempt + 1,
                runId,
              },
              'AI_NoOutputGeneratedError caught in agent step — dumping cause chain (statusCode/responseBody) to confirm whether it is a transient 529/overload',
            )
          }
          // On a CONFIRMED Anthropic 529 (Overloaded), escalate the model ladder so
          // the next retry uses a different model instead of hitting the same
          // overload. Only fires for a real 529 (walks the cause chain); ambiguous
          // AI_NoOutputGeneratedError without a 529 keeps the same-model retry.
          if (
            getTransientStatusCode(error) === 529 &&
            retryAttempt < MAX_STEP_RETRIES
          ) {
            const fallbackModel = getOverloadFallbackModel(currentModel)
            if (fallbackModel && fallbackModel !== currentModel) {
              logger.warn(
                {
                  fromModel: currentModel,
                  toModel: fallbackModel,
                  attempt: retryAttempt + 1,
                  runId,
                },
                'Anthropic 529 Overloaded — switching model for retry',
              )
              modelSwitchNotice = `provider overloaded on ${currentModel}, switching to ${fallbackModel}`
              currentModel = fallbackModel
            }
          }
          if (
            !signal.aborted &&
            retryAttempt < MAX_STEP_RETRIES &&
            isTransientApiError(error)
          ) {
            continue
          }
          throw error
        }
      }

      const {
        agentState: newAgentState,
        shouldEndTurn: llmShouldEndTurn,
        messageId,
        nResponses: generatedResponses,
        isEmptyResponse,
      } = stepResult!

      // If, after exhausting retries, the step is STILL empty (no content, no
      // tool calls), surface a visible warning + a persistent WARN log instead
      // of ending the turn silently. This is the "gave up after retries" signal.
      if (isEmptyResponse) {
        // The final model was also empty — cool it down for this session too so
        // the next turn doesn't start on it.
        recordEmptyResponseCooldown(clientSessionId, currentModel)
        onResponseChunk(
          '\n⚠️ The model returned an empty response (no content and no tool call) after several retries. This can happen when the provider drops the stream mid-response. Ending the turn — you can continue with `codebuff --continue` or by sending another message.\n\n',
        )
        logger.warn(
          {
            agentType,
            agentId: newAgentState.agentId,
            model: agentTemplate.model,
            runId,
            totalSteps,
            finishReason: 'empty-response',
          },
          'Agent step still returned an empty response after retries; ending the turn',
        )
      }

      if (newAgentState.runId) {
        await addAgentStep({
          ...params,
          agentRunId: newAgentState.runId,
          stepNumber: totalSteps,
          credits: newAgentState.directCreditsUsed - creditsBefore,
          childRunIds: newAgentState.childRunIds.slice(childrenBefore),
          messageId,
          status: 'completed',
          startTime,
        })
      } else {
        logger.error('No runId found for agent state after finishing agent run')
      }

      currentAgentState = newAgentState
      // If the empty-response retry ladder GAVE UP (still empty after all
      // retries), force the turn to end. For agents that require explicit
      // completion (they have `task_completed`), runAgentStep computes
      // shouldEndTurn = hasTaskCompleted = false on an empty response, so
      // without this the turn would NOT end here — it would loop and re-empty
      // until the no-progress guard (MAX_CONSECUTIVE_NO_PROGRESS_STEPS) finally
      // stops it, minutes later. That's the "waiting on provider for 200s"
      // symptom. Ending here also matches the user-facing "Ending the turn"
      // message printed above.
      shouldEndTurn = llmShouldEndTurn || isEmptyResponse
      nResponses = generatedResponses

      currentPrompt = undefined
      currentParams = undefined

      // No-progress nudge: if this step kept the loop alive (didn't end the
      // turn) but made no tool progress, count it. Such a step is the agent
      // producing text/reasoning without yet acting — it's WORKING, so instead
      // of force-quitting (the old behavior at 8 steps) we give it plenty of
      // room and, once it crosses NO_PROGRESS_NUDGE_STEP, inject ONE corrective
      // nudge so it emits an actual tool call or finishes. The runaway backstop
      // is the stepsRemaining ceiling. (Truly-empty steps are handled by the
      // empty-response ladder above, not here.)
      if (!shouldEndTurn && !stepResult!.hadToolProgress) {
        consecutiveNoProgressSteps++
        if (
          !hasNudgedForNoProgress &&
          consecutiveNoProgressSteps >= NO_PROGRESS_NUDGE_STEP
        ) {
          hasNudgedForNoProgress = true
          logger.warn(
            {
              agentType,
              agentId: currentAgentState.agentId,
              model: agentTemplate.model,
              runId,
              totalSteps,
              consecutiveNoProgressSteps,
              finishReason: 'no-progress-nudge',
            },
            'Agent produced many consecutive steps without tool progress; injecting a corrective nudge instead of ending the turn',
          )
          // Subtle, user-visible signal that we prodded the agent. Uses an
          // informational tone (not the alarming ⚠️ reserved for retries/
          // give-ups) so the user knows the agent was nudged to act without it
          // reading as an error. The turn is NOT ended — it keeps going.
          onResponseChunk(
            `\n💭 The agent has gone ${consecutiveNoProgressSteps} steps without using a tool — nudging it to act or finish.\n\n`,
          )
          // Inject the nudge into the message history (so it reaches the model
          // on the very next step); the chunk above is only the user-facing
          // signal and is not part of the model's context.
          // NOTE: agents whose handleSteps run a context-pruner that calls
          // set_messages (a full history REPLACE by contract) before every step
          // will clobber this injected nudge before the model sees it. For such
          // agents the user-visible chunk above is the only signal; the pruner
          // is responsible for preserving important messages if desired.
          currentAgentState.messageHistory = [
            ...currentAgentState.messageHistory,
            userMessage(withSystemTags(NO_PROGRESS_NUDGE_MESSAGE)),
          ]
        }
      } else {
        consecutiveNoProgressSteps = 0
        hasNudgedForNoProgress = false
      }
    }

    if (clearUserPromptMessagesAfterResponse) {
      currentAgentState.messageHistory = expireMessages(
        currentAgentState.messageHistory,
        'userPrompt',
      )
    }

    await finishAgentRun({
      ...params,
      runId,
      status: 'completed',
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
    })

    return {
      agentState: currentAgentState,
      output: getAgentOutput(currentAgentState, agentTemplate),
    }
  } catch (error) {
    // Handle user-initiated aborts separately - don't log as errors
    if (isAbortError(error)) {
      if (clearUserPromptMessagesAfterResponse) {
        currentAgentState.messageHistory = expireMessages(
          currentAgentState.messageHistory,
          'userPrompt',
        )
      }

      currentAgentState.messageHistory = [
        ...currentAgentState.messageHistory,
        userMessage(
          withSystemTags(
            "User interrupted the response. The assistant's previous work has been preserved.",
          ),
        ),
      ]

      logger.info(
        {
          agentType,
          agentId: currentAgentState.agentId,
          runId,
          totalSteps,
          messageHistory: currentAgentState.messageHistory,

        },
        'Agent run cancelled by user (abort error)',
      )

      await finishAgentRun({
        ...params,
        runId,
        status: 'cancelled',
        totalSteps,
        directCredits: currentAgentState.directCreditsUsed,
        totalCredits: currentAgentState.creditsUsed,
      })

      return {
        agentState: currentAgentState,
        output: {
          type: 'error',
          message: 'Run cancelled by user',
        },
      }
    }

    logger.error(
      {
        error: getErrorObject(error),
        agentType,
        displayName: agentTemplate.displayName,
        model: agentTemplate.model ? String(agentTemplate.model) : undefined,
        agentId: currentAgentState.agentId,
        runId,
        totalSteps,
        directCreditsUsed: currentAgentState.directCreditsUsed,
        creditsUsed: currentAgentState.creditsUsed,
        messageHistory: currentAgentState.messageHistory,
        systemPrompt: system,
      },
      `Agent '${agentTemplate.displayName}' (${agentType}) execution failed`,
    )

    let errorMessage = ''
    let errorCode: string | undefined
    let hasServerMessage = false
    if (error instanceof APICallError) {
      errorMessage = `${error.message}`
      const parsed = parseApiErrorResponseBody(error.responseBody)
      if (parsed.errorCode) errorCode = parsed.errorCode
      if (parsed.message) {
        errorMessage = parsed.message
        hasServerMessage = true
      }
    } else {
      // Extract clean error message (just the message, not name:message format)
      errorMessage =
        error instanceof Error
          ? error.message + (error.stack ? `\n\n${error.stack}` : '')
          : getErrorObject(error).message
    }

    const statusCode = getErrorStatusCode(error)

    const status = signal.aborted ? 'cancelled' : 'failed'
    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
      errorMessage,
    })

    // Payment required errors (402) should propagate
    if (statusCode === 402) {
      throw error
    }

    return {
      agentState: currentAgentState,
      output: {
        type: 'error',
        message: hasServerMessage ? errorMessage : `Agent '${agentTemplate.displayName}' (${agentType}) error: ${errorMessage}`,
        ...(statusCode !== undefined && { statusCode }),
        ...(errorCode !== undefined && { error: errorCode }),
      },
    }
  }
    },
  )
}

const NO_PROGRESS_NUDGE_MESSAGE = [
  "You've produced several responses in a row without calling a tool or finishing.",
  'If you intend to use a tool, emit the actual tool call now rather than describing it.',
  'If the task is complete, end your turn using the appropriate completion tool.',
  "If you're blocked, state exactly what you need in order to proceed.",
].join(' ')

const STEP_WARNING_MESSAGE = [
  "I've made quite a few responses in a row.",
  "Let me pause here to make sure we're still on the right track.",
  "Please let me know if you'd like me to continue or if you'd like to guide me in a different direction.",
].join(' ')
