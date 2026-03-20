import * as childProcess from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import {
  extractBriefTopics,
  generateHippoSessionId,
  HIPPO_BINARY,
  resetHippoEnabledCache,
  resetHippoSessionState,
  resolveHippoBinary,
  storePruningSummaryToHippo,
} from '../hippo-hooks'
import { logger } from '../logger'
import * as settings from '../settings'

import type { RunState } from '@codebuff/sdk'
import type { AgentMode } from '../constants'

describe('resolveHippoBinary', () => {
  let originalHippoPath: string | undefined
  let originalPath: string | undefined

  beforeEach(() => {
    originalHippoPath = process.env.HIPPO_PATH
    originalPath = process.env.PATH
  })

  afterEach(() => {
    if (originalHippoPath !== undefined) {
      process.env.HIPPO_PATH = originalHippoPath
    } else {
      delete process.env.HIPPO_PATH
    }
    if (originalPath !== undefined) {
      process.env.PATH = originalPath
    } else {
      delete process.env.PATH
    }
  })

  it('should return HIPPO_PATH when env var is set', () => {
    process.env.HIPPO_PATH = '/custom/path/to/hippo'
    expect(resolveHippoBinary()).toBe('/custom/path/to/hippo')
  })

  it('should return a non-empty string when HIPPO_PATH is not set', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('should find hippo via PATH or fall back to dev path when HIPPO_PATH is not set', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    const devFallback = path.join(os.homedir(), 'Programming/hippo/build/hippo')
    // Result is either a PATH-resolved binary or the dev fallback
    expect(result === devFallback || result.endsWith('/hippo')).toBe(true)
  })

  it('should always return a path ending with hippo', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    expect(result).toMatch(/hippo$/)
  })

  it('dev fallback path should be under home directory', () => {
    // Verify the dev fallback path format is correct
    const devFallback = path.join(os.homedir(), 'Programming/hippo/build/hippo')
    expect(devFallback).toContain(os.homedir())
    expect(devFallback).toMatch(/Programming\/hippo\/build\/hippo$/)
  })
})

describe('HIPPO_BINARY', () => {
  it('should be a non-empty string', () => {
    expect(typeof HIPPO_BINARY).toBe('string')
    expect(HIPPO_BINARY.length).toBeGreaterThan(0)
  })

  it('should end with hippo', () => {
    expect(HIPPO_BINARY).toMatch(/hippo$/)
  })
})

describe('resetHippoSessionState', () => {
  it('should not throw when called', () => {
    expect(() => resetHippoSessionState()).not.toThrow()
  })

  it('should be safe to call multiple times', () => {
    resetHippoSessionState()
    resetHippoSessionState()
    resetHippoSessionState()
  })
})

describe('resetHippoEnabledCache', () => {
  it('should not throw when called', () => {
    expect(() => resetHippoEnabledCache()).not.toThrow()
  })
})

describe('generateHippoSessionId', () => {
  it('should return a string starting with codebuff-', () => {
    const id = generateHippoSessionId('DEFAULT' as AgentMode)
    expect(id).toMatch(/^codebuff-/)
  })

  it('should include the lowercased agent mode', () => {
    const id = generateHippoSessionId('MAX' as AgentMode)
    expect(id).toContain('-max-')
  })

  it('should include a date component', () => {
    const id = generateHippoSessionId('DEFAULT' as AgentMode)
    // Should match pattern: codebuff-default-YYYY-MM-DD-HHmm
    expect(id).toMatch(/^codebuff-default-\d{4}-\d{2}-\d{2}-\d{4}$/)
  })

  it('should return different IDs for different modes', () => {
    const defaultId = generateHippoSessionId('DEFAULT' as AgentMode)
    const maxId = generateHippoSessionId('MAX' as AgentMode)
    expect(defaultId).not.toBe(maxId)
  })
})

// =============================================================================
// extractBriefTopics
// =============================================================================

describe('extractBriefTopics', () => {
  it('should strip [USER] markers and return content', () => {
    const result = extractBriefTopics('[USER]\nFix the login bug')
    expect(result).toBe('Fix the login bug')
  })

  it('should strip [ASSISTANT] markers and return content', () => {
    const result = extractBriefTopics('[ASSISTANT]\nI found the issue in auth.ts')
    expect(result).toBe('I found the issue in auth.ts')
  })

  it('should strip [TOOL ERROR] markers', () => {
    const result = extractBriefTopics('[TOOL ERROR: str_replace] File not found')
    expect(result).toBe('File not found')
  })

  it('should strip [COMMAND FAILED] markers', () => {
    const result = extractBriefTopics('[COMMAND FAILED] Exit code: 1')
    expect(result).toBe('Exit code: 1')
  })

  it('should strip [PREVIOUS SUMMARY] markers', () => {
    const result = extractBriefTopics('[PREVIOUS SUMMARY]\nEarlier we discussed refactoring')
    expect(result).toBe('Earlier we discussed refactoring')
  })

  it('should strip [CONVERSATION TRUNCATED] markers', () => {
    const result = extractBriefTopics('[CONVERSATION TRUNCATED - Earlier messages omitted due to length]\nRecent discussion')
    expect(result).toBe('Recent discussion')
  })

  it('should skip --- separator lines', () => {
    const result = extractBriefTopics('First topic\n---\nSecond topic')
    expect(result).toBe('First topic; Second topic')
  })

  it('should skip empty lines', () => {
    const result = extractBriefTopics('\n\nHello world\n\n\nAnother line\n')
    expect(result).toBe('Hello world; Another line')
  })

  it('should return "general conversation" for empty input', () => {
    expect(extractBriefTopics('')).toBe('general conversation')
  })

  it('should return "general conversation" for input with only markers and separators', () => {
    const result = extractBriefTopics('[USER]\n---\n[ASSISTANT]\n---\n')
    expect(result).toBe('general conversation')
  })

  it('should join multiple fragments with "; "', () => {
    const result = extractBriefTopics('Topic A\nTopic B\nTopic C')
    expect(result).toBe('Topic A; Topic B; Topic C')
  })

  it('should respect the ~200 char limit', () => {
    const longLine = 'A'.repeat(250)
    const result = extractBriefTopics(longLine)
    // Should truncate and add '...'
    expect(result.length).toBeLessThanOrEqual(204) // 200 + '...'
    expect(result).toContain('...')
  })

  it('should truncate when multiple lines exceed 200 chars total', () => {
    // Each line is ~80 chars, 3 lines would be ~240 total
    const lines = [
      'A'.repeat(80),
      'B'.repeat(80),
      'C'.repeat(80),
    ].join('\n')
    const result = extractBriefTopics(lines)
    // Should include first two lines and truncate the third
    expect(result).toContain('A'.repeat(80))
    expect(result).toContain('B'.repeat(80))
    // Third line should be truncated or omitted
    expect(result.replace(/; /g, '').replace(/\.\.\./g, '').length).toBeLessThanOrEqual(210)
  })

  it('should handle mixed content with markers and real text', () => {
    const input = [
      '[USER]',
      'Fix the bug in auth.ts',
      '',
      '---',
      '',
      '[ASSISTANT]',
      'I found the issue and fixed it',
      '',
      '---',
      '',
      '[USER]',
      'Thanks! Now add tests',
    ].join('\n')

    const result = extractBriefTopics(input)
    expect(result).toContain('Fix the bug in auth.ts')
    expect(result).toContain('I found the issue and fixed it')
    expect(result).toContain('Thanks! Now add tests')
    expect(result).not.toContain('[USER]')
    expect(result).not.toContain('[ASSISTANT]')
  })

  it('should not truncate fragment when remaining chars is <= 20', () => {
    // Fill up close to the limit so remaining < 20
    const longContent = 'A'.repeat(190) + '\n' + 'Short extra'
    const result = extractBriefTopics(longContent)
    // Should include the first line but skip the second (remaining < 20)
    expect(result).toContain('A'.repeat(190))
    expect(result).not.toContain('Short extra')
  })
})

// =============================================================================
// storePruningSummaryToHippo
// =============================================================================

/** Helper to build a RunState with a conversation_summary in the first message */
const createRunStateWithSummary = (summaryContent: string): RunState => ({
  sessionState: {
    mainAgentState: {
      messageHistory: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<conversation_summary>\nThis is a summary of the conversation so far.\n\n${summaryContent}\n</conversation_summary>\n\nPlease continue the conversation.`,
            },
          ],
        },
      ],
    },
  },
} as unknown as RunState)

/** Helper to build a RunState without any conversation_summary */
const createRunStateWithoutSummary = (): RunState => ({
  sessionState: {
    mainAgentState: {
      messageHistory: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello, help me with something' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, what do you need?' },
          ],
        },
      ],
    },
  },
} as unknown as RunState)

describe('storePruningSummaryToHippo', () => {
  let existsSyncSpy: ReturnType<typeof spyOn>
  let loadSettingsSpy: ReturnType<typeof spyOn>
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetHippoEnabledCache()
    resetHippoSessionState()

    spyOn(logger, 'debug').mockImplementation(() => {})
    spyOn(logger, 'error').mockImplementation(() => {})

    loadSettingsSpy = spyOn(settings, 'loadSettings').mockReturnValue({
      hippoEnabled: true,
    })

    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((p: unknown) => {
      return p === HIPPO_BINARY
    })

    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation((() => ({
      unref: () => {},
    })) as unknown as typeof childProcess.spawn)
  })

  afterEach(() => {
    mock.restore()
  })

  it('should be a no-op when no conversation_summary in messages', () => {
    const runState = createRunStateWithoutSummary()

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('should be a no-op when message history is empty', () => {
    const runState = {
      sessionState: { mainAgentState: { messageHistory: [] } },
    } as unknown as RunState

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('should be a no-op when hippo is disabled', () => {
    loadSettingsSpy.mockReturnValue({ hippoEnabled: false })
    resetHippoEnabledCache()

    const runState = createRunStateWithSummary('[USER]\nFix the login bug')

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('should be a no-op when hippo binary does not exist', () => {
    existsSyncSpy.mockImplementation(() => false)
    resetHippoEnabledCache()

    const runState = createRunStateWithSummary('[USER]\nFix the login bug')

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('should store a lightweight pruning event with correct args', () => {
    const summaryContent = '[USER]\nFix the login bug\n\n---\n\n[ASSISTANT]\nI found and fixed the auth issue'
    const runState = createRunStateWithSummary(summaryContent)

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-42' })

    expect(spawnSpy).toHaveBeenCalledTimes(1)

    const [binary, args] = spawnSpy.mock.calls[0] as [string, string[]]
    expect(binary).toBe(HIPPO_BINARY)

    // Verify the args contain the expected structure
    expect(args).toContain('store')
    expect(args).toContain('--agent')
    expect(args).toContain('codebuff')
    expect(args).toContain('--session')
    expect(args).toContain('test-session-42')
    expect(args).toContain('--outcome')
    expect(args).toContain('discovery')
  })

  it('should include session ID in the --input field', () => {
    const runState = createRunStateWithSummary('[USER]\nSome conversation')

    storePruningSummaryToHippo({ runState, sessionId: 'my-session-123' })

    const [, args] = spawnSpy.mock.calls[0] as [string, string[]]
    const inputIdx = args.indexOf('--input')
    expect(inputIdx).not.toBe(-1)

    const inputValue = args[inputIdx + 1]
    expect(inputValue).toContain('my-session-123')
    expect(inputValue).toContain('Context pruned')
  })

  it('should include topics in the --output field, not the full summary', () => {
    const summaryContent = '[USER]\nFix the login bug in auth.ts\n\n---\n\n[ASSISTANT]\nI refactored the authentication module'
    const runState = createRunStateWithSummary(summaryContent)

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    const [, args] = spawnSpy.mock.calls[0] as [string, string[]]
    const outputIdx = args.indexOf('--output')
    expect(outputIdx).not.toBe(-1)

    const outputValue = args[outputIdx + 1]
    // Should contain the pruning note
    expect(outputValue).toContain('Context was pruned during this session')
    expect(outputValue).toContain('Topics discussed before pruning')
    // Should contain extracted topics (marker-stripped content)
    expect(outputValue).toContain('Fix the login bug in auth.ts')
    // Should NOT contain the full summary markers
    expect(outputValue).not.toContain('[USER]')
    expect(outputValue).not.toContain('[ASSISTANT]')
    // Should be much shorter than the full summary
    expect(outputValue.length).toBeLessThan(summaryContent.length + 200)
  })

  it('should deduplicate: skip second call with the same summary', () => {
    const runState = createRunStateWithSummary('[USER]\nFix the login bug')

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })
    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    // spawn should only be called once (second call skipped by deduplication)
    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })

  it('should store again after resetHippoSessionState clears deduplication', () => {
    const runState = createRunStateWithSummary('[USER]\nFix the login bug')

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })
    resetHippoSessionState()
    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).toHaveBeenCalledTimes(2)
  })

  it('should store a new event when summary content changes', () => {
    const runState1 = createRunStateWithSummary('[USER]\nFirst conversation topic')
    const runState2 = createRunStateWithSummary('[USER]\nCompletely different conversation')

    storePruningSummaryToHippo({ runState: runState1, sessionId: 'test-session-1' })
    storePruningSummaryToHippo({ runState: runState2, sessionId: 'test-session-1' })

    // Both should be stored since summaries differ
    expect(spawnSpy).toHaveBeenCalledTimes(2)
  })

  it('should find conversation_summary even if not in the first message', () => {
    const runState = {
      sessionState: {
        mainAgentState: {
          messageHistory: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Some assistant response' }],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '<conversation_summary>\n[USER]\nA topic\n</conversation_summary>\n\nContinue.',
                },
              ],
            },
          ],
        },
      },
    } as unknown as RunState

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })

  it('should not search beyond the first 5 messages for conversation_summary', () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `Message ${i}` }],
    }))
    // Place the summary in position 5 (index 5, beyond the search limit)
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<conversation_summary>\n[USER]\nHidden topic\n</conversation_summary>',
        },
      ],
    })

    const runState = {
      sessionState: { mainAgentState: { messageHistory: messages } },
    } as unknown as RunState

    storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('should not throw when runState has no sessionState', () => {
    const runState = {} as unknown as RunState

    expect(() => {
      storePruningSummaryToHippo({ runState, sessionId: 'test-session-1' })
    }).not.toThrow()

    expect(spawnSpy).not.toHaveBeenCalled()
  })
})
