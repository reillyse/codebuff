import { describe, expect, it } from 'bun:test'

import {
  LIVE_ANTHROPIC_MODEL_IDS,
  OPENROUTER_TO_ANTHROPIC_MODEL_MAP,
  RETIRED_MODEL_SUCCESSORS,
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

  it('validates bare Anthropic ids instead of passing them straight through', () => {
    // A bare (unprefixed) id used to short-circuit before any validation, so a
    // retired id like this reached the API and 404'd.
    expect(() => toAnthropicModelId('claude-sonnet-4-20250514')).toThrow(
      /has been retired/,
    )
    expect(() => toAnthropicModelId('claude-3-5-sonnet')).toThrow(
      /has been retired/,
    )
    expect(() => toAnthropicModelId('claude-nonsense')).toThrow(
      /Unknown Anthropic model/,
    )
  })

  it('handles fully-versioned retired ids in both prefixed and bare form', () => {
    for (const id of [
      'anthropic/claude-sonnet-4-20250514',
      'claude-sonnet-4-20250514',
      'anthropic/claude-opus-4-1-20250805',
      'claude-opus-4-1-20250805',
      'anthropic/claude-haiku-4-20250514',
      'claude-haiku-4-20250514',
    ]) {
      expect(() => toAnthropicModelId(id), id).toThrow(/has been retired/)
    }
  })

  it('strips the anthropic/ prefix for unmapped models that are known to be live', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-4-7')).toBe(
      'claude-opus-4-7',
    )
  })

  it('throws for an unmapped model that is not known to be live', () => {
    // Silently stripping the prefix here used to send a dead model ID to the
    // API, which 404s inside the stream and resurfaces as an opaque
    // "No output generated" that the retry ladder treats as transient.
    expect(() => toAnthropicModelId('anthropic/claude-unknown-model')).toThrow(
      /Unknown Anthropic model/,
    )
  })

  it('throws for retired models rather than silently substituting a successor', () => {
    // These are all retired at Anthropic. Routing them to a live model would
    // hide a bad pin and could move the caller onto a pricier model.
    const retired = [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-4-sonnet-20250522',
      'anthropic/claude-opus-4.1',
      'anthropic/claude-3-opus',
      'anthropic/claude-haiku-4',
      // An output-speed mode, not a distinct API model.
      'anthropic/claude-opus-5-fast',
    ]
    for (const model of retired) {
      expect(() => toAnthropicModelId(model)).toThrow(/has been retired/)
    }
  })

  it('names the replacement model when a retired pin is used', () => {
    expect(() => toAnthropicModelId('anthropic/claude-sonnet-4')).toThrow(
      /Use "anthropic\/claude-sonnet-5" instead/,
    )
    expect(() => toAnthropicModelId('anthropic/claude-3-opus')).toThrow(
      /Use "anthropic\/claude-opus-5" instead/,
    )
  })

  it('points every retired model at a successor that is itself routable', () => {
    for (const [retired, successor] of Object.entries(
      RETIRED_MODEL_SUCCESSORS,
    )) {
      expect(
        OPENROUTER_TO_ANTHROPIC_MODEL_MAP[successor],
        `${retired} points at "${successor}", which is not a routable model`,
      ).toBeDefined()
    }
  })

  it('does not list any retired model as routable', () => {
    for (const retired of Object.keys(RETIRED_MODEL_SUCCESSORS)) {
      expect(
        OPENROUTER_TO_ANTHROPIC_MODEL_MAP[retired],
        `${retired} is retired but still present in the routing table`,
      ).toBeUndefined()
    }
  })

  it('only ever maps to model IDs that are actually reachable', () => {
    // Guards the whole table against a future edit reintroducing a dead target.
    for (const [openrouterId, anthropicId] of Object.entries(
      OPENROUTER_TO_ANTHROPIC_MODEL_MAP,
    )) {
      expect(
        LIVE_ANTHROPIC_MODEL_IDS.has(anthropicId),
        `${openrouterId} maps to "${anthropicId}", which is not in LIVE_ANTHROPIC_MODEL_IDS`,
      ).toBe(true)
    }
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
