import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'

import { ttyNormalize, writeOut, writeErr } from '../tty'

describe('tty', () => {
  // Save and restore process.stdin.isRaw between tests
  let originalIsRaw: boolean | undefined

  beforeEach(() => {
    originalIsRaw = (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw
  })

  afterEach(() => {
    ;(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw = originalIsRaw as boolean
  })

  function setRawMode(value: boolean | undefined): void {
    ;(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw = value as boolean
  }

  describe('ttyNormalize', () => {
    test('returns text unchanged when isRaw is undefined', () => {
      setRawMode(undefined)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\nworld\n')
    })

    test('returns text unchanged when isRaw is false', () => {
      setRawMode(false)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\nworld\n')
    })

    test('converts bare \\n to \\r\\n when isRaw is true', () => {
      setRawMode(true)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\r\nworld\r\n')
    })

    test('does not double-convert existing \\r\\n', () => {
      setRawMode(true)
      expect(ttyNormalize('hello\r\nworld\r\n')).toBe('hello\r\nworld\r\n')
    })

    test('handles mixed \\n and \\r\\n', () => {
      setRawMode(true)
      expect(ttyNormalize('line1\nline2\r\nline3\n')).toBe('line1\r\nline2\r\nline3\r\n')
    })

    test('handles empty string', () => {
      setRawMode(true)
      expect(ttyNormalize('')).toBe('')
    })

    test('handles string with no newlines', () => {
      setRawMode(true)
      expect(ttyNormalize('no newlines here')).toBe('no newlines here')
    })

    test('handles multiple consecutive newlines', () => {
      setRawMode(true)
      expect(ttyNormalize('\n\n\n')).toBe('\r\n\r\n\r\n')
    })

    test('handles text with ANSI escape codes and newlines', () => {
      setRawMode(true)
      const ansi = '\x1b[1mBold\x1b[0m\nNext line\n'
      expect(ttyNormalize(ansi)).toBe('\x1b[1mBold\x1b[0m\r\nNext line\r\n')
    })

    test('handles cursor control sequences without newlines (no-op)', () => {
      setRawMode(true)
      const cursorControl = '\r\x1b[K'
      expect(ttyNormalize(cursorControl)).toBe('\r\x1b[K')
    })
  })

  describe('writeOut', () => {
    test('writes to stdout', () => {
      setRawMode(false)
      const spy = spyOn(process.stdout, 'write').mockReturnValue(true)
      writeOut('hello')
      expect(spy).toHaveBeenCalledWith('hello')
      spy.mockRestore()
    })

    test('normalizes newlines in raw mode', () => {
      setRawMode(true)
      const spy = spyOn(process.stdout, 'write').mockReturnValue(true)
      writeOut('line1\nline2\n')
      expect(spy).toHaveBeenCalledWith('line1\r\nline2\r\n')
      spy.mockRestore()
    })
  })

  describe('writeErr', () => {
    test('writes to stderr', () => {
      setRawMode(false)
      const spy = spyOn(process.stderr, 'write').mockReturnValue(true)
      writeErr('hello')
      expect(spy).toHaveBeenCalledWith('hello')
      spy.mockRestore()
    })

    test('normalizes newlines in raw mode', () => {
      setRawMode(true)
      const spy = spyOn(process.stderr, 'write').mockReturnValue(true)
      writeErr('line1\nline2\n')
      expect(spy).toHaveBeenCalledWith('line1\r\nline2\r\n')
      spy.mockRestore()
    })
  })

  describe('integration: simulated readline raw mode lifecycle', () => {
    test('normalization activates when raw mode is set and deactivates when cleared', () => {
      // Before readline: no raw mode
      setRawMode(false)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\nworld\n')

      // Simulate readline setting raw mode
      setRawMode(true)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\r\nworld\r\n')

      // Simulate readline closing and clearing raw mode
      setRawMode(false)
      expect(ttyNormalize('hello\nworld\n')).toBe('hello\nworld\n')
    })
  })
})
