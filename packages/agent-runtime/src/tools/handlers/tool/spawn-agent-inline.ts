import { SUBAGENT_EXECUTION_TIMEOUT_MS } from '@codebuff/common/constants/agents'
import { mapValues } from 'lodash'

import {
  validateAndGetAgentTemplate,
  validateAgentInput,
  executeSubagent,
  createAgentState,
  extractSubagentContextParams,
  runWithSubagentTimeout,
} from './spawn-agent-utils'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

type ToolName = 'spawn_agent_inline'
export const handleSpawnAgentInline = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>

    agentState: AgentState
    agentTemplate: AgentTemplate
    clientSessionId: string
    fileContext: ProjectFileContext
    fingerprintId: string
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    system: string
    tools: ToolSet
    userId: string | undefined
    userInputId: string
    writeToClient: (chunk: string | PrintModeEvent) => void
  } & ParamsExcluding<
    typeof executeSubagent,
    | 'userInputId'
    | 'prompt'
    | 'spawnParams'
    | 'agentTemplate'
    | 'parentAgentState'
    | 'agentState'
    | 'parentSystemPrompt'
    | 'parentTools'
    | 'onResponseChunk'
    | 'clearUserPromptMessagesAfterResponse'
    | 'fingerprintId'
  >,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState: parentAgentState,
    agentTemplate: parentAgentTemplate,
    fingerprintId,
    system,
    tools: parentTools,
    userInputId,
    writeToClient,
    logger,
  } = params
  const {
    agent_type: agentTypeStr,
    prompt,
    params: spawnParams,
  } = toolCall.input

  await previousToolCallFinished

  const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
    agentTypeStr,
    parentAgentTemplate,
    localAgentTemplates: params.localAgentTemplates,
    logger,
    fetchAgentFromDatabase: params.fetchAgentFromDatabase,
    databaseAgentCache: params.databaseAgentCache,
    apiKey: params.apiKey,
  })

  validateAgentInput(agentTemplate, agentType, prompt, spawnParams)

  // Override template for inline agent to share system prompt & message history with parent
  const inlineTemplate = {
    ...agentTemplate,
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
  }

  // Create child agent state that shares message history with parent
  const childAgentState: AgentState = {
    ...createAgentState(
      agentType,
      inlineTemplate,
      parentAgentState,
      parentAgentState.agentContext,
    ),
    systemPrompt: system,
    toolDefinitions: mapValues(parentTools, (tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema as {},
    })),
  }

  // Extract common context params to avoid bugs from spreading all params
  const contextParams = extractSubagentContextParams(params)

  const modelStr = agentTemplate.model ? String(agentTemplate.model) : undefined

  // Per-subagent timeout + hang detection so a stalled inline subagent (e.g. a
  // degraded model client) can't hang the parent's flow indefinitely.
  const result = await runWithSubagentTimeout({
    parentSignal: contextParams.signal,
    timeoutMs: SUBAGENT_EXECUTION_TIMEOUT_MS,
    agentType,
    logger,
    // On timeout, emit subagent_finish so the UI doesn't show a dangling
    // 'started' agent (the hung run may never observe the abort).
    onTimeout: () => {
      if (agentType !== 'context-pruner') {
        writeToClient({
          type: 'subagent_finish',
          agentId: childAgentState.agentId,
          agentType,
          displayName: agentTemplate.displayName,
          model: modelStr,
          onlyChild: false,
          parentAgentId: parentAgentState.agentId,
          prompt: prompt || '',
          params: spawnParams,
        })
      }
    },
    run: (childSignal) =>
      executeSubagent({
        ...contextParams,
        // Per-subagent child signal so a timeout (or parent abort) cancels the
        // underlying LLM stream rather than letting it hang.
        signal: childSignal,

        // Spawn-specific params
        ancestorRunIds: parentAgentState.ancestorRunIds,
        userInputId: `${userInputId}-inline-${agentType}${childAgentState.agentId}`,
        prompt: prompt || '',
        spawnParams,
        agentTemplate: inlineTemplate,
        parentAgentState,
        agentState: childAgentState,
        fingerprintId,
        parentSystemPrompt: system,
        parentTools,
        onResponseChunk: (chunk) => {
          // Inherits parent's onResponseChunk, except for context-pruner (TODO: add an option for it to be silent?)
          if (agentType !== 'context-pruner') {
            writeToClient(chunk)
          }
        },
        clearUserPromptMessagesAfterResponse: false,
      }),
  })

  // Update parent agent state to reflect shared message history
  parentAgentState.messageHistory = result.agentState.messageHistory

  return { output: [{ type: 'json', value: { message: 'Agent spawned.' } }] }
}) satisfies CodebuffToolHandlerFunction<ToolName>
