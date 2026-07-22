import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import { toolNames } from '@codebuff/common/tools/constants'
import { parseAgentId } from '@codebuff/common/util/agent-id-parsing'
import { getErrorObject, getErrorStatusCode, isAbortError } from '@codebuff/common/util/error'
import { generateCompactId } from '@codebuff/common/util/string'

import { loopAgentSteps } from '../../../run-agent-step'
import { getAgentTemplate } from '../../../templates/agent-registry'
import {
  filterUnfinishedToolCalls,
  withSystemTags,
} from '../../../util/messages'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  ParamsExcluding,
  OptionalFields,
} from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  AgentState,
  AgentTemplateType,
  Subgoal,
} from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

/**
 * Common context params needed for spawning subagents.
 * These are the params that don't change between different spawn calls
 * and are passed through from the parent agent runtime.
 */
export type SubagentContextParams = AgentRuntimeDeps &
  AgentRuntimeScopedDeps & {
    clientSessionId: string
    costMode?: string
    fileContext: ProjectFileContext
    localAgentTemplates: Record<string, AgentTemplate>
    repoId: string | undefined
    repoUrl: string | undefined
    signal: AbortSignal
    userId: string | undefined
  }

/**
 * Extracts the common context params needed for spawning subagents.
 * This avoids bugs from spreading all params with `...params` which can
 * accidentally pass through params that should be overridden.
 */
export function extractSubagentContextParams(
  params: SubagentContextParams,
): SubagentContextParams {
  return {
    // AgentRuntimeDeps - Environment
    clientEnv: params.clientEnv,
    ciEnv: params.ciEnv,
    // AgentRuntimeDeps - Database
    getUserInfoFromApiKey: params.getUserInfoFromApiKey,
    fetchAgentFromDatabase: params.fetchAgentFromDatabase,
    startAgentRun: params.startAgentRun,
    finishAgentRun: params.finishAgentRun,
    addAgentStep: params.addAgentStep,
    // AgentRuntimeDeps - Billing
    consumeCreditsWithFallback: params.consumeCreditsWithFallback,
    // AgentRuntimeDeps - LLM
    promptAiSdkStream: params.promptAiSdkStream,
    promptAiSdk: params.promptAiSdk,
    promptAiSdkStructured: params.promptAiSdkStructured,
    // AgentRuntimeDeps - Mutable State
    databaseAgentCache: params.databaseAgentCache,
    // AgentRuntimeDeps - Analytics
    trackEvent: params.trackEvent,
    // AgentRuntimeDeps - Other
    logger: params.logger,
    fetch: params.fetch,

    // AgentRuntimeDeps - Subagent lifecycle hooks
    onBeforeSubagentPrompt: params.onBeforeSubagentPrompt,
    onAfterSubagentComplete: params.onAfterSubagentComplete,

    // AgentRuntimeScopedDeps - Client (WebSocket)
    handleStepsLogChunk: params.handleStepsLogChunk,
    requestToolCall: params.requestToolCall,
    requestMcpToolData: params.requestMcpToolData,
    requestFiles: params.requestFiles,
    requestOptionalFile: params.requestOptionalFile,
    sendAction: params.sendAction,
    sendSubagentChunk: params.sendSubagentChunk,
    apiKey: params.apiKey,

    // Core context params
    clientSessionId: params.clientSessionId,
    costMode: params.costMode,
    fileContext: params.fileContext,
    localAgentTemplates: params.localAgentTemplates,
    repoId: params.repoId,
    repoUrl: params.repoUrl,
    signal: params.signal,
    userId: params.userId,
  }
}

/**
 * The separator used in user-facing agent `toolNames` to reference a specific
 * MCP tool, e.g. 'sparrow/list_tables'. This is intentionally '/' and NOT the
 * internal `MCP_TOOL_SEPARATOR` ('__'): agent templates declare their tools
 * with '/', and getMCPToolData parses them with the same '/' separator (see
 * `USER_INPUT_SEPARATOR` in mcp.ts) before rewriting them to the internal '__'
 * form for LLM API compatibility.
 */
const MCP_TOOLNAME_SEPARATOR = '/'

/**
 * Extracts the set of MCP server names an agent references in its toolNames.
 *
 * MCP tool names use '/' as the server/tool separator (e.g. 'sparrow/list_tables'),
 * so the server name is the prefix before the first '/'. Non-MCP tool names
 * (built-ins like 'read_files') have no '/' and are ignored.
 *
 * Used to decide which of a parent's MCP servers a subagent opts into inheriting.
 */
export function getReferencedMcpServers(
  toolNames: readonly string[],
): Set<string> {
  const servers = new Set<string>()
  for (const t of toolNames) {
    const separatorIndex = t.indexOf(MCP_TOOLNAME_SEPARATOR)
    if (separatorIndex > 0) {
      servers.add(t.slice(0, separatorIndex))
    }
  }
  return servers
}

/**
 * Checks if a parent agent is allowed to spawn a child agent
 */
export function getMatchingSpawn(
  spawnableAgents: AgentTemplateType[],
  childFullAgentId: string,
) {
  const {
    publisherId: childPublisherId,
    agentId: childAgentId,
    version: childVersion,
  } = parseAgentId(childFullAgentId)

  if (!childAgentId) {
    return null
  }

  for (const spawnableAgent of spawnableAgents) {
    const {
      publisherId: spawnablePublisherId,
      agentId: spawnableAgentId,
      version: spawnableVersion,
    } = parseAgentId(spawnableAgent)

    if (!spawnableAgentId) {
      continue
    }

    if (
      spawnableAgentId === childAgentId &&
      spawnablePublisherId === childPublisherId &&
      spawnableVersion === childVersion
    ) {
      return spawnableAgent
    }
    if (!childVersion && childPublisherId) {
      if (
        spawnablePublisherId === childPublisherId &&
        spawnableAgentId === childAgentId
      ) {
        return spawnableAgent
      }
    }
    if (!childPublisherId && childVersion) {
      if (
        spawnableAgentId === childAgentId &&
        spawnableVersion === childVersion
      ) {
        return spawnableAgent
      }
    }

    if (!childVersion && !childPublisherId) {
      if (spawnableAgentId === childAgentId) {
        return spawnableAgent
      }
    }
  }
  return null
}

/**
 * Synchronously transforms spawn_agents input to use 'commander-lite' instead of 'commander'
 * when the parent agent doesn't have access to 'commander' but does have access to 'commander-lite'.
 * This should be called BEFORE the tool call is streamed to the UI.
 */
export function transformSpawnAgentsInput(
  input: Record<string, unknown>,
  spawnableAgents: AgentTemplateType[],
): Record<string, unknown> {
  const agents = input.agents
  if (!Array.isArray(agents)) {
    return input
  }

  let hasTransformation = false
  const transformedAgents = agents.map((agent) => {
    if (typeof agent !== 'object' || agent === null) {
      return agent
    }

    const agentEntry = agent as Record<string, unknown>
    const agentTypeStr = agentEntry.agent_type
    if (typeof agentTypeStr !== 'string') {
      return agent
    }

    // Check if this is 'commander'
    const { agentId } = parseAgentId(agentTypeStr)
    if (agentId !== 'commander') {
      return agent
    }

    // Check if 'commander' is available in spawnableAgents
    const commanderType = getMatchingSpawn(spawnableAgents, agentTypeStr)
    if (commanderType) {
      // Commander is available, no transformation needed
      return agent
    }

    // Check if 'commander-lite' is available as a fallback
    const commanderLiteType = getMatchingSpawn(spawnableAgents, 'commander-lite')
    if (!commanderLiteType) {
      // Neither available, let validation handle the error
      return agent
    }

    // Transform commander -> commander-lite
    hasTransformation = true
    return {
      ...agentEntry,
      agent_type: commanderLiteType,
    }
  })

  if (!hasTransformation) {
    return input
  }

  return {
    ...input,
    agents: transformedAgents,
  }
}

/**
 * Validates agent template and permissions
 */
export async function validateAndGetAgentTemplate(
  params: {
    agentTypeStr: string
    parentAgentTemplate: AgentTemplate
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
  } & ParamsExcluding<typeof getAgentTemplate, 'agentId'>,
): Promise<{ agentTemplate: AgentTemplate; agentType: string }> {
  const { agentTypeStr, parentAgentTemplate } = params
  const agentTemplate = await getAgentTemplate({
    ...params,
    agentId: agentTypeStr,
  })

  if (!agentTemplate) {
    if (toolNames.includes(agentTypeStr as any)) {
      throw new Error(
        `"${agentTypeStr}" is a tool, not an agent. Call it directly as a tool instead of wrapping it in spawn_agents.`,
      )
    }
    throw new Error(`Agent type ${agentTypeStr} not found.`)
  }

  // Subagents inherit the parent's MCP servers CONFIG so they can reach the
  // same MCP tools (e.g. an OAuth server the user authenticated at the top
  // level) using the parent's on-disk tokens + the shared process-level MCP
  // client cache.
  //
  // BUT a subagent must OPT IN to which inherited servers it wants, by naming at
  // least one of that server's tools in its own toolNames (e.g. 'sparrow/list_tables').
  // getMCPToolData loads ALL of a configured server's tools into the agent's
  // context, so blindly inheriting every parent server would flood tool-less
  // subagents (e.g. context-pruner) with hundreds of tool definitions they will
  // never use. Top-level agents get their mcpServers from the mcp.json merge
  // (not this inheritance path), so they still receive all tools.
  //
  // The child's OWN directly-declared mcpServers are always kept (and win on key
  // conflicts). We only filter the servers INHERITED from the parent.
  //
  // The agent-runtime tool path is non-interactive (getMcpOAuthOptions in the
  // SDK returns interactive:false): subagents reuse the parent's on-disk tokens
  // and never launch a browser. We clone rather than mutate because
  // getAgentTemplate may return a cached template shared across runs.
  const referencedMcpServers = getReferencedMcpServers(
    agentTemplate.toolNames ?? [],
  )
  // Agents with search_mcp_tools need ALL parent MCP servers so they can
  // search through all available tools. For other agents, only inherit
  // servers whose tools are explicitly referenced in the child's toolNames.
  const hasSearchMcpTools = (agentTemplate.toolNames ?? []).includes('search_mcp_tools')
  const inheritedMcpServers = hasSearchMcpTools
    ? { ...parentAgentTemplate.mcpServers }
    : Object.fromEntries(
        Object.entries(parentAgentTemplate.mcpServers ?? {}).filter(
          ([serverName]) => referencedMcpServers.has(serverName),
        ),
      )
  //
  // spawnableAgents resolution: if the child agent explicitly declares its own
  // spawnableAgents list, use ONLY those. Inheriting the union of parent+child
  // caused massive token bloat — e.g. a parent with 35 agents would inject all
  // 35 into a child that only needs 4, adding ~100k tokens of agent tool
  // definitions on every step. Agents that declare no spawnableAgents of their
  // own fall back to the parent's list (backward-compat for agents that rely on
  // implicit inheritance). BASE_AGENTS bypass below is deliberately NOT
  // inherited, so there is no privilege escalation.
  const childSpawnableAgents =
    agentTemplate.spawnableAgents && agentTemplate.spawnableAgents.length > 0
      ? agentTemplate.spawnableAgents
      : (parentAgentTemplate.spawnableAgents ?? [])
  const mergedAgentTemplate: AgentTemplate = {
    ...agentTemplate,
    mcpServers: {
      ...inheritedMcpServers,
      ...agentTemplate.mcpServers,
    },
    spawnableAgents: childSpawnableAgents,
  }

  const BASE_AGENTS = ['base', 'base-free', 'base-max', 'base-experimental']
  // Base agent can spawn any agent
  if (BASE_AGENTS.includes(parentAgentTemplate.id)) {
    return { agentTemplate: mergedAgentTemplate, agentType: agentTypeStr }
  }

  const agentType = getMatchingSpawn(
    parentAgentTemplate.spawnableAgents,
    agentTypeStr,
  )
  if (!agentType) {
    throw new Error(
      `Agent type ${parentAgentTemplate.id} is not allowed to spawn child agent type ${agentTypeStr}.`,
    )
  }

  return { agentTemplate: mergedAgentTemplate, agentType }
}

/**
 * Validates prompt and params against agent schema
 */
export function validateAgentInput(
  agentTemplate: AgentTemplate,
  agentType: string,
  prompt?: string,
  params?: any,
): void {
  const { inputSchema } = agentTemplate

  // Validate prompt requirement
  if (inputSchema.prompt) {
    const result = inputSchema.prompt.safeParse(prompt ?? '')
    if (!result.success) {
      throw new Error(
        `Invalid prompt for agent ${agentType}: ${JSON.stringify(result.error.issues, null, 2)}`,
      )
    }
  }

  // Validate params if schema exists
  if (inputSchema.params) {
    const result = inputSchema.params.safeParse(params ?? {})
    if (!result.success) {
      throw new Error(
        `Invalid params for agent ${agentType}: ${JSON.stringify(result.error.issues, null, 2)}`,
      )
    }
  }
}

/**
 * Creates a new agent state for spawned agents
 */
export function createAgentState(
  agentType: string,
  agentTemplate: AgentTemplate,
  parentAgentState: AgentState,
  agentContext: Record<string, Subgoal>,
): AgentState {
  const agentId = generateCompactId()

  // When including message history, filter out any tool calls that don't have
  // corresponding tool responses. This prevents the spawned agent from seeing
  // unfinished tool calls which throw errors in the Anthropic API.
  let messageHistory: Message[] = []

  if (agentTemplate.includeMessageHistory) {
    messageHistory = filterUnfinishedToolCalls(parentAgentState.messageHistory)
    messageHistory.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: withSystemTags(`Subagent ${agentType} has been spawned.`),
        },
      ],
      tags: ['SUBAGENT_SPAWN'],
    })
  }

  return {
    agentId,
    agentType,
    agentContext,
    ancestorRunIds: [
      ...parentAgentState.ancestorRunIds,
      parentAgentState.runId ?? 'NULL',
    ],
    subagents: [],
    childRunIds: [],
    messageHistory,
    stepsRemaining: MAX_AGENT_STEPS_DEFAULT,
    creditsUsed: 0,
    directCreditsUsed: 0,
    output: undefined,
    parentId: parentAgentState.agentId,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: parentAgentState.contextTokenCount,
  }
}

/**
 * Logs agent spawn information
 */
export function logAgentSpawn(params: {
  agentTemplate: AgentTemplate
  agentType: string
  agentId: string
  parentId: string | undefined
  prompt?: string
  spawnParams?: any
  inline?: boolean
  logger: Logger
}): void {
  const {
    agentTemplate,
    agentType,
    agentId,
    parentId,
    prompt,
    spawnParams,
    inline = false,
    logger,
  } = params
  logger.debug(
    {
      agentTemplate,
      prompt,
      params: spawnParams,
      agentId,
      parentId,
    },
    `Spawning agent${inline ? ' inline' : ''} — ${agentType} (${agentId})`,
  )
}

/**
 * Error thrown when a spawned subagent exceeds its allotted wall-clock time.
 * Distinct from AbortError (user-initiated cancellation) so callers can treat a
 * timeout as a per-subagent failure to report, rather than a propagating abort.
 */
export class SubagentTimeoutError extends Error {
  /**
   * The (possibly partially-progressed) state of the timed-out subagent, so the
   * parent's cost-aggregation can recover any credits it consumed before the
   * timeout. Matches the `agentState` attached to normal subagent failures.
   */
  agentState?: AgentState

  constructor(timeoutMs: number, agentType: string, agentState?: AgentState) {
    super(
      `Subagent '${agentType}' timed out after ${Math.round(timeoutMs / 1000)}s and was aborted`,
    )
    this.name = 'SubagentTimeoutError'
    this.agentState = agentState
  }
}

/**
 * Runs a subagent with a per-subagent timeout and hang detection.
 *
 * Creates a child AbortController linked to the parent signal and passes its
 * signal to `run`. If `run` does not settle within `timeoutMs`, the child is
 * aborted (best-effort cancellation of the underlying LLM stream / work) and a
 * {@link SubagentTimeoutError} is thrown. This guarantees the parent's fan-out
 * join always makes progress even if a subagent's model client stalls without
 * erroring.
 *
 * The child signal also fires when the parent signal aborts (e.g. user
 * interrupt), so callers can use it for both abort and retry decisions.
 *
 * `onTimeout` is invoked once, synchronously inside the timeout handler (after
 * the child is aborted, before the rejection). Callers use it to emit a
 * `subagent_finish` event so the UI never shows a dangling 'started' subagent
 * when a timeout fires — we can't rely on the aborted run to emit it, since a
 * truly hung run may never observe the abort.
 *
 * `getAgentState` (if provided) is read at timeout time to attach the
 * currently-active subagent state to the {@link SubagentTimeoutError}, so the
 * parent's cost-aggregation can recover partial credits used before the timeout.
 */
export async function runWithSubagentTimeout<T>(params: {
  parentSignal: AbortSignal
  timeoutMs: number
  agentType: string
  logger: Logger
  run: (childSignal: AbortSignal) => Promise<T>
  onTimeout?: () => void
  getAgentState?: () => AgentState | undefined
}): Promise<T> {
  const { parentSignal, timeoutMs, agentType, logger, run, onTimeout, getAgentState } =
    params
  const childController = new AbortController()

  const onParentAbort = () => childController.abort()
  if (parentSignal.aborted) {
    childController.abort()
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      // Best-effort: abort the underlying work first so it stops consuming
      // resources, then log and reject.
      childController.abort()
      logger.error(
        { agentType, timeoutMs },
        `Subagent '${agentType}' exceeded ${Math.round(timeoutMs / 1000)}s timeout — aborted and reporting as failed`,
      )
      // Emit a subagent_finish so the UI doesn't show a dangling 'started'
      // subagent. A truly hung run may never observe the abort, so we can't
      // rely on the run's own finish/error path to fire.
      try {
        onTimeout?.()
      } catch (e) {
        logger.warn(
          { agentType, error: e instanceof Error ? e.message : String(e) },
          'onTimeout callback failed',
        )
      }
      reject(new SubagentTimeoutError(timeoutMs, agentType, getAgentState?.()))
    }, timeoutMs)
  })

  // The losing branch of the Promise.race below is never awaited. If `run` later
  // rejects (e.g. the aborted subagent surfaces an AbortError after the timeout
  // has already won the race), swallow it here so it doesn't bubble up as an
  // unhandled promise rejection.
  const runPromise = run(childController.signal)
  runPromise.catch(() => {})

  try {
    return await Promise.race([runPromise, timeoutPromise])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    parentSignal.removeEventListener('abort', onParentAbort)
  }
}

/**
 * Executes a subagent using loopAgentSteps
 */
export async function executeSubagent(
  options: OptionalFields<
    {
      agentTemplate: AgentTemplate
      parentAgentState: AgentState
      parentTools?: ToolSet
      onResponseChunk: (chunk: string | PrintModeEvent) => void
      isOnlyChild?: boolean
      ancestorRunIds: string[]
    } & ParamsExcluding<typeof loopAgentSteps, 'agentType' | 'ancestorRunIds'>,
    'isOnlyChild' | 'clearUserPromptMessagesAfterResponse'
  >,
) {
  const withDefaults = {
    isOnlyChild: false,
    clearUserPromptMessagesAfterResponse: true,
    ...options,
  }
  const {
    onResponseChunk,
    agentTemplate,
    parentAgentState,
    isOnlyChild,
    ancestorRunIds,
    prompt,
    spawnParams,
  } = withDefaults

  const modelStr = agentTemplate.model ? String(agentTemplate.model) : undefined

  const startEvent = {
    type: 'subagent_start' as const,
    agentId: withDefaults.agentState.agentId,
    agentType: agentTemplate.id,
    displayName: agentTemplate.displayName,
    model: modelStr,
    onlyChild: isOnlyChild,
    parentAgentId: parentAgentState.agentId,
    prompt,
    params: spawnParams,
  }
  onResponseChunk(startEvent)

  // Note: elapsedMs includes onBeforeSubagentPrompt latency (e.g. hippo context fetch) + subagent execution time
  const subagentStartTime = Date.now()

  // Enrich prompt via lifecycle hook (e.g. hippo context injection)
  let effectivePrompt = prompt
  if (withDefaults.onBeforeSubagentPrompt) {
    try {
      const enrichment = await withDefaults.onBeforeSubagentPrompt({
        agentType: agentTemplate.id,
        prompt: prompt ?? '',
      })
      if (enrichment?.enrichedPrompt) {
        effectivePrompt = enrichment.enrichedPrompt
      }
    } catch (e) {
      withDefaults.logger.warn({ error: e instanceof Error ? e.message : String(e), agentType: agentTemplate.id }, 'onBeforeSubagentPrompt hook failed')
    }
  }

  let result: Awaited<ReturnType<typeof loopAgentSteps>>
  try {
    result = await loopAgentSteps({
      ...withDefaults,
      prompt: effectivePrompt,
      // Don't propagate parent's image content to subagents.
      // If subagents need to see images, they get them through includeMessageHistory,
      // not by creating new image-containing messages for their prompts.
      content: undefined,
      ancestorRunIds: [...ancestorRunIds, parentAgentState.runId ?? ''],
      agentType: agentTemplate.id,
    })
  } catch (error) {
    // Emit subagent_finish so the UI doesn't show a dangling started agent
    onResponseChunk({
      type: 'subagent_finish',
      agentId: withDefaults.agentState.agentId,
      agentType: agentTemplate.id,
      displayName: agentTemplate.displayName,
      model: modelStr,
      onlyChild: isOnlyChild,
      parentAgentId: parentAgentState.agentId,
      prompt,
      params: spawnParams,
    })

    // Don't wrap AbortErrors — they must propagate for abort detection
    if (isAbortError(error)) throw error

    const errorInfo = getErrorObject(error)
    withDefaults.logger.error(
      {
        error: errorInfo,
        agentId: withDefaults.agentState.agentId,
        agentType: agentTemplate.id,
        displayName: agentTemplate.displayName,
        model: modelStr,
        parentAgentId: parentAgentState.agentId,
      },
      `Subagent '${agentTemplate.displayName}' (${agentTemplate.id}, model: ${agentTemplate.model ?? 'unknown'}) failed`,
    )
    const enriched = new Error(
      `Agent '${agentTemplate.displayName}' (${agentTemplate.id}, model: ${agentTemplate.model ?? 'unknown'}) failed: ${errorInfo.message}`,
    )
    enriched.cause = error
    // Preserve status code for retry logic in callers
    const statusCode = getErrorStatusCode(error)
    if (typeof statusCode === 'number') {
      ;(enriched as Error & { statusCode: number }).statusCode = statusCode
    }
    // Attach agent state so callers can recover partial costs from failed subagents
    ;(enriched as Error & { agentState: AgentState }).agentState = withDefaults.agentState

    // Fire-and-forget: notify lifecycle hook about failure
    withDefaults.onAfterSubagentComplete?.({
      agentType: agentTemplate.id,
      prompt: prompt ?? '',
      output: { type: 'error', message: errorInfo.message },
      elapsedMs: Date.now() - subagentStartTime,
    })?.catch((e) => withDefaults.logger.warn(
      { error: e instanceof Error ? e.message : String(e), agentType: agentTemplate.id },
      'onAfterSubagentComplete hook failed',
    ))

    throw enriched
  }

  onResponseChunk({
    type: 'subagent_finish',
    agentId: result.agentState.agentId,
    agentType: agentTemplate.id,
    displayName: agentTemplate.displayName,
    model: modelStr,
    onlyChild: isOnlyChild,
    parentAgentId: parentAgentState.agentId,
    prompt,
    params: spawnParams,
  })

  // Fire-and-forget: notify lifecycle hook about completion
  withDefaults.onAfterSubagentComplete?.({
    agentType: agentTemplate.id,
    prompt: prompt ?? '',
    output: result.output,
    elapsedMs: Date.now() - subagentStartTime,
  })?.catch((e) => withDefaults.logger.warn(
    { error: e instanceof Error ? e.message : String(e), agentType: agentTemplate.id },
    'onAfterSubagentComplete hook failed',
  ))

  if (result.agentState.runId) {
    parentAgentState.childRunIds.push(result.agentState.runId)
  }

  return result
}
