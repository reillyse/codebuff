import { APICallError } from 'ai'
import { describe, expect, it } from 'bun:test'

import {
  NO_OUTPUT_GENERATED_ERROR_NAME,
  isNoOutputGeneratedError,
  isTransientApiError,
} from '../error'

function makeApiError(statusCode: number, message = 'error'): APICallError {
  return new APICallError({
    message,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseHeaders: undefined,
    responseBody: undefined,
    isRetryable: undefined,
    data: undefined,
  })
}

describe('isNoOutputGeneratedError', () => {
  it('detects by error name', () => {
    const error = new Error('Something happened')
    error.name = NO_OUTPUT_GENERATED_ERROR_NAME
    expect(isNoOutputGeneratedError(error)).toBe(true)
  })

  it('detects by message fallback (case-insensitive)', () => {
    const error = new Error('No output generated. Check the stream for errors.')
    expect(isNoOutputGeneratedError(error)).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isNoOutputGeneratedError(new Error('boom'))).toBe(false)
    expect(isNoOutputGeneratedError(null)).toBe(false)
    expect(isNoOutputGeneratedError(undefined)).toBe(false)
    expect(isNoOutputGeneratedError('AI_NoOutputGeneratedError')).toBe(false)
  })
})

describe('isTransientApiError - status codes (existing behavior preserved)', () => {
  it('returns true for transient status codes', () => {
    for (const code of [500, 502, 503, 504, 529]) {
      expect(isTransientApiError(makeApiError(code))).toBe(true)
    }
  })

  it('returns false for non-transient status codes', () => {
    for (const code of [400, 401, 402, 403, 404]) {
      expect(isTransientApiError(makeApiError(code))).toBe(false)
    }
  })

  it('does NOT retry a non-transient status code even if message contains "overloaded"', () => {
    // Status code is authoritative for this error: a 400 should never retry.
    expect(isTransientApiError(makeApiError(400, 'Overloaded'))).toBe(false)
  })

  it('falls back to the "overloaded" message heuristic when no status code', () => {
    expect(
      isTransientApiError(new Error('Overloaded. https://docs.claude.com')),
    ).toBe(true)
  })

  it('returns false for plain errors with no transient signal', () => {
    expect(isTransientApiError(new Error('Network connection failed'))).toBe(
      false,
    )
    expect(isTransientApiError(null)).toBe(false)
    expect(isTransientApiError(undefined)).toBe(false)
    expect(isTransientApiError('string error')).toBe(false)
  })
})

describe('isTransientApiError - Option B (AI_NoOutputGeneratedError)', () => {
  it('treats AI_NoOutputGeneratedError as transient (by name)', () => {
    const error = new Error('No output generated. Check the stream for errors.')
    error.name = NO_OUTPUT_GENERATED_ERROR_NAME
    expect(isTransientApiError(error)).toBe(true)
  })

  it('treats a bare "No output generated" message as transient', () => {
    expect(
      isTransientApiError(
        new Error('No output generated. Check the stream for errors.'),
      ),
    ).toBe(true)
  })
})

describe('isTransientApiError - Option A (recursive cause chain)', () => {
  it('recognizes a transient 529 nested as a cause', () => {
    const wrapper = new Error('Wrapper error')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(529)
    expect(isTransientApiError(wrapper)).toBe(true)
  })

  it('recognizes an AI_NoOutputGeneratedError nested as a cause', () => {
    const inner = new Error('No output generated.')
    inner.name = NO_OUTPUT_GENERATED_ERROR_NAME
    const wrapper = new Error('Step failed')
    ;(wrapper as Error & { cause?: unknown }).cause = inner
    expect(isTransientApiError(wrapper)).toBe(true)
  })

  it('recognizes an "overloaded" message nested deep in the cause chain', () => {
    const root = new Error('Overloaded')
    const mid = new Error('mid')
    ;(mid as Error & { cause?: unknown }).cause = root
    const top = new Error('top')
    ;(top as Error & { cause?: unknown }).cause = mid
    expect(isTransientApiError(top)).toBe(true)
  })

  it('returns false when no link in the cause chain is transient', () => {
    const root = new Error('root failure')
    const top = new Error('top failure')
    ;(top as Error & { cause?: unknown }).cause = root
    expect(isTransientApiError(top)).toBe(false)
  })

  it('a non-transient status code wrapping a transient cause still retries (cause is inspected)', () => {
    const wrapper = makeApiError(400, 'Bad request')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(529)
    expect(isTransientApiError(wrapper)).toBe(true)
  })

  it('guards against cyclic cause chains without infinite recursion', () => {
    const a = new Error('a')
    const b = new Error('b')
    ;(a as Error & { cause?: unknown }).cause = b
    ;(b as Error & { cause?: unknown }).cause = a
    // Neither is transient; must terminate and return false.
    expect(isTransientApiError(a)).toBe(false)
  })

  it('guards against a self-referential cause', () => {
    const a = new Error('a')
    ;(a as Error & { cause?: unknown }).cause = a
    expect(isTransientApiError(a)).toBe(false)
  })
})
