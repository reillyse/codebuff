import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { classifyLlmRoute, shouldCapturePrompts } from '../index'

describe('classifyLlmRoute', () => {
  it('returns claude_oauth when isClaudeOAuth is true (highest precedence)', () => {
    expect(
      classifyLlmRoute({
        isClaudeOAuth: true,
        isChatGptOAuth: true, // should be ignored
        viaCodebuffBackend: true, // should be ignored
      }),
    ).toBe('claude_oauth')
  })

  it('returns chatgpt_oauth when isChatGptOAuth is true and claude is not', () => {
    expect(
      classifyLlmRoute({
        isChatGptOAuth: true,
        viaCodebuffBackend: true, // should be ignored
      }),
    ).toBe('chatgpt_oauth')
  })

  it('returns codebuff_backend when viaCodebuffBackend is true and no OAuth flags', () => {
    expect(classifyLlmRoute({ viaCodebuffBackend: true })).toBe(
      'codebuff_backend',
    )
  })

  it('returns direct_<provider> when no backend/OAuth flags', () => {
    expect(classifyLlmRoute({ directProvider: 'openrouter' })).toBe(
      'direct_openrouter',
    )
    expect(classifyLlmRoute({ directProvider: 'anthropic' })).toBe(
      'direct_anthropic',
    )
  })

  it('lowercases the direct provider name', () => {
    expect(classifyLlmRoute({ directProvider: 'OpenRouter' })).toBe(
      'direct_openrouter',
    )
  })

  it('falls back to direct_unknown when no direct provider supplied', () => {
    expect(classifyLlmRoute({})).toBe('direct_unknown')
  })
})

describe('shouldCapturePrompts', () => {
  const original = process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS

  beforeEach(() => {
    delete process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS
    } else {
      process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = original
    }
  })

  it('returns false when env var is unset', () => {
    expect(shouldCapturePrompts()).toBe(false)
  })

  it('returns false for empty string', () => {
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = ''
    expect(shouldCapturePrompts()).toBe(false)
  })

  it('returns false for non-"full" values like "true" or "1"', () => {
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'true'
    expect(shouldCapturePrompts()).toBe(false)
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = '1'
    expect(shouldCapturePrompts()).toBe(false)
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'yes'
    expect(shouldCapturePrompts()).toBe(false)
  })

  it('returns true only for exact string "full"', () => {
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'full'
    expect(shouldCapturePrompts()).toBe(true)
  })

  it('is case-sensitive (Full ≠ full)', () => {
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'Full'
    expect(shouldCapturePrompts()).toBe(false)
  })
})
