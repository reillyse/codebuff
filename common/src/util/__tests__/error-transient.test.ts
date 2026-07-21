import { APICallError } from 'ai'
import { describe, expect, it } from 'bun:test'

import {
  NO_OUTPUT_GENERATED_ERROR_NAME,
  StreamStallError,
  describeTransientApiError,
  getContextOverflowSignal,
  getTransientStatusCode,
  isNoOutputGeneratedError,
  isStreamStallError,
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

describe('StreamStallError', () => {
  it('sets name, message, and structured fields', () => {
    const error = new StreamStallError(60_000, 'mid-stream')
    expect(error.name).toBe('StreamStallError')
    expect(error.stallMs).toBe(60_000)
    expect(error.phase).toBe('mid-stream')
    expect(error.message).toContain('60000')
    expect(error.message).toContain('mid-stream')
  })
})

describe('isStreamStallError', () => {
  it('detects a StreamStallError instance', () => {
    expect(isStreamStallError(new StreamStallError(120_000, 'first-chunk'))).toBe(
      true,
    )
  })

  it('detects by name so it survives serialization / cross-realm', () => {
    const plain = { name: 'StreamStallError', message: 'stalled' }
    expect(isStreamStallError(plain)).toBe(true)
  })

  it('returns false for unrelated errors and non-objects', () => {
    expect(isStreamStallError(new Error('boom'))).toBe(false)
    expect(isStreamStallError(null)).toBe(false)
    expect(isStreamStallError(undefined)).toBe(false)
    expect(isStreamStallError('StreamStallError')).toBe(false)
  })
})

describe('isTransientApiError - stream stall', () => {
  it('treats a StreamStallError as transient (retry on same model)', () => {
    expect(isTransientApiError(new StreamStallError(60_000, 'mid-stream'))).toBe(
      true,
    )
  })

  it('treats a StreamStallError nested in the cause chain as transient', () => {
    const wrapper = new Error('Step failed')
    ;(wrapper as Error & { cause?: unknown }).cause = new StreamStallError(
      60_000,
      'first-chunk',
    )
    expect(isTransientApiError(wrapper)).toBe(true)
  })
})

describe('describeTransientApiError - stream stall', () => {
  it('describes a stream stall distinctly from the no-output case', () => {
    expect(
      describeTransientApiError(new StreamStallError(60_000, 'mid-stream')),
    ).toBe('Response stream stalled (no data received)')
  })
})

describe('getTransientStatusCode', () => {
  it('returns a top-level transient status code', () => {
    expect(getTransientStatusCode(makeApiError(529))).toBe(529)
  })

  it('returns a transient status code nested in the cause chain', () => {
    const wrapper = new Error('Step failed while streaming')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(503)
    expect(getTransientStatusCode(wrapper)).toBe(503)
  })

  it('ignores non-transient status codes', () => {
    expect(getTransientStatusCode(makeApiError(400))).toBeUndefined()
  })

  it('finds the transient cause even when the wrapper has a non-transient code', () => {
    const wrapper = makeApiError(400, 'Bad request')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(529)
    expect(getTransientStatusCode(wrapper)).toBe(529)
  })

  it('returns undefined when no transient code exists', () => {
    expect(getTransientStatusCode(new Error('boom'))).toBeUndefined()
    expect(getTransientStatusCode(null)).toBeUndefined()
    expect(getTransientStatusCode(undefined)).toBeUndefined()
  })

  it('guards against cyclic cause chains', () => {
    const a = new Error('a')
    const b = new Error('b')
    ;(a as Error & { cause?: unknown }).cause = b
    ;(b as Error & { cause?: unknown }).cause = a
    expect(getTransientStatusCode(a)).toBeUndefined()
  })
})

describe('getContextOverflowSignal', () => {
  it('detects a top-level context-length message', () => {
    const error = new Error(
      "This endpoint's maximum context length is 200000 tokens. However, you requested about 201209 tokens.",
    )
    expect(getContextOverflowSignal(error)).toContain('maximum context length')
  })

  it('detects a context-overflow signal nested in the cause chain', () => {
    // Simulates an AI_NoOutputGeneratedError wrapping the real (swallowed)
    // context-length error mid-stream.
    const inner = new Error(
      'context_length_exceeded: the prompt is too long for this model',
    )
    const wrapper = new Error('No output generated.')
    wrapper.name = NO_OUTPUT_GENERATED_ERROR_NAME
    ;(wrapper as Error & { cause?: unknown }).cause = inner
    expect(getContextOverflowSignal(wrapper)).toContain('context_length_exceeded')
  })

  it('detects a context-overflow signal in an error responseBody', () => {
    const error = new Error('Request failed') as Error & {
      responseBody?: string
    }
    error.responseBody = JSON.stringify({
      error: { message: 'Please reduce the length of the messages.' },
    })
    expect(getContextOverflowSignal(error)).toContain('reduce the length')
  })

  it('returns undefined for a transient overload (no context signal)', () => {
    // A genuine 529 overload should NOT be misreported as context overflow.
    expect(getContextOverflowSignal(makeApiError(529, 'Overloaded'))).toBe(
      undefined,
    )
    expect(getContextOverflowSignal(new Error('Network error'))).toBe(undefined)
    expect(getContextOverflowSignal(null)).toBe(undefined)
    expect(getContextOverflowSignal(undefined)).toBe(undefined)
  })

  it('guards against cyclic cause chains', () => {
    const a = new Error('a')
    const b = new Error('b')
    ;(a as Error & { cause?: unknown }).cause = b
    ;(b as Error & { cause?: unknown }).cause = a
    expect(getContextOverflowSignal(a)).toBe(undefined)
  })
})

describe('describeTransientApiError', () => {
  it('describes a mid-stream AI_NoOutputGeneratedError (by name)', () => {
    const error = new Error('No output generated. Check the stream for errors.')
    error.name = NO_OUTPUT_GENERATED_ERROR_NAME
    expect(describeTransientApiError(error)).toBe(
      'Response stream interrupted (no output)',
    )
  })

  it('describes a mid-stream failure by "no output generated" message', () => {
    expect(
      describeTransientApiError(
        new Error('No output generated. Check the stream for errors.'),
      ),
    ).toBe('Response stream interrupted (no output)')
  })

  it('reports the nested transient code, not a misleading non-transient wrapper code', () => {
    // A 400 wrapper around a 529 cause is still transient (isTransientApiError
    // returns true); the description must show 529, not 400.
    const wrapper = makeApiError(400, 'Bad request')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(529)
    expect(describeTransientApiError(wrapper)).toBe('Transient API error (529)')
  })

  it('includes the status code for a top-level transient error', () => {
    expect(describeTransientApiError(makeApiError(529))).toBe(
      'Transient API error (529)',
    )
  })

  it('includes the status code for a nested-cause transient error', () => {
    const wrapper = new Error('Step failed while streaming')
    ;(wrapper as Error & { cause?: unknown }).cause = makeApiError(529)
    expect(describeTransientApiError(wrapper)).toBe(
      'Transient API error (529)',
    )
  })

  it('describes an overloaded message without a status code', () => {
    expect(
      describeTransientApiError(
        new Error('Overloaded. https://docs.claude.com'),
      ),
    ).toBe('Transient API error (provider overloaded)')
  })

  it('falls back to a generic description otherwise', () => {
    expect(describeTransientApiError(new Error('something else'))).toBe(
      'Transient API error',
    )
  })
})
