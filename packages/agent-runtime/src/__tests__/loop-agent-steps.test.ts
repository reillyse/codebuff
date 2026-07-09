import * as analytics from '@codebuff/common/analytics'
import {
  CURRENT_GPT5_MODEL,
  CURRENT_OPUS_MODEL,
  CURRENT_SONNET_FALLBACK_MODEL,
  CURRENT_SONNET_MODEL,
} from '@codebuff/common/constants/model-config'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  clearMockedModules,
} from '@codebuff/common/testing/mock-modules'
import { setupDbSpies } from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { AbortError, promptSuccess } from '@codebuff/common/util/error'
import * as promiseUtils from '@codebuff/common/util/promise'
import { APICallError } from 'ai'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import db from '@codebuff/internal/db'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { z } from 'zod/v4'

import { __resetEmptyResponseCooldowns } from '../empty-response-cooldown'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps - runAgentStep vs runProgrammaticStep behavior', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let llmCallCount: number
  let agentRuntimeImpl: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  > & {
    promptAiSdkStream?: ReturnType<typeof mock>
  }
  let loopAgentStepsBaseParams: Parameters<typeof loopAgentSteps>[0]
  let dbSpies: DbSpies

  beforeAll(async () => {
    // Set up mocks.
  })

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }

    llmCallCount = 0

    // Setup spies for database operations using typed helper
    dbSpies = setupDbSpies(db)

    agentRuntimeImpl.promptAiSdkStream = mock(async function* ({}) {
      llmCallCount++
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () => 'mock-uuid-0000-0000-0000-000000000000' as const,
    )

    // Create mock template with programmatic agent
    mockTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined, // Will be set in individual tests
    } satisfies AgentTemplate as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      stepsRemaining: 10, // Ensure we don't hit the limit
    }

    loopAgentStepsBaseParams = {
      ...agentRuntimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: mockAgentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    clearAgentGeneratorCache(agentRuntimeImpl)
    dbSpies.restore()
    mock.restore()
    // Session-scoped empty-response cooldown state must not leak between tests.
    __resetEmptyResponseCooldowns()
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('should verify correct STEP behavior - LLM called once after STEP', async () => {
    // This test verifies that when a programmatic agent yields STEP,
    // the LLM should be called once in the next iteration

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // Execute a tool, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Should pause here and let LLM run
      // Continue after LLM runs (this won't be reached in this test since LLM ends turn)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    console.log(`LLM calls made: ${llmCallCount}`)
    console.log(`Step count: ${stepCount}`)

    // CORRECT BEHAVIOR: After STEP, LLM should be called once
    // The programmatic agent yields STEP, then LLM runs once and ends turn
    expect(llmCallCount).toBe(1) // LLM called once after STEP

    // The programmatic agent should have been called once (yielded STEP)
    expect(stepCount).toBe(1)
  })

  it('should demonstrate correct behavior when programmatic agent completes without STEP', async () => {
    // This test shows that when a programmatic agent doesn't yield STEP,
    // it should complete without calling the LLM at all (since it ends with end_turn)

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should NOT call LLM since the programmatic agent ended with end_turn
    expect(llmCallCount).toBe(0)
    // The result should have agentState
    expect(result.agentState).toBeDefined()
  })

  it('should run programmatic step first, then LLM step, then continue', async () => {
    // This test verifies the correct execution order in loopAgentSteps:
    // 1. Programmatic step runs first and yields STEP
    // 2. LLM step runs once
    // 3. Loop continues but generator is complete after first STEP

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // First execution: do some work, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Hand control to LLM
      // After LLM runs, continue (this happens in the same generator instance)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'updated by LLM' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify execution order:
    // 1. Programmatic step function was called once (creates generator)
    // 2. LLM was called once after STEP
    // 3. Generator continued after LLM step
    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after first STEP
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent that yields STEP_ALL', async () => {
    // Test STEP_ALL behavior - should run LLM then continue with programmatic step

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP_ALL' // Hand all remaining control to LLM
      // Should continue after LLM completes all its steps
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'done' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should not call LLM when programmatic agent returns without STEP', async () => {
    // Test that programmatic agents that don't yield STEP don't trigger LLM

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'result.txt', content: 'processed' },
      }
      // No STEP - agent completes without LLM involvement
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(0) // No LLM calls should be made
    expect(result.agentState).toBeDefined()
  })

  it('should handle LLM-only agent (no handleSteps)', async () => {
    // Test traditional LLM-based agents that don't have handleSteps

    const llmOnlyTemplate = {
      ...mockTemplate,
      handleSteps: undefined, // No programmatic step function
    }

    const localAgentTemplates = {
      'test-agent': llmOnlyTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent error and still call LLM', async () => {
    // Test error handling in programmatic step - should still allow LLM to run

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      throw new Error('Programmatic step failed')
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // After programmatic step error, should end turn and not call LLM
    expect(llmCallCount).toBe(0)
    expect(result.agentState).toBeDefined()
    expect(result.agentState.output?.error).toContain(
      'Error executing handleSteps for agent test-agent',
    )
  })

  it('should handle mixed execution with multiple STEP yields', async () => {
    // Test complex scenario with multiple STEP yields and LLM interactions
    // Note: In current implementation, LLM typically ends turn after running,
    // so this tests the first STEP interaction

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
      yield 'STEP' // First LLM interaction
      yield {
        toolName: 'write_file',
        input: { path: 'temp.txt', content: 'intermediate' },
      }
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'complete' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after STEP
    expect(result.agentState).toBeDefined()
  })

  it('should pass shouldEndTurn: true as stepsComplete when end_turn tool is called', async () => {
    // Test that when LLM calls end_turn, shouldEndTurn (stepsComplete) is correctly passed
    // to the handleSteps generator via the step result.
    //
    // Flow:
    // 1. Generator yields 'STEP', runProgrammaticStep returns
    // 2. loopAgentSteps calls runAgentStep (LLM), which calls end_turn -> shouldEndTurn = true
    // 3. loopAgentSteps calls runProgrammaticStep again with stepsComplete: true
    // 4. Generator resumes from yield 'STEP' and receives { stepsComplete: true }

    let stepsCompleteValues: boolean[] = []

    const mockGeneratorFunction = function* () {
      // First STEP - after LLM runs and calls end_turn, we receive stepsComplete: true
      const result1 = yield 'STEP'
      stepsCompleteValues.push(result1.stepsComplete)

      // Since stepsComplete was true, we should end gracefully
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify that stepsComplete was passed correctly:
    // After yielding STEP and LLM running (which calls end_turn),
    // the generator receives stepsComplete: true
    expect(stepsCompleteValues).toHaveLength(1)
    expect(stepsCompleteValues[0]).toBe(true)
  })

  it('should continue loop when handleSteps returns endTurn: false even if LLM calls end_turn', async () => {
    // Test that handleSteps endTurn: false takes precedence over LLM end_turn tool call

    let programmaticStepCount = 0
    let llmStepCount = 0

    const mockGeneratorFunction = function* () {
      // First iteration: return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Second iteration: also return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Third iteration: finally return endTurn: true to end the loop
      programmaticStepCount++
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock LLM to always call end_turn, but handleSteps should override it
    let promptCallCount = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
      promptCallCount++
      llmStepCount++

      // LLM always tries to end turn
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess(`mock-message-id-${promptCallCount}`)
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify handleSteps ran 3 times (yielded STEP twice, then end_turn)
    expect(programmaticStepCount).toBe(3)

    // Verify LLM was called 2 times (once per STEP yield)
    expect(llmStepCount).toBe(2)

    // This confirms that even though LLM called end_turn every time,
    // the loop continued because handleSteps kept yielding STEP before finally ending
  })

  it('should restart loop when agent finishes without setting required output', async () => {
    // Test that when an agent has outputSchema but finishes without calling set_output,
    // the loop restarts with a system message

    const outputSchema = z.object({
      result: z.string(),
      status: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'], // Add set_output to available tools
      handleSteps: undefined, // LLM-only agent
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent tries to end turn without setting output
        yield {
          type: 'text' as const,
          text: 'First response without output\n\n',
        }
        yield createToolCallChunk('end_turn', {})
      } else if (llmCallNumber === 2) {
        // Second call: agent sets output after being reminded
        // Manually set the output to simulate the set_output tool execution
        if (capturedAgentState) {
          capturedAgentState.output = {
            result: 'test result',
            status: 'success',
          }
        }
        yield { type: 'text' as const, text: 'Setting output now\n\n' }
        yield createToolCallChunk('set_output', {
          result: 'test result',
          status: 'success',
        })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      } else {
        // Safety: if called more than twice, just end
        yield { type: 'text' as const, text: 'Ending\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once to try ending without output, once after reminder
    expect(llmCallNumber).toBe(2)

    // Should have output set after the second attempt
    expect(result.agentState.output).toEqual({
      result: 'test result',
      status: 'success',
    })

    // Check that a system message was added to message history
    const systemMessages = result.agentState.messageHistory.filter(
      (msg) =>
        msg.role === 'user' &&
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes('set_output'),
    )
    expect(systemMessages.length).toBeGreaterThan(0)
  })

  it('should not restart loop if output is set correctly', async () => {
    // Test that when an agent has outputSchema and sets output correctly,
    // the loop ends normally without restarting

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      // Agent sets output correctly on first call
      if (capturedAgentState) {
        capturedAgentState.output = { result: 'success' }
      }
      yield { type: 'text' as const, text: 'Setting output\n\n' }
      yield createToolCallChunk('set_output', { result: 'success' })
      yield { type: 'text' as const, text: '\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once since output was set correctly
    expect(llmCallNumber).toBe(1)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'success' })
  })

  it('should pass generateN from programmatic step to runAgentStep as n parameter', async () => {
    // Test that when programmatic step returns generateN, it's passed to runAgentStep

    let agentStepN: number | undefined

    const mockGeneratorFunction = function* () {
      // Yield GENERATE_N to trigger n parameter
      yield { type: 'GENERATE_N', n: 5 }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock promptAiSdk to capture the n parameter
    loopAgentStepsBaseParams.promptAiSdk = async (params: any) => {
      agentStepN = params.n
      return promptSuccess(JSON.stringify([
        'Response 1',
        'Response 2',
        'Response 3',
        'Response 4',
        'Response 5',
      ]))
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify generateN was passed to runAgentStep as n
    expect(agentStepN).toBe(5)
  })

  it('should pass nResponses from runAgentStep back to programmatic step', async () => {
    // Test that nResponses returned by runAgentStep are passed to next programmatic step

    let receivedNResponses: string[] | undefined

    const mockGeneratorFunction = function* () {
      const { nResponses } = yield { type: 'GENERATE_N', n: 3 }
      receivedNResponses = nResponses
      const step = yield {
        toolName: 'read_files',
        input: { paths: ['test.txt'] },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const expectedResponses = [
      'Implementation A',
      'Implementation B',
      'Implementation C',
    ]
    loopAgentStepsBaseParams.promptAiSdk = async () => {
      return promptSuccess(JSON.stringify(expectedResponses))
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(receivedNResponses).toEqual(expectedResponses)
  })

  it('should allow agents without outputSchema to end normally', async () => {
    // Test that agents without outputSchema can end without setting output

    const templateWithoutOutputSchema = {
      ...mockTemplate,
      outputSchema: undefined,
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithoutOutputSchema,
    }

    let llmCallNumber = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      yield { type: 'text' as const, text: 'Response without output\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once and end normally
    expect(llmCallNumber).toBe(1)

    // Output should be undefined since no outputSchema required
    expect(result.agentState.output).toBeUndefined()
  })

  it('should continue loop if agent does not end turn (has more work)', async () => {
    // Test that validation only triggers when shouldEndTurn is true

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['read_files', 'set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent does some work but doesn't end turn
        yield { type: 'text' as const, text: 'Doing work\n\n' }
        yield createToolCallChunk('read_files', { paths: ['test.txt'] })
      } else {
        // Second call: agent sets output and ends
        if (capturedAgentState) {
          capturedAgentState.output = { result: 'done' }
        }
        yield { type: 'text' as const, text: 'Finishing\n\n' }
        yield createToolCallChunk('set_output', { result: 'done' })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once for work, once to set output and end
    expect(llmCallNumber).toBe(2)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'done' })
  })

  describe('transient API error retry', () => {
    beforeAll(() => {
      mock.module('@codebuff/common/util/promise', () => ({
        ...promiseUtils,
        sleep: async () => {},
        abortableSleep: async () => {},
      }))
    })

    it('should retry runAgentStep on transient 500 errors and succeed on second attempt', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        if (promptCallCount === 1) {
          // First attempt: throw a transient 500 error
          throw new APICallError({
            message: 'Internal server error',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 500,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have called LLM twice (first attempt failed, second succeeded)
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')
    })

    it('should retry runAgentStep on Anthropic 529 Overloaded errors', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        if (promptCallCount === 1) {
          // First attempt: throw Anthropic 529 Overloaded error
          throw new APICallError({
            message: 'Overloaded. https://docs.claude.com/en/api/errors',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have called LLM twice (first attempt failed with 529, second succeeded)
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')
    })

    it('should switch to a sibling model on a confirmed 529 and succeed on retry', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const modelsUsed: (string | undefined)[] = []
      const chunks: string[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        if (promptCallCount === 1) {
          // First attempt: confirmed Anthropic 529 Overloaded error.
          throw new APICallError({
            message: 'Overloaded',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        onResponseChunk: (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk)
        },
      })

      // First attempt used the original model; after the confirmed 529 the
      // retry switched to the peer-strength sibling Anthropic model.
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_OPUS_MODEL)
      expect(result.output.type).not.toBe('error')

      // The user should be told about the model switch.
      const switchNotice = chunks.find((c) => c.includes('switching to'))
      expect(switchNotice).toBeDefined()
      expect(switchNotice).toContain(CURRENT_OPUS_MODEL)
    })

    it('should switch models when AI_NoOutputGeneratedError has a 529 nested in its cause chain', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const modelsUsed: (string | undefined)[] = []
      const chunks: string[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        if (promptCallCount === 1) {
          // Mid-stream 529 swallowed inside the stream surfaces as
          // AI_NoOutputGeneratedError but carries the real 529 via `cause`.
          const error = new Error(
            'No output generated. Check the stream for errors.',
          )
          error.name = 'AI_NoOutputGeneratedError'
          ;(error as Error & { cause?: unknown }).cause = new APICallError({
            message: 'Overloaded',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
          throw error
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        onResponseChunk: (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk)
        },
      })

      // The nested 529 was detected via getTransientStatusCode walking the
      // cause chain, so the retry switched to the peer-strength sibling model.
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_OPUS_MODEL)
      expect(result.output.type).not.toBe('error')

      const switchNotice = chunks.find((c) => c.includes('switching to'))
      expect(switchNotice).toBeDefined()
      expect(switchNotice).toContain(CURRENT_OPUS_MODEL)
    })

    it('should NOT switch models on a mid-stream AI_NoOutputGeneratedError (no confirmed 529)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const modelsUsed: (string | undefined)[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        if (promptCallCount === 1) {
          // Mid-stream failure with no 529 in the cause chain — ambiguous, so
          // the retry must keep the same model.
          const error = new Error(
            'No output generated. Check the stream for errors.',
          )
          error.name = 'AI_NoOutputGeneratedError'
          throw error
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // No confirmed 529 → same model on retry (no ladder switch).
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_SONNET_MODEL)
      expect(result.output.type).not.toBe('error')
    })

    it('should escalate model across retries (sonnet -> opus -> gpt-5) when 529s persist', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const modelsUsed: (string | undefined)[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        if (promptCallCount <= 2) {
          // First two attempts: confirmed Anthropic 529 Overloaded errors, so
          // the ladder escalates on each retry.
          throw new APICallError({
            message: 'Overloaded',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
        }
        // Third attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Full two-hop escalation: sonnet-5 -> opus -> gpt-5.
      expect(promptCallCount).toBe(3)
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_OPUS_MODEL)
      expect(modelsUsed[2]).toBe(CURRENT_GPT5_MODEL)
      expect(result.output.type).not.toBe('error')
      // Guard against silent extra calls.
      expect(modelsUsed.length).toBe(promptCallCount)
    })

    it('should retry an empty response (dropped stream), switch models, and succeed on the next attempt', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const chunks: string[] = []
      const modelsUsed: (string | undefined)[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        if (promptCallCount === 1) {
          // Empty response: the stream yields NO text and NO tool call (a
          // dropped/truncated provider stream that finishes "cleanly").
          return promptSuccess('mock-message-id')
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        onResponseChunk: (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk)
        },
      })

      // Should have retried the empty response and succeeded on attempt 2.
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')

      // The empty response switched models down the empty-response ladder:
      // attempt 1 on sonnet-5, attempt 2 on the distinct older Sonnet (4.6).
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_SONNET_FALLBACK_MODEL)

      // Should surface a retry notice explaining the empty response + switch.
      const retryNotice = chunks.find((c) => c.includes('retrying in'))
      expect(retryNotice).toBeDefined()
      expect(retryNotice).toContain('empty response')
      const switchNotice = chunks.find((c) => c.includes('switching to'))
      expect(switchNotice).toBeDefined()
      expect(switchNotice).toContain(CURRENT_SONNET_FALLBACK_MODEL)

      // Should NOT surface the final "ending the turn" warning — we recovered.
      const giveUpNotice = chunks.find((c) => c.includes('Ending the turn'))
      expect(giveUpNotice).toBeUndefined()
    })

    it('should escalate models across retries (sonnet-5 -> sonnet-4.6 -> opus) when empty responses persist', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const modelsUsed: (string | undefined)[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        promptCallCount++
        modelsUsed.push(params.model)
        // Always an empty response (no text, no tool call), so the ladder
        // steps down on each retry.
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // 1 initial + MAX_STEP_RETRIES (2) = 3 attempts, stepping down the
      // empty-response ladder: sonnet-5 -> sonnet-4.6 -> opus.
      expect(promptCallCount).toBe(3)
      expect(modelsUsed[0]).toBe(CURRENT_SONNET_MODEL)
      expect(modelsUsed[1]).toBe(CURRENT_SONNET_FALLBACK_MODEL)
      expect(modelsUsed[2]).toBe(CURRENT_OPUS_MODEL)
      // The run still "completes" (ends the turn) rather than erroring.
      expect(result.output.type).not.toBe('error')
      // Guard against silent extra calls.
      expect(modelsUsed.length).toBe(promptCallCount)
    })

    it('should skip a cooled-down model on the NEXT turn within the same session', async () => {
      // First turn: sonnet-5 returns an empty response, which puts it on a
      // session-scoped cooldown. Then it recovers on sonnet-4.6.
      const llmOnlyTemplate = {
        ...mockTemplate,
        model: CURRENT_SONNET_MODEL,
        handleSteps: undefined,
      }
      const localAgentTemplates = { 'test-agent': llmOnlyTemplate }

      // Turn 1: empty on first call (sonnet-5), success on second (sonnet-4.6).
      const turn1Models: (string | undefined)[] = []
      let turn1Count = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        turn1Count++
        turn1Models.push(params.model)
        if (turn1Count === 1) {
          return promptSuccess('mock-message-id')
        }
        yield { type: 'text' as const, text: 'Recovered\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })
      expect(turn1Models[0]).toBe(CURRENT_SONNET_MODEL)

      // Turn 2 (same clientSessionId): sonnet-5 is now on cooldown, so the turn
      // should START on sonnet-4.6 instead of sonnet-5.
      const turn2Models: (string | undefined)[] = []
      loopAgentStepsBaseParams.promptAiSdkStream = async function* (
        params: any,
      ) {
        turn2Models.push(params.model)
        yield { type: 'text' as const, text: 'Second turn\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // The second turn skipped the cooled sonnet-5 and started on sonnet-4.6.
      expect(turn2Models[0]).toBe(CURRENT_SONNET_FALLBACK_MODEL)
      expect(result.output.type).not.toBe('error')
    })

    it('should exhaust retries on persistent empty responses and surface the warning', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const chunks: string[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        // Always an empty response (no text, no tool call).
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        onResponseChunk: (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk)
        },
      })

      // 1 initial + MAX_STEP_RETRIES (2) = 3 attempts, then give up.
      expect(promptCallCount).toBe(3)
      // The run still "completes" (ends the turn) rather than erroring.
      expect(result.output.type).not.toBe('error')

      // Should surface the final "ending the turn" empty-response warning.
      const giveUpNotice = chunks.find((c) => c.includes('Ending the turn'))
      expect(giveUpNotice).toBeDefined()
      expect(giveUpNotice).toContain('empty response')
    })

    it('should retry via message fallback when error contains Overloaded but has no retryable status code', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        if (promptCallCount === 1) {
          // First attempt: throw a plain Error (no status code) with 'Overloaded' in message
          throw new Error('Overloaded. https://docs.claude.com/en/api/errors')
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have retried via message-based fallback and succeeded on second attempt
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')
    })

    it('should retry runAgentStep on AI_NoOutputGeneratedError (mid-stream overload)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const chunks: string[] = []

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        if (promptCallCount === 1) {
          // First attempt: simulate the AI SDK's mid-stream failure where the
          // stream opens but produces no output (e.g. a 529 swallowed inside
          // the stream surfaces as AI_NoOutputGeneratedError).
          const error = new Error(
            'No output generated. Check the stream for errors.',
          )
          error.name = 'AI_NoOutputGeneratedError'
          throw error
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        onResponseChunk: (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk)
        },
      })

      // Should have retried the mid-stream failure and succeeded on attempt 2.
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')

      // Should surface a user-facing notice explaining the mid-stream retry.
      const retryNotice = chunks.find((c) => c.includes('retrying in'))
      expect(retryNotice).toBeDefined()
      expect(retryNotice).toContain('Response stream interrupted')
    })

    it('should retry when a transient 529 is nested as the error cause', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        if (promptCallCount === 1) {
          // First attempt: a wrapper error with the transient 529 nested as cause.
          const wrapper = new Error('Step failed while streaming')
          ;(wrapper as Error & { cause?: unknown }).cause = new APICallError({
            message: 'Overloaded',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: undefined,
            responseBody: undefined,
            isRetryable: true,
            data: undefined,
          })
          throw wrapper
        }
        // Second attempt: succeed
        yield { type: 'text' as const, text: 'Success after retry\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have unwrapped the cause, recognized the 529, and retried.
      expect(promptCallCount).toBe(2)
      expect(result.output.type).not.toBe('error')
    })

    it('should exhaust retries on persistent AI_NoOutputGeneratedError (capped by MAX_STEP_RETRIES)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        const error = new Error(
          'No output generated. Check the stream for errors.',
        )
        error.name = 'AI_NoOutputGeneratedError'
        throw error
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have tried 3 times total (1 initial + MAX_STEP_RETRIES=2 retries).
      expect(promptCallCount).toBe(3)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('No output generated')
      }
    })

    it('should not retry non-retryable errors (e.g. 402 payment required)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        throw new APICallError({
          message: 'Not found',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 404,
          responseHeaders: undefined,
          responseBody: undefined,
          isRetryable: false,
          data: undefined,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have only tried once
      expect(promptCallCount).toBe(1)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Not found')
      }
    })

    it('should exhaust retries and return error after MAX_STEP_RETRIES + 1 attempts', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        // Always throw 500
        throw new APICallError({
          message: 'Internal server error',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 500,
          responseHeaders: undefined,
          responseBody: undefined,
          isRetryable: true,
          data: undefined,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      // Should have tried 3 times total (1 initial + 2 retries)
      expect(promptCallCount).toBe(3)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Internal server error')
      }
    })

    it('should abort immediately when signal fires during retry sleep', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const abortController = new AbortController()

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        throw new APICallError({
          message: 'Internal server error',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 500,
          responseHeaders: undefined,
          responseBody: undefined,
          isRetryable: true,
          data: undefined,
        })
      }

      // Abort the signal when the retry message is displayed (simulates user cancel during sleep)
      loopAgentStepsBaseParams.onResponseChunk = (chunk) => {
        if (typeof chunk === 'string' && chunk.includes('retrying')) {
          abortController.abort()
        }
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Should have only tried once - abort during sleep prevents second attempt
      expect(promptCallCount).toBe(1)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }
    })

    it('should not retry when signal is aborted', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const abortController = new AbortController()

      let promptCallCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        promptCallCount++
        // Abort after the first attempt
        abortController.abort()
        throw new APICallError({
          message: 'Internal server error',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 500,
          responseHeaders: undefined,
          responseBody: undefined,
          isRetryable: true,
          data: undefined,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Should have only tried once since signal was aborted
      expect(promptCallCount).toBe(1)
      // The error is caught by the outer catch and returned as cancelled or error
      expect(result.output.type).toBe('error')
    })
  })

  describe('abort handling', () => {
    it('should handle AbortError and finish with cancelled status', async () => {
      // Test that when an AbortError is thrown (e.g., from a tool handler),
      // loopAgentSteps catches it, finishes with 'cancelled' status, and returns
      // an error output indicating the run was cancelled.

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw an AbortError (simulating user cancellation mid-stream)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        // Yield some content first
        yield { type: 'text' as const, text: 'Starting work...\n' }
        // Then throw AbortError to simulate user cancellation
        throw new AbortError('User pressed Ctrl+C')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'cancelled' status
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('cancelled')
    })

    it('should distinguish AbortError from other errors', async () => {
      // Test that non-abort errors are NOT treated as cancellations

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw a regular error (not AbortError)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text: 'Starting...\n' }
        throw new Error('Network connection failed')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates an error (not cancellation)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Network connection failed')
        expect(result.output.message).not.toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'failed' status (not 'cancelled')
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('failed')
    })

    it('should handle signal.aborted before loop starts', async () => {
      // Test that if signal is already aborted when loopAgentSteps is called,
      // it returns immediately with a cancelled message

      const abortController = new AbortController()
      abortController.abort() // Abort immediately

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // LLM should not have been called since we aborted before starting
      expect(llmCallCount).toBe(0)
    })
  })

  describe('API error handling', () => {
    it('should propagate error code and server message from 403 APICallError responseBody', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Mock promptAiSdkStream to throw an APICallError with a 403 status
      // and a responseBody containing the server's structured error
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 403,
          message: 'Forbidden',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            message: 'Free mode is not available in your country.',
          }),
          isRetryable: false,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should use the server's message, NOT the generic "Forbidden"
        expect(result.output.message).toBe('Free mode is not available in your country.')
        // Server message should be used directly without agent error prefix
        expect(result.output.message).not.toMatch(/^Agent '/)
        // Should propagate the error code so the CLI can match on it
        expect(result.output.error).toBe('free_mode_unavailable')
        // Should propagate the status code
        expect(result.output.statusCode).toBe(403)
      }
    })

    it('should include agent identity in error message when responseBody has no parseable message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // APICallError with no responseBody
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 500,
          message: 'Internal Server Error',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: undefined,
          isRetryable: true,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should include agent identity and error message since there's no server message
        expect(result.output.message).toContain('Test Agent')
        expect(result.output.message).toContain('test-agent')
        expect(result.output.message).toContain('Internal Server Error')
        // No error code since responseBody wasn't parseable
        expect(result.output.error).toBeUndefined()
      }
    })
  })
})
