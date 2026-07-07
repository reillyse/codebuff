import { describe, expect, it } from 'bun:test'

import {
  OPENROUTER_TO_ANTHROPIC_MODEL_MAP,
  isClaudeModel,
  toAnthropicModelId,
} from '../claude-oauth'

describe('toAnthropicModelId', () => {
  it('maps Fable OpenRouter ids to the Anthropic Fable id (subscription routing)', () => {
    expect(toAnthropicModelId('anthropic/claude-fable-5')).toBe('claude-fable-5')
    expect(toAnthropicModelId('anthropic/claude-fable-latest')).toBe(
      'claude-fable-5',
    )
  })

  it('maps Opus and Sonnet ids from the mapping table', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-4.8')).toBe(
      'claude-opus-4-8',
    )
    expect(toAnthropicModelId('anthropic/claude-sonnet-4.6')).toBe(
      'claude-sonnet-4-6',
    )
  })

  it('maps Sonnet 5 OpenRouter ids to the Anthropic Sonnet 5 id (subscription routing)', () => {
    expect(toAnthropicModelId('anthropic/claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
    expect(toAnthropicModelId('anthropic/claude-sonnet-latest')).toBe(
      'claude-sonnet-5',
    )
  })

  it('returns already-Anthropic ids unchanged', () => {
    expect(toAnthropicModelId('claude-fable-5')).toBe('claude-fable-5')
    expect(toAnthropicModelId('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('falls back to stripping the anthropic/ prefix for unmapped models', () => {
    expect(toAnthropicModelId('anthropic/claude-unknown-model')).toBe(
      'claude-unknown-model',
    )
  })

  it('throws for non-Anthropic prefixed models', () => {
    expect(() => toAnthropicModelId('openai/gpt-5')).toThrow()
  })

  it('has Fable registered in the mapping table', () => {
    expect(OPENROUTER_TO_ANTHROPIC_MODEL_MAP['anthropic/claude-fable-5']).toBe(
      'claude-fable-5',
    )
    expect(
      OPENROUTER_TO_ANTHROPIC_MODEL_MAP['anthropic/claude-fable-latest'],
    ).toBe('claude-fable-5')
  })
})

describe('isClaudeModel', () => {
  it('recognizes Fable as a Claude model eligible for OAuth', () => {
    expect(isClaudeModel('anthropic/claude-fable-5')).toBe(true)
    expect(isClaudeModel('claude-fable-5')).toBe(true)
  })

  it('does not treat non-Anthropic models as Claude models', () => {
    expect(isClaudeModel('openai/gpt-5')).toBe(false)
  })
})
