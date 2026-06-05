import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'

import { formatCredits, printSubagentEnd, printSubagentStart, truncateForDebug } from '../output'

describe('truncateForDebug', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_DEBUG_TRUNCATE
    delete process.env.CODEBUFF_DEBUG_TRUNCATE
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_DEBUG_TRUNCATE
    } else {
      process.env.CODEBUFF_DEBUG_TRUNCATE = savedEnv
    }
  })

  describe('truncation', () => {
    test('leaves short strings untouched', () => {
      expect(truncateForDebug('hello')).toBe('hello')
    })

    test('returns exactly the limit length without a suffix', () => {
      const text = 'a'.repeat(500)
      expect(truncateForDebug(text)).toBe(text)
    })

    test('truncates strings longer than the limit and appends a suffix', () => {
      const text = 'a'.repeat(600)
      const result = truncateForDebug(text)
      expect(result).toBe('a'.repeat(500) + '... [+100 chars]')
    })

    test('reports the correct number of remaining chars', () => {
      const text = 'b'.repeat(750)
      expect(truncateForDebug(text)).toContain('[+250 chars]')
    })
  })

  describe('newline collapsing', () => {
    test('collapses internal newlines into single spaces', () => {
      expect(truncateForDebug('line1\nline2\nline3')).toBe('line1 line2 line3')
    })

    test('collapses surrounding whitespace around newlines', () => {
      expect(truncateForDebug('line1   \n   line2')).toBe('line1 line2')
    })

    test('collapses carriage-return newlines', () => {
      expect(truncateForDebug('line1\r\nline2')).toBe('line1 line2')
    })

    test('collapses newlines before applying the truncation limit', () => {
      // 300 chars + newline + 300 chars collapses to a single space → 601 chars
      const text = 'x'.repeat(300) + '\n' + 'y'.repeat(300)
      const result = truncateForDebug(text)
      expect(result.length).toBe(500 + '... [+101 chars]'.length)
      expect(result).not.toContain('\n')
    })
  })

  describe('non-string values', () => {
    test('stringifies objects as JSON', () => {
      expect(truncateForDebug({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}')
    })

    test('stringifies arrays as JSON', () => {
      expect(truncateForDebug([1, 2, 3])).toBe('[1,2,3]')
    })

    test('stringifies numbers', () => {
      expect(truncateForDebug(42)).toBe('42')
    })

    test('stringifies booleans', () => {
      expect(truncateForDebug(true)).toBe('true')
    })

    test('truncates large stringified objects', () => {
      const big = { data: 'z'.repeat(600) }
      const result = truncateForDebug(big)
      expect(result.length).toBeLessThan(JSON.stringify(big).length)
      expect(result).toContain('... [+')
    })

    test('falls back to String() when JSON.stringify throws (circular)', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(truncateForDebug(circular)).toBe('[object Object]')
    })
  })

  describe('CODEBUFF_DEBUG_TRUNCATE env var', () => {
    test('respects a custom limit', () => {
      process.env.CODEBUFF_DEBUG_TRUNCATE = '10'
      const result = truncateForDebug('a'.repeat(20))
      expect(result).toBe('a'.repeat(10) + '... [+10 chars]')
    })

    test('a value of 0 disables truncation', () => {
      process.env.CODEBUFF_DEBUG_TRUNCATE = '0'
      const text = 'a'.repeat(2000)
      expect(truncateForDebug(text)).toBe(text)
    })

    test('falls back to the default for non-numeric values', () => {
      process.env.CODEBUFF_DEBUG_TRUNCATE = 'not-a-number'
      const text = 'a'.repeat(600)
      expect(truncateForDebug(text)).toBe('a'.repeat(500) + '... [+100 chars]')
    })

    test('an empty string falls back to the default', () => {
      process.env.CODEBUFF_DEBUG_TRUNCATE = ''
      const text = 'a'.repeat(600)
      expect(truncateForDebug(text)).toBe('a'.repeat(500) + '... [+100 chars]')
    })
  })
})

describe('formatCredits', () => {
  test('converts credits to dollars at 100 credits per dollar', () => {
    expect(formatCredits(44)).toBe('44 credits ($0.44)')
  })

  test('formats whole-dollar amounts', () => {
    expect(formatCredits(100)).toBe('100 credits ($1.00)')
  })

  test('formats large amounts with thousands separators', () => {
    expect(formatCredits(12345)).toBe('12,345 credits ($123.45)')
  })

  test('formats zero', () => {
    expect(formatCredits(0)).toBe('0 credits ($0.00)')
  })
})

describe('printSubagentStart', () => {
  let writes: string[]
  let spy: ReturnType<typeof spyOn>
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_DEBUG_TRUNCATE
    delete process.env.CODEBUFF_DEBUG_TRUNCATE
    writes = []
    spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    spy.mockRestore()
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_DEBUG_TRUNCATE
    } else {
      process.env.CODEBUFF_DEBUG_TRUNCATE = savedEnv
    }
  })

  test('prints the agent name with model', () => {
    printSubagentStart('id-1', 'Commander', 'anthropic/claude-haiku-4.5')
    const out = writes.join('')
    expect(out).toContain('* Agent: Commander (anthropic/claude-haiku-4.5)')
  })

  test('prints the truncated prompt when provided', () => {
    printSubagentStart('id-1', 'Commander', undefined, 'Fetch the Linear ticket ENG-458')
    const out = writes.join('')
    expect(out).toContain('    prompt: Fetch the Linear ticket ENG-458')
  })

  test('truncates a long prompt', () => {
    printSubagentStart('id-1', 'Commander', undefined, 'x'.repeat(600))
    const out = writes.join('')
    expect(out).toContain('    prompt: ' + 'x'.repeat(500) + '... [+100 chars]')
  })

  test('collapses newlines in the prompt', () => {
    printSubagentStart('id-1', 'Commander', undefined, 'line1\nline2')
    const out = writes.join('')
    expect(out).toContain('    prompt: line1 line2')
  })

  test('omits the prompt line when no prompt is given', () => {
    printSubagentStart('id-1', 'Commander', 'some-model')
    const out = writes.join('')
    expect(out).not.toContain('prompt:')
  })

  test('omits the prompt line for an empty prompt', () => {
    printSubagentStart('id-1', 'Commander', 'some-model', '')
    const out = writes.join('')
    expect(out).not.toContain('prompt:')
  })

  test('prints the truncated params when provided', () => {
    printSubagentStart('id-1', 'Commander', undefined, undefined, { command: 'ls -la' })
    const out = writes.join('')
    expect(out).toContain('    params: {"command":"ls -la"}')
  })

  test('prints both prompt and params', () => {
    printSubagentStart('id-1', 'Commander', undefined, 'do a thing', { foo: 'bar' })
    const out = writes.join('')
    expect(out).toContain('    prompt: do a thing')
    expect(out).toContain('    params: {"foo":"bar"}')
  })

  test('omits the params line when no params are given', () => {
    printSubagentStart('id-1', 'Commander', 'some-model', 'prompt')
    const out = writes.join('')
    expect(out).not.toContain('params:')
  })

  test('omits the params line for an empty params object', () => {
    printSubagentStart('id-1', 'Commander', 'some-model', 'prompt', {})
    const out = writes.join('')
    expect(out).not.toContain('params:')
  })
})

describe('printSubagentEnd', () => {
  let writes: string[]
  let spy: ReturnType<typeof spyOn>
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.CODEBUFF_DEBUG_TRUNCATE
    delete process.env.CODEBUFF_DEBUG_TRUNCATE
    writes = []
    spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    spy.mockRestore()
    if (savedEnv === undefined) {
      delete process.env.CODEBUFF_DEBUG_TRUNCATE
    } else {
      process.env.CODEBUFF_DEBUG_TRUNCATE = savedEnv
    }
  })

  test('prints the finished agent name with model', () => {
    printSubagentEnd('id-1', 'Commander', 'anthropic/claude-haiku-4.5')
    const out = writes.join('')
    expect(out).toContain('* Agent finished: Commander (anthropic/claude-haiku-4.5)')
  })

  test('prints a generic line when no display name is given', () => {
    printSubagentEnd('id-1')
    const out = writes.join('')
    expect(out).toContain('* Agent finished')
  })

  test('prints the truncated prompt when provided', () => {
    printSubagentEnd('id-1', 'Commander', undefined, 'Fetch the Linear ticket ENG-458')
    const out = writes.join('')
    expect(out).toContain('    prompt: Fetch the Linear ticket ENG-458')
  })

  test('prints the truncated params when provided', () => {
    printSubagentEnd('id-1', 'Commander', undefined, undefined, { command: 'ls -la' })
    const out = writes.join('')
    expect(out).toContain('    params: {"command":"ls -la"}')
  })

  test('prints both prompt and params', () => {
    printSubagentEnd('id-1', 'Commander', undefined, 'do a thing', { foo: 'bar' })
    const out = writes.join('')
    expect(out).toContain('    prompt: do a thing')
    expect(out).toContain('    params: {"foo":"bar"}')
  })

  test('omits the prompt and params lines when not given', () => {
    printSubagentEnd('id-1', 'Commander', 'some-model')
    const out = writes.join('')
    expect(out).not.toContain('prompt:')
    expect(out).not.toContain('params:')
  })

  test('omits the params line for an empty params object', () => {
    printSubagentEnd('id-1', 'Commander', 'some-model', 'prompt', {})
    const out = writes.join('')
    expect(out).not.toContain('params:')
  })
})
