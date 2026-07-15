// SPARROW: telemetry — open tool.call spans around tool dispatch
import { recordToolCall } from '@codebuff/common/sparrow/telemetry'
import { endsAgentStepParam, toolNames } from '@codebuff/common/tools/constants'
import { toolParams } from '@codebuff/common/tools/list'
import { generateCompactId } from '@codebuff/common/util/string'
import { cloneDeep } from 'lodash'

import { getMCPToolData } from '../mcp'
import { MCP_TOOL_SEPARATOR } from '../mcp-constants'
import { getAgentShortName } from '../templates/prompts'
import { codebuffToolHandlers } from './handlers/list'
import {
  getMatchingSpawn,
  transformSpawnAgentsInput,
} from './handlers/tool/spawn-agent-utils'
import { getAgentTemplate } from '../templates/agent-registry'
import { ensureZodSchema } from './prompts'


import type { AgentTemplate } from '../templates/types'
import type { CodebuffToolHandlerFunction } from './handlers/handler-function-type'
import type { FileProcessingState } from './handlers/tool/write-file'
import type { ToolName } from '@codebuff/common/tools/constants'
import type {
  ClientToolCall,
  ClientToolName,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentTemplateType, AgentState, Subgoal } from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'
import type { ToolCallPart, ToolSet } from 'ai'

export type CustomToolCall = {
  toolName: string
  input: Record<string, unknown>
} & Omit<ToolCallPart, 'type'>

// SPARROW: Extract the agent_type(s) from a spawn_agents tool input so the
// tool.call span can link the parent tool invocation to its child agent runs.
// Returns a comma-separated list when multiple agents are spawned, or undefined
// if the input doesn't look like a spawn_agents call.
function sparrowChildAgentIdsFromSpawn(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== 'spawn_agents') return undefined
  const agents = (input as { agents?: Array<{ agent_type?: unknown }> }).agents
  if (!Array.isArray(agents) || agents.length === 0) return undefined
  const types = agents
    .map((a) => a?.agent_type)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
  return types.length > 0 ? types.join(',') : undefined
}

export type ToolCallError = {
  toolName?: string
  input: Record<string, unknown>
  error: string
} & Pick<CodebuffToolCall, 'toolCallId'>

export function parseRawToolCall<T extends ToolName = ToolName>(params: {
  rawToolCall: {
    toolName: T
    toolCallId: string
    input: Record<string, unknown>
  }
}): CodebuffToolCall<T> | ToolCallError {
  const { rawToolCall } = params
  const toolName = rawToolCall.toolName

  const processedParameters = rawToolCall.input
  const paramsSchema = toolParams[toolName].inputSchema

  const result = paramsSchema.safeParse(processedParameters)

  if (!result.success) {
    return {
      toolName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Invalid parameters for ${toolName}: ${JSON.stringify(
        result.error.issues,
        null,
        2,
      )}`,
    }
  }

  if (endsAgentStepParam in result.data) {
    delete result.data[endsAgentStepParam]
  }

  return {
    toolName,
    input: result.data,
    toolCallId: rawToolCall.toolCallId,
  } as CodebuffToolCall<T>
}

export type ExecuteToolCallParams<T extends string = ToolName> = {
  toolName: T
  input: Record<string, unknown>
  autoInsertEndStepParam?: boolean
  excludeToolFromMessageHistory?: boolean

  agentContext: Record<string, Subgoal>
  agentState: AgentState
  agentStepId: string
  ancestorRunIds: string[]
  agentTemplate: AgentTemplate
  clientSessionId: string
  fileContext: ProjectFileContext
  fileProcessingState: FileProcessingState
  fingerprintId: string
  fromHandleSteps?: boolean
  fullResponse: string
  localAgentTemplates: Record<string, AgentTemplate>
  logger: Logger
  previousToolCallFinished: Promise<void>
  prompt: string | undefined
  repoId: string | undefined
  repoUrl: string | undefined
  runId: string
  signal: AbortSignal
  system: string
  tools: ToolSet
  toolCallId: string | undefined
  toolCalls: (CodebuffToolCall | CustomToolCall)[]
  toolCallsToAddToMessageHistory: (CodebuffToolCall | CustomToolCall)[]
  toolResults: ToolMessage[]
  toolResultsToAddToMessageHistory: ToolMessage[]
  userId: string | undefined
  userInputId: string

  fetch: typeof globalThis.fetch
  onCostCalculated: (credits: number) => Promise<void>
  onResponseChunk: (chunk: string | PrintModeEvent) => void
} & AgentRuntimeDeps &
  AgentRuntimeScopedDeps

export async function executeToolCall<T extends ToolName>(
  params: ExecuteToolCallParams<T>,
): Promise<void> {
  const {
    toolName,
    input,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    logger,
    previousToolCallFinished,
    toolCalls,
    toolCallsToAddToMessageHistory,
    toolResults,
    toolResultsToAddToMessageHistory,
    userInputId,

    onCostCalculated,
    onResponseChunk,
    requestToolCall,
  } = params
  const toolCallId = params.toolCallId ?? generateCompactId()

  const toolCall: CodebuffToolCall<T> | ToolCallError = parseRawToolCall<T>({
    rawToolCall: {
      toolName,
      toolCallId,
      input,
    },
  })

  // Filter out restricted tools - emit error instead of tool call/result
  // This prevents the CLI from showing tool calls that the agent doesn't have permission to use
  if (
    toolCall.toolName &&
    !agentTemplate.toolNames.includes(toolCall.toolName) &&
    !fromHandleSteps
  ) {
    // Emit an error event instead of tool call/result pair
    // The stream parser will convert this to a user message for proper API compliance
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` is not currently available. Make sure to only use tools provided at the start of the conversation AND that you most recently have permission to use.`,
    })
    return previousToolCallFinished
  }

  if ('error' in toolCall) {
    onResponseChunk({
      type: 'error',
      message: toolCall.error,
    })
    logger.debug(
      { toolCall, error: toolCall.error },
      `${toolName} error: ${toolCall.error}`,
    )
    return previousToolCallFinished
  }

  // Transform spawn_agents input to use commander-lite fallback before streaming
  // This ensures the UI shows the correct agent type from the start
  const transformedInput =
    toolName === 'spawn_agents'
      ? transformSpawnAgentsInput(input, agentTemplate.spawnableAgents)
      : input

  // TODO: Allow tools to provide a validation function, and move this logic into the spawn_agents validation function.
  // Pre-validate spawn_agents to filter out non-existent agents before streaming
  let effectiveInput = transformedInput
  if (toolName === 'spawn_agents') {
    const agents = (transformedInput as Record<string, unknown>).agents
    if (Array.isArray(agents)) {
      const BASE_AGENTS = [
        'base',
        'base-free',
        'base-max',
        'base-experimental',
      ]
      const isBaseAgent = BASE_AGENTS.includes(agentTemplate.id)

      const validationResults = await Promise.allSettled(
        agents.map(async (agent) => {
          if (!agent || typeof agent !== 'object') {
            return { valid: false as const, error: 'Invalid agent entry' }
          }
          const agentTypeStr = (agent as Record<string, unknown>).agent_type
          if (typeof agentTypeStr !== 'string' || !agentTypeStr) {
            return { valid: false as const, error: 'Agent entry missing agent_type' }
          }

          if (!isBaseAgent) {
            const matchingSpawn = getMatchingSpawn(
              agentTemplate.spawnableAgents,
              agentTypeStr,
            )
            if (!matchingSpawn) {
              if (toolNames.includes(agentTypeStr as ToolName)) {
                return { valid: false as const, error: `"${agentTypeStr}" is a tool, not an agent. Call it directly as a tool instead of wrapping it in spawn_agents.` }
              }
              return { valid: false as const, error: `Agent "${agentTypeStr}" is not available to spawn` }
            }
          }

          try {
            const template = await getAgentTemplate({
              agentId: agentTypeStr,
              localAgentTemplates: params.localAgentTemplates,
              fetchAgentFromDatabase: params.fetchAgentFromDatabase,
              databaseAgentCache: params.databaseAgentCache,
              logger,
              apiKey: params.apiKey,
            })
            if (!template) {
              if (toolNames.includes(agentTypeStr as ToolName)) {
                return { valid: false as const, error: `"${agentTypeStr}" is a tool, not an agent. Call it directly as a tool instead of wrapping it in spawn_agents.` }
              }
              return { valid: false as const, error: `Agent "${agentTypeStr}" does not exist` }
            }
          } catch {
            return { valid: false as const, error: `Agent "${agentTypeStr}" could not be loaded` }
          }

          return { valid: true as const, agent }
        }),
      )

      const validAgents: unknown[] = []
      const errors: string[] = []

      for (const result of validationResults) {
        if (result.status === 'rejected') {
          errors.push('Agent validation failed unexpectedly')
        } else if (result.value.valid) {
          validAgents.push(result.value.agent)
        } else {
          errors.push(result.value.error)
        }
      }

      if (errors.length > 0) {
        if (validAgents.length === 0) {
          const errorMsg = `Failed to spawn agents: ${errors.join('; ')}`
          onResponseChunk({ type: 'error', message: errorMsg })
          logger.debug(
            { toolName, errors },
            'All agents in spawn_agents are invalid, not streaming tool call',
          )
          return previousToolCallFinished
        }
        const errorMsg = `Some agents could not be spawned: ${errors.join('; ')}. Proceeding with valid agents only.`
        onResponseChunk({ type: 'error', message: errorMsg })
        effectiveInput = { ...transformedInput, agents: validAgents }
      }
    }
  }

  // Only emit tool_call event after permission check passes
  onResponseChunk({
    type: 'tool_call',
    toolCallId,
    toolName,
    input: effectiveInput,
    agentId: agentState.agentId,
    parentAgentId: agentState.parentId,
    includeToolCall: !excludeToolFromMessageHistory,
  })

  // Cast to any to avoid type errors
  const handler = codebuffToolHandlers[
    toolName
  ] as unknown as CodebuffToolHandlerFunction<T>

  // Use effective input for spawn_agents so the handler receives the correct agent types
  const finalToolCall =
    toolName === 'spawn_agents'
      ? { ...toolCall, input: effectiveInput }
      : toolCall

  toolCalls.push(finalToolCall)
  if (!excludeToolFromMessageHistory) {
    toolCallsToAddToMessageHistory.push(finalToolCall)
  }

  // SPARROW: open tool.call span around the handler invocation. For
  // spawn_agents calls, record the list of agent_type values as child linkage
  // so the span tree connects the parent tool call to the spawned agent.run
  // spans. `recordToolCall.finish` is idempotent so success/failure paths
  // can each call it without double-finishing.
  const sparrowToolSpan = recordToolCall({
    toolName,
    input: effectiveInput,
    childAgentId: sparrowChildAgentIdsFromSpawn(toolName, effectiveInput),
  })

  const toolResultPromise = handler({
    ...params,
    toolCall: finalToolCall,
    previousToolCallFinished,
    writeToClient: onResponseChunk,
    requestClientToolCall: (async (
      clientToolCall: ClientToolCall<T extends ClientToolName ? T : never>,
    ) => {
      if (params.signal.aborted) {
        return []
      }

      const clientToolResult = await requestToolCall({
        userInputId,
        toolName: clientToolCall.toolName,
        input: clientToolCall.input,
      })
      return clientToolResult.output as CodebuffToolOutput<T>
    }) as any,
  })

  return toolResultPromise.then(
    async ({ output, creditsUsed }) => {
      const toolResult: ToolMessage = {
        role: 'tool',
        toolName,
        toolCallId: toolCall.toolCallId,
        content: output,
      }

      onResponseChunk({
        type: 'tool_result',
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        output: toolResult.content,
      })

      toolResults.push(toolResult)

      if (!excludeToolFromMessageHistory) {
        toolResultsToAddToMessageHistory.push(toolResult)
      }

      // After tool completes, resolve any pending creditsUsed promise
      if (creditsUsed) {
        onCostCalculated(creditsUsed)
        logger.debug(
          { credits: creditsUsed, totalCredits: agentState.creditsUsed },
          `Added ${creditsUsed} credits from ${toolName} to agent state`,
        )
      }

      // SPARROW: finish tool.call span on success with the tool's output.
      sparrowToolSpan.finish({ success: true, output })
    },
    (error) => {
      // SPARROW: finish tool.call span on failure. We re-throw to preserve
      // existing error semantics for callers awaiting this promise.
      sparrowToolSpan.finish({ success: false, error })
      throw error
    },
  )
}

/**
 * Coerces a single value to the type declared by a JSON Schema property definition.
 * Handles numbers, booleans, arrays, and objects — including string-encoded variants.
 * Recurses into nested object properties and array items, and handles JSON Schema
 * composition keywords (anyOf, oneOf, allOf).
 */
function coerceValue(value: unknown, propSchema: Record<string, unknown>): unknown {
  const type = propSchema.type as string | string[] | undefined
  const types = Array.isArray(type) ? type : type ? [type] : []

  // When no explicit `type` is declared, try JSON Schema composition keywords.
  if (types.length === 0) {
    // allOf: apply each sub-schema sequentially (each result feeds into the next)
    const allOf = propSchema.allOf
    if (Array.isArray(allOf)) {
      let result = value
      for (const subSchema of allOf) {
        if (subSchema !== null && typeof subSchema === 'object' && !Array.isArray(subSchema)) {
          result = coerceValue(result, subSchema as Record<string, unknown>)
        }
      }
      return result
    }

    // anyOf / oneOf: try each sub-schema in order, return the first that changes the value
    const anyOf = propSchema.anyOf ?? propSchema.oneOf
    if (Array.isArray(anyOf)) {
      for (const subSchema of anyOf) {
        if (subSchema !== null && typeof subSchema === 'object' && !Array.isArray(subSchema)) {
          const coerced = coerceValue(value, subSchema as Record<string, unknown>)
          if (coerced !== value) return coerced
        }
      }
      return value
    }
  }

  if (typeof value === 'string') {
    if (types.includes('number') || types.includes('integer')) {
      // Guard against empty string coercing to 0 via Number("")
      if (value.trim() !== '') {
        const num = Number(value)
        if (Number.isFinite(num)) return num
      }
    } else if (types.includes('boolean')) {
      const lower = value.toLowerCase()
      if (lower === 'true') return true
      if (lower === 'false') return false
    } else if (types.includes('array')) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) return coerceArrayItems(parsed, propSchema)
      } catch {
        // leave as string if not valid JSON
      }
    } else if (types.includes('object')) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return propSchema.properties
            ? coerceInputToJsonSchema(parsed as Record<string, unknown>, propSchema)
            : parsed
        }
      } catch {
        // leave as string if not valid JSON
      }
    }
  } else if (Array.isArray(value)) {
    if (types.includes('array')) return coerceArrayItems(value, propSchema)
  } else if (value !== null && typeof value === 'object') {
    if (types.includes('object') && propSchema.properties) {
      return coerceInputToJsonSchema(value as Record<string, unknown>, propSchema)
    }
  }

  return value
}

/** Coerces each element of an array using the schema's `items` definition. */
function coerceArrayItems(items: unknown[], arraySchema: Record<string, unknown>): unknown[] {
  const itemSchema = arraySchema.items as Record<string, unknown> | undefined
  if (!itemSchema) return items
  return items.map((item) => coerceValue(item, itemSchema))
}

/**
 * Coerces string-encoded values in `input` to the types declared by a JSON Schema.
 * This is a defensive layer for the MCP tool call path: when an LLM uses text/XML
 * tool-calling mode, parameter values can arrive as strings even when the JSON Schema
 * declares number, boolean, array, or object types. The MCP server then rejects them
 * with errors like "expected number, received string". Values already of the correct
 * type are left untouched (idempotent). Coercion recurses into nested objects and
 * array items.
 */
export function coerceInputToJsonSchema(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const result: Record<string, unknown> = { ...input }

  for (const [key, value] of Object.entries(result)) {
    const propSchema = properties[key]
    if (!propSchema) continue
    result[key] = coerceValue(value, propSchema)
  }

  return result
}

export function parseRawCustomToolCall(params: {
  customToolDefs: CustomToolDefinitions
  rawToolCall: {
    toolName: string
    toolCallId: string
    input: Record<string, unknown>
  }
  autoInsertEndStepParam?: boolean
}): CustomToolCall | ToolCallError {
  const { customToolDefs, rawToolCall, autoInsertEndStepParam = false } = params
  const toolName = rawToolCall.toolName

  if (
    !(customToolDefs && toolName in customToolDefs) &&
    !toolName.includes(MCP_TOOL_SEPARATOR)
  ) {
    return {
      toolName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Tool ${toolName} not found`,
    }
  }

  const processedParameters: Record<string, any> = {}
  for (const [param, val] of Object.entries(rawToolCall.input ?? {})) {
    processedParameters[param] = val
  }

  // Add the required codebuff_end_step parameter with the correct value for this tool if requested
  if (autoInsertEndStepParam) {
    processedParameters[endsAgentStepParam] =
      customToolDefs?.[toolName]?.endsAgentStep
  }

  // Apply type coercion BEFORE Zod validation so that both strict and permissive
  // schemas receive correctly-typed values. Without this, XML/text tool-calling
  // mode sends all values as strings and strict schemas fail validation before
  // coercion can help; permissive schemas pass validation but forward raw strings
  // to the MCP server which then rejects them.
  const rawInputSchema = customToolDefs?.[toolName]?.rawInputSchema as
    | Record<string, unknown>
    | undefined
  if (rawInputSchema) {
    const coerced = coerceInputToJsonSchema(processedParameters, rawInputSchema)
    for (const [k, v] of Object.entries(coerced)) {
      processedParameters[k] = v
    }
  }

  const rawSchema = customToolDefs?.[toolName]?.inputSchema
  if (rawSchema) {
    const paramsSchema = ensureZodSchema(rawSchema)
    const result = paramsSchema.safeParse(processedParameters)

    if (!result.success) {
      return {
        toolName: toolName,
        toolCallId: rawToolCall.toolCallId,
        input: rawToolCall.input,
        error: `Invalid parameters for ${toolName}: ${JSON.stringify(
          result.error.issues,
          null,
          2,
        )}`,
      }
    }
  }

  const input: Record<string, unknown> = JSON.parse(
    JSON.stringify(processedParameters),
  )

  if (endsAgentStepParam in input) {
    delete input[endsAgentStepParam]
  }
  return {
    toolName: toolName,
    input,
    toolCallId: rawToolCall.toolCallId,
  }
}

export async function executeCustomToolCall(
  params: ExecuteToolCallParams<string>,
): Promise<void> {
  const {
    toolName,
    input,
    autoInsertEndStepParam = false,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    fileContext,
    logger,
    onResponseChunk,
    previousToolCallFinished,
    requestToolCall,
    toolCallId,
    toolCalls,
    toolCallsToAddToMessageHistory,
    toolResults,
    toolResultsToAddToMessageHistory,
    userInputId,
  } = params
  const toolCall: CustomToolCall | ToolCallError = parseRawCustomToolCall({
    customToolDefs: (
      await getMCPToolData({
        ...params,
        toolNames: agentTemplate.toolNames,
        mcpServers: agentTemplate.mcpServers,
        writeTo: cloneDeep(fileContext.customToolDefinitions),
      })
    ).customToolDefinitions,
    rawToolCall: {
      toolName,
      toolCallId: toolCallId ?? generateCompactId(),
      input,
    },
    autoInsertEndStepParam,
  })

  // Filter out restricted tools - emit error instead of tool call/result
  // This prevents the CLI from showing tool calls that the agent doesn't have permission to use
  if (
    toolCall.toolName &&
    !(agentTemplate.toolNames as string[]).includes(toolCall.toolName) &&
    !fromHandleSteps &&
    !(
      toolCall.toolName.includes(MCP_TOOL_SEPARATOR) &&
      toolCall.toolName.split(MCP_TOOL_SEPARATOR)[0] in
        (agentTemplate.mcpServers ?? {})
    )
  ) {
    // Emit an error event instead of tool call/result pair
    // The stream parser will convert this to a user message for proper API compliance
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` is not currently available. Make sure to only use tools listed in the system instructions.`,
    })
    return previousToolCallFinished
  }

  if ('error' in toolCall) {
    onResponseChunk({
      type: 'error',
      message: toolCall.error,
    })
    logger.debug(
      { toolCall, error: toolCall.error },
      `${toolName} error: ${toolCall.error}`,
    )
    return previousToolCallFinished
  }

  // Only emit tool_call event after permission check passes
  onResponseChunk({
    type: 'tool_call',
    toolCallId: toolCall.toolCallId,
    toolName,
    input: toolCall.input,
    // Only include agentId for subagents (agents with a parent)
    ...(agentState?.parentId && { agentId: agentState.agentId }),
    // Include includeToolCall flag if explicitly set to false
    ...(excludeToolFromMessageHistory && { includeToolCall: false }),
  })

  toolCalls.push(toolCall)
  if (!excludeToolFromMessageHistory) {
    toolCallsToAddToMessageHistory.push(toolCall)
  }

  // SPARROW: open tool.call span around the custom tool dispatch. The span
  // is opened here (after permission/validation checks) and finished in both
  // the success path and any error rejection downstream.
  const sparrowToolSpan = recordToolCall({
    toolName,
    input: toolCall.input,
  })

  return previousToolCallFinished
    .then(async () => {
      if (params.signal.aborted) {
        return null
      }

      const toolName = toolCall.toolName.includes(MCP_TOOL_SEPARATOR)
        ? toolCall.toolName.split(MCP_TOOL_SEPARATOR).slice(1).join(MCP_TOOL_SEPARATOR)
        : toolCall.toolName
      const clientToolResult = await requestToolCall({
        userInputId,
        toolName,
        input: toolCall.input,
        mcpConfig: toolCall.toolName.includes(MCP_TOOL_SEPARATOR)
          ? (agentTemplate.mcpServers ?? {})[
              toolCall.toolName.split(MCP_TOOL_SEPARATOR)[0]
            ]
          : undefined,
      })
      return clientToolResult.output satisfies ToolResultOutput[]
    })
    .then(
      (result) => {
        if (!result) {
          // SPARROW: aborted/no-op path — finish span as a successful no-op so
          // we don't leave it dangling.
          sparrowToolSpan.finish({ success: true, output: undefined })
          return
        }
        const toolResult = {
          role: 'tool',
          toolName,
          toolCallId: toolCall.toolCallId,
          content: result,
        } satisfies ToolMessage
        logger.debug(
          { input, toolResult },
          `${toolName} custom tool call & result (${toolResult.toolCallId})`,
        )
        onResponseChunk({
          type: 'tool_result',
          toolName: toolResult.toolName,
          toolCallId: toolResult.toolCallId,
          output: toolResult.content,
        })

        toolResults.push(toolResult)

        if (!excludeToolFromMessageHistory) {
          toolResultsToAddToMessageHistory.push(toolResult)
        }

        // SPARROW: finish tool.call span on success with the tool's result.
        sparrowToolSpan.finish({ success: true, output: result })

        return
      },
      (error) => {
        // SPARROW: finish tool.call span on failure, then re-throw to preserve
        // existing error semantics for callers awaiting this promise.
        sparrowToolSpan.finish({ success: false, error })
        throw error
      },
    )
}

/**
 * Checks if a tool name matches a spawnable agent and returns the transformed
 * spawn_agents input if so. Returns null if not an agent tool call.
 */
export function tryTransformAgentToolCall(params: {
  toolName: string
  input: Record<string, unknown>
  spawnableAgents: AgentTemplateType[]
}): { toolName: 'spawn_agents'; input: Record<string, unknown> } | null {
  const { toolName, input, spawnableAgents } = params

  const agentShortNames = spawnableAgents.map(getAgentShortName)
  if (!agentShortNames.includes(toolName)) {
    return null
  }

  // Find the full agent type for this short name
  const fullAgentType = spawnableAgents.find(
    (agentType) => getAgentShortName(agentType) === toolName,
  )

  // Convert to spawn_agents call - input already has prompt and params as top-level fields
  // (consistent with spawn_agents schema)
  const agentEntry: Record<string, unknown> = {
    agent_type: fullAgentType || toolName,
  }
  if (typeof input.prompt === 'string') {
    agentEntry.prompt = input.prompt
  }
  if (input.params && typeof input.params === 'object') {
    agentEntry.params = input.params
  }
  const spawnAgentsInput = {
    agents: [agentEntry],
  }

  return { toolName: 'spawn_agents', input: spawnAgentsInput }
}
