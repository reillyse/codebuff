import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { getPromptLogPath, isPromptLoggingEnabled, logPrompt, logResponse } from '../prompt-logger'
import type { AgentMode } from '../hippo'

const MB = 1024 * 1024

const makePromptParams = (prompt = 'test') => ({
  prompt,
  enrichedPrompt: prompt,
  sessionId: 'test-session',
  agentMode: 'default' as AgentMode,
})

const makeResponseParams = (streamedText = 'response') => ({
  prompt: 'test',
  sessionId: 'test-session',
  agentMode: 'default' as AgentMode,
  streamedText,
  elapsedMs: 100,
  totalCost: 0.01,
  outputType: 'success',
})

const generateLines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line-${i.toString().padStart(8, '0')}: ${'x'.repeat(100)}`).join('\n')

const bytesPerLine = 117 // "line-XXXXXXXX: " (16) + 100 'x' chars + '\n' (1) = 117
const linesForBytes = (bytes: number) => Math.ceil(bytes / bytesPerLine)

describe('getPromptLogPath', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_PROMPT_LOG
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_PROMPT_LOG
    } else {
      process.env.CODEBUFF_PROMPT_LOG = savedEnv
    }
  })

  test('returns null when env is unset', () => {
    delete process.env.CODEBUFF_PROMPT_LOG
    expect(getPromptLogPath()).toBeNull()
  })

  test('returns null when env is "0"', () => {
    process.env.CODEBUFF_PROMPT_LOG = '0'
    expect(getPromptLogPath()).toBeNull()
  })

  test('returns null when env is "false"', () => {
    process.env.CODEBUFF_PROMPT_LOG = 'false'
    expect(getPromptLogPath()).toBeNull()
  })

  test('returns custom path when env is a file path', () => {
    process.env.CODEBUFF_PROMPT_LOG = '/tmp/custom-log.txt'
    expect(getPromptLogPath()).toBe('/tmp/custom-log.txt')
  })

  test('returns default path when env is "1"', () => {
    process.env.CODEBUFF_PROMPT_LOG = '1'
    expect(getPromptLogPath()).toBe(path.resolve(process.cwd(), 'debug', 'prompt-log.txt'))
  })

  test('returns default path when env is "true"', () => {
    process.env.CODEBUFF_PROMPT_LOG = 'true'
    expect(getPromptLogPath()).toBe(path.resolve(process.cwd(), 'debug', 'prompt-log.txt'))
  })
})

describe('isPromptLoggingEnabled', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_PROMPT_LOG
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_PROMPT_LOG
    } else {
      process.env.CODEBUFF_PROMPT_LOG = savedEnv
    }
  })

  test('returns false by default', () => {
    delete process.env.CODEBUFF_PROMPT_LOG
    expect(isPromptLoggingEnabled()).toBe(false)
  })

  test('returns false when disabled', () => {
    process.env.CODEBUFF_PROMPT_LOG = '0'
    expect(isPromptLoggingEnabled()).toBe(false)
  })
})

describe('prompt-logger rolling truncation', () => {
  let tempDir: string
  let logFilePath: string
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_PROMPT_LOG
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-logger-test-'))
    logFilePath = path.join(tempDir, 'prompt-log.txt')
    process.env.CODEBUFF_PROMPT_LOG = logFilePath
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_PROMPT_LOG
    } else {
      process.env.CODEBUFF_PROMPT_LOG = savedEnv
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('file stays intact when under 5MB', () => {
    const data = generateLines(linesForBytes(3 * MB))
    fs.writeFileSync(logFilePath, data)
    const sizeBefore = fs.statSync(logFilePath).size

    logPrompt(makePromptParams())

    const sizeAfter = fs.statSync(logFilePath).size
    // File should have grown slightly (by the new entry), not been truncated
    expect(sizeAfter).toBeGreaterThan(sizeBefore)
    expect(sizeAfter).toBeLessThan(5 * MB)
  })

  test('file is truncated when it exceeds 5MB', () => {
    const data = generateLines(linesForBytes(6 * MB))
    fs.writeFileSync(logFilePath, data)
    expect(fs.statSync(logFilePath).size).toBeGreaterThan(5 * MB)

    logPrompt(makePromptParams())

    const sizeAfter = fs.statSync(logFilePath).size
    // After truncation: ~2.5MB + header + new entry
    expect(sizeAfter).toBeLessThan(3 * MB)
    expect(sizeAfter).toBeGreaterThan(2 * MB)
  })

  test('truncation keeps the last ~2.5MB of data', () => {
    const totalLines = linesForBytes(6 * MB)
    const data = generateLines(totalLines)
    fs.writeFileSync(logFilePath, data)

    logPrompt(makePromptParams())

    const content = fs.readFileSync(logFilePath, 'utf-8')
    // Should NOT contain early lines
    expect(content).not.toContain('line-00000000:')
    expect(content).not.toContain('line-00000001:')
    // Should contain lines from near the end
    const lastLine = `line-${(totalLines - 1).toString().padStart(8, '0')}`
    expect(content).toContain(lastLine)
  })

  test('truncation snaps to newline boundary', () => {
    const data = generateLines(linesForBytes(6 * MB))
    fs.writeFileSync(logFilePath, data)

    logPrompt(makePromptParams())

    const content = fs.readFileSync(logFilePath, 'utf-8')
    // After the truncation header, the next content should start at a line boundary
    // The header is: [truncated — kept last ~2.5MB]\n\n
    const headerEnd = content.indexOf('\n\n') + 2
    const afterHeader = content.slice(headerEnd)
    // The first character after the header should be the start of a complete line
    expect(afterHeader).toMatch(/^line-\d{8}:/)
  })

  test('truncation header is prepended', () => {
    const data = generateLines(linesForBytes(6 * MB))
    fs.writeFileSync(logFilePath, data)

    logPrompt(makePromptParams())

    const content = fs.readFileSync(logFilePath, 'utf-8')
    expect(content.startsWith('[truncated')).toBe(true)
    expect(content).toContain('kept last ~2.5MB')
  })

  test('post-append truncation triggers when a large entry pushes past 5MB', () => {
    // Pre-seed at 4.9MB — just under the limit
    const data = generateLines(linesForBytes(4.9 * MB))
    fs.writeFileSync(logFilePath, data)
    expect(fs.statSync(logFilePath).size).toBeLessThan(5 * MB)

    // Append a 200KB prompt to push over 5MB
    const largePrompt = 'y'.repeat(200 * 1024)
    logPrompt(makePromptParams(largePrompt))

    const sizeAfter = fs.statSync(logFilePath).size
    // Post-append truncation should have kicked in
    expect(sizeAfter).toBeLessThan(3 * MB)
    expect(sizeAfter).toBeGreaterThan(2 * MB)
  })

  test('multiple truncation cycles produce a valid file under 5MB', () => {
    // Cycle 1: write 6MB, trigger truncation
    fs.writeFileSync(logFilePath, generateLines(linesForBytes(6 * MB)))
    logPrompt(makePromptParams('cycle-1'))
    const sizeAfter1 = fs.statSync(logFilePath).size
    expect(sizeAfter1).toBeLessThan(3 * MB)

    // Cycle 2: append enough to push past 5MB again
    const moreData = generateLines(linesForBytes(3 * MB))
    fs.appendFileSync(logFilePath, moreData)
    logPrompt(makePromptParams('cycle-2'))
    const sizeAfter2 = fs.statSync(logFilePath).size
    expect(sizeAfter2).toBeLessThan(3 * MB)

    // Cycle 3: one more round
    fs.appendFileSync(logFilePath, generateLines(linesForBytes(3 * MB)))
    logPrompt(makePromptParams('cycle-3'))
    const sizeAfter3 = fs.statSync(logFilePath).size
    expect(sizeAfter3).toBeLessThan(3 * MB)

    // File should still be readable and contain recent data
    const content = fs.readFileSync(logFilePath, 'utf-8')
    expect(content).toContain('cycle-3')
  })

  test('log file is created when it does not exist', () => {
    expect(fs.existsSync(logFilePath)).toBe(false)

    logPrompt(makePromptParams('first entry'))

    expect(fs.existsSync(logFilePath)).toBe(true)
    const content = fs.readFileSync(logFilePath, 'utf-8')
    expect(content).toContain('first entry')
  })

  test('creates file and parent directories when they do not exist', () => {
    const nestedPath = path.join(tempDir, 'nested', 'deep', 'prompt.log')
    process.env.CODEBUFF_PROMPT_LOG = nestedPath
    expect(fs.existsSync(nestedPath)).toBe(false)

    logPrompt(makePromptParams('nested entry'))

    expect(fs.existsSync(nestedPath)).toBe(true)
    const content = fs.readFileSync(nestedPath, 'utf-8')
    expect(content).toContain('nested entry')
  })

  test('logResponse also triggers truncation', () => {
    const data = generateLines(linesForBytes(6 * MB))
    fs.writeFileSync(logFilePath, data)

    logResponse(makeResponseParams('done'))

    const sizeAfter = fs.statSync(logFilePath).size
    expect(sizeAfter).toBeLessThan(3 * MB)
    const content = fs.readFileSync(logFilePath, 'utf-8')
    expect(content).toContain('done')
  })
})

describe('prompt-logger disabled logging', () => {
  let tempDir: string
  let logFilePath: string
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_PROMPT_LOG
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-logger-disabled-'))
    logFilePath = path.join(tempDir, 'prompt-log.txt')
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_PROMPT_LOG
    } else {
      process.env.CODEBUFF_PROMPT_LOG = savedEnv
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('no file created when logging is disabled', () => {
    process.env.CODEBUFF_PROMPT_LOG = '0'
    logPrompt(makePromptParams('should not appear'))
    expect(fs.existsSync(logFilePath)).toBe(false)
  })
})
