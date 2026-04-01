import {
  createTestAgentRuntimeParams,
  testFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import * as promiseUtils from '@codebuff/common/util/promise'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import * as agentRegistry from '../templates/agent-registry'
import * as spawnAgentUtils from '../tools/handlers/tool/spawn-agent-utils'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'

const mockFileContext = testFileContext

function makeSuccessResult(creditsUsed = 0) {
  return {
    agentState: { ...getInitialAgentState(), creditsUsed },
    output: {
      type: 'lastMessage' as const,
      value: [assistantMessage('Success after retry')],
    },
  }
}

function makeErrorResult(statusCode: number, message: string) {
  return {
    agentState: { ...getInitialAgentState(), creditsUsed: 0 },
    output: { type: 'error' as const, message, statusCode },
  }
}

function makeTransientError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode })
}

describe('Subagent Transient Error Retry', () => {
  let mockAgentTemplate: any
  let params: any

  beforeEach(() => {
    mockAgentTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      model: 'gpt-4o-mini',
      toolNames: ['write_file'],
      spawnableAgents: ['test-agent'],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      outputMode: 'last_message',
      inputSchema: {},
      mcpServers: {},
    }

    const baseParams = createTestAgentRuntimeParams()
    params = {
      ...baseParams,
      agentTemplate: mockAgentTemplate,
      agentState: getInitialAgentState(),
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      localAgentTemplates: { 'test-agent': mockAgentTemplate },
      previousToolCallFinished: Promise.resolve(),
      repoId: undefined,
      repoUrl: undefined,
      signal: new AbortController().signal,
      system: 'Test system prompt',
      toolCall: {
        toolName: 'spawn_agents' as const,
        toolCallId: 'test-call',
        input: { agents: [{ agent_type: 'test-agent', prompt: 'Test task' }] },
      },
      userId: 'test-user',
      userInputId: 'test-input',
      writeToClient: () => {},
    }

    spyOn(agentRegistry, 'getAgentTemplate').mockResolvedValue(
      mockAgentTemplate,
    )
    spyOn(spawnAgentUtils, 'getMatchingSpawn').mockReturnValue('test-agent')
    spyOn(promiseUtils, 'abortableSleep').mockResolvedValue(undefined)
  })

  afterEach(() => {
    mock.restore()
  })

  describe('returned transient error path', () => {
    it('should retry once when result contains a transient 503 error', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(503, 'Service Unavailable'))
        .mockResolvedValueOnce(makeSuccessResult())

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Success after retry')
    })

    it('should retry once when result contains a transient 500 error', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(500, 'Internal Server Error'))
        .mockResolvedValueOnce(makeSuccessResult())

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Success after retry')
    })

    it('should retry once when result contains a transient 529 error (Anthropic Overloaded)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(529, 'Overloaded'))
        .mockResolvedValueOnce(makeSuccessResult())

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Success after retry')
    })

    it('should not retry on non-transient error result (400)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(400, 'Bad Request'))

      await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(1)
    })

    it('should not retry on non-transient error result (403)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(403, 'Forbidden'))

      await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(1)
    })

    it('should not retry when error result has no statusCode', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce({
          agentState: { ...getInitialAgentState(), creditsUsed: 0 },
          output: { type: 'error' as const, message: 'Unknown error' },
        })

      await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(1)
    })
  })

  describe('thrown transient error path', () => {
    it('should retry once when a transient 502 error is thrown', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(502, 'Bad Gateway'))
        .mockResolvedValueOnce(makeSuccessResult())

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Success after retry')
    })

    it('should retry once when a transient 504 error is thrown', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(504, 'Gateway Timeout'))
        .mockResolvedValueOnce(makeSuccessResult())

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Success after retry')
    })

    it('should not retry on non-transient thrown error (403)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(403, 'Forbidden'))

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(output)).toContain('Error spawning agent')
    })

    it('should not retry when thrown error has no statusCode', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(new Error('Something went wrong'))

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(output)).toContain('Error spawning agent')
    })
  })

  describe('retry safeguards', () => {
    it('should not retry more than once (returned error then thrown error)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(503, 'Service Unavailable'))
        .mockRejectedValueOnce(makeTransientError(502, 'Bad Gateway'))

      const { output } = await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(output)).toContain('Error spawning agent')
    })

    it('should not retry when signal is already aborted', async () => {
      const abortController = new AbortController()
      abortController.abort()

      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(503, 'Service Unavailable'))

      await handleSpawnAgents({ ...params, signal: abortController.signal })

      expect(mockExecute).toHaveBeenCalledTimes(1)
    })

    it('should not retry thrown error when signal is already aborted', async () => {
      const abortController = new AbortController()
      abortController.abort()

      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(500, 'Internal Server Error'))

      const { output } = await handleSpawnAgents({
        ...params,
        signal: abortController.signal,
      })

      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(output)).toContain('Error spawning agent')
    })
  })

  describe('retry behavior details', () => {
    it('should use fresh agent state on retry (different agentId)', async () => {
      const mockExecute = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(500, 'Internal Server Error'))
        .mockResolvedValueOnce(makeSuccessResult())

      await handleSpawnAgents({ ...params })

      expect(mockExecute).toHaveBeenCalledTimes(2)
      const firstCallState = (
        mockExecute.mock.calls[0] as [{ agentState: { agentId: string } }]
      )[0].agentState
      const secondCallState = (
        mockExecute.mock.calls[1] as [{ agentState: { agentId: string } }]
      )[0].agentState
      expect(firstCallState.agentId).not.toBe(secondCallState.agentId)
    })

    it('should call abortableSleep before retrying (returned error path)', async () => {
      const sleepSpy = spyOn(
        promiseUtils,
        'abortableSleep',
      ).mockResolvedValue(undefined)

      spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(503, 'Service Unavailable'))
        .mockResolvedValueOnce(makeSuccessResult())

      await handleSpawnAgents({ ...params })

      expect(sleepSpy).toHaveBeenCalledTimes(1)
      expect(sleepSpy.mock.calls[0][0]).toBe(2000)
    })

    it('should call abortableSleep before retrying (thrown error path)', async () => {
      const sleepSpy = spyOn(
        promiseUtils,
        'abortableSleep',
      ).mockResolvedValue(undefined)

      spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(502, 'Bad Gateway'))
        .mockResolvedValueOnce(makeSuccessResult())

      await handleSpawnAgents({ ...params })

      expect(sleepSpy).toHaveBeenCalledTimes(1)
      expect(sleepSpy.mock.calls[0][0]).toBe(2000)
    })

    it('should log a warning before retrying (returned error path)', async () => {
      const mockLogger = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      }

      spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce(makeErrorResult(503, 'Service Unavailable'))
        .mockResolvedValueOnce(makeSuccessResult())

      await handleSpawnAgents({ ...params, logger: mockLogger })

      expect(mockLogger.warn).toHaveBeenCalledTimes(1)
      const warnArgs = mockLogger.warn.mock.calls[0] as unknown[]
      const warnMessage = warnArgs[1] as string
      expect(warnMessage).toContain('Retrying subagent')
      expect(warnMessage).toContain('Test Agent')
      expect(warnMessage).toContain('503')
    })

    it('should log a warning before retrying (thrown error path)', async () => {
      const mockLogger = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      }

      spyOn(spawnAgentUtils, 'executeSubagent')
        .mockRejectedValueOnce(makeTransientError(502, 'Bad Gateway'))
        .mockResolvedValueOnce(makeSuccessResult())

      await handleSpawnAgents({ ...params, logger: mockLogger })

      expect(mockLogger.warn).toHaveBeenCalledTimes(1)
      const warnArgs = mockLogger.warn.mock.calls[0] as unknown[]
      const warnMessage = warnArgs[1] as string
      expect(warnMessage).toContain('Retrying subagent')
      expect(warnMessage).toContain('Test Agent')
      expect(warnMessage).toContain('502')
    })

    it('should aggregate costs from both attempts when retry succeeds', async () => {
      const parentAgentState = {
        ...getInitialAgentState(),
        agentId: 'parent-agent',
        agentType: 'test-agent',
        creditsUsed: 10,
      }

      spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce({
          agentState: { ...getInitialAgentState(), creditsUsed: 5 },
          output: { type: 'error' as const, message: 'Overloaded', statusCode: 529 },
        })
        .mockResolvedValueOnce({
          agentState: { ...getInitialAgentState(), creditsUsed: 15 },
          output: {
            type: 'lastMessage' as const,
            value: [assistantMessage('Done')],
          },
        })

      await handleSpawnAgents({
        ...params,
        agentState: parentAgentState,
      })

      // Parent should aggregate cost from the final successful result
      expect(parentAgentState.creditsUsed).toBe(25) // 10 + 15
    })
  })
})
