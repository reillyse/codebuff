import { describe, it, expect } from 'bun:test'

import {
  RETRY_NOTICE_MARKER,
  formatRetryNoticeCore,
  parseRetryNotice,
} from '../retry-notice'

describe('formatRetryNoticeCore', () => {
  it('builds the canonical core string', () => {
    expect(formatRetryNoticeCore(4, 2, 3)).toBe('retrying in 4s (attempt 2/3)')
  })

  it('embeds the shared marker so the CLI can cheap-reject non-notices', () => {
    expect(formatRetryNoticeCore(1, 1, 3).includes(RETRY_NOTICE_MARKER)).toBe(
      true,
    )
  })
})

describe('parseRetryNotice', () => {
  it('round-trips with formatRetryNoticeCore', () => {
    const parsed = parseRetryNotice(formatRetryNoticeCore(7, 3, 5))
    expect(parsed).toEqual({ delaySec: 7, attempt: 3, total: 5 })
  })

  it('parses a full decorated retry notice (with reason + decoration)', () => {
    const notice = `\n⚠️ The model returned an empty response, ${formatRetryNoticeCore(2, 2, 3)}...\n\n`
    expect(parseRetryNotice(notice)).toEqual({
      delaySec: 2,
      attempt: 2,
      total: 3,
    })
  })

  it('parses a notice that also carries a model-switch clause', () => {
    const notice = `\n⚠️ Provider overloaded — switching to openai/gpt-5, ${formatRetryNoticeCore(
      8,
      3,
      3,
    )}...\n\n`
    expect(parseRetryNotice(notice)).toEqual({
      delaySec: 8,
      attempt: 3,
      total: 3,
    })
  })

  it('returns null for ordinary content without the marker', () => {
    expect(parseRetryNotice('Here is some ordinary streamed text.')).toBeNull()
  })

  it('returns null for a chunk that has the marker but not the full pattern', () => {
    // The marker substring appears but the attempt counter is missing, so the
    // fuller regex must reject it (guards against false positives).
    expect(parseRetryNotice('I am retrying in a moment.')).toBeNull()
  })
})
