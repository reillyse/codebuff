import { describe, it, expect } from 'bun:test'

import {
  CURRENT_FABLE_MODEL,
  CURRENT_GPT5_MODEL,
  CURRENT_HAIKU_MODEL,
  CURRENT_OPUS_MODEL,
  CURRENT_SONNET_MODEL,
  getOverloadFallbackModel,
} from '../model-config'

import type { Model } from '../model-config'

describe('getOverloadFallbackModel', () => {
  it('steps sonnet-5 down to a sibling Anthropic model (haiku)', () => {
    expect(getOverloadFallbackModel(CURRENT_SONNET_MODEL)).toBe(
      CURRENT_HAIKU_MODEL,
    )
  })

  it('steps fable-5 down to sonnet-5', () => {
    expect(getOverloadFallbackModel(CURRENT_FABLE_MODEL)).toBe(
      CURRENT_SONNET_MODEL,
    )
  })

  it('steps opus down to sonnet-5', () => {
    expect(getOverloadFallbackModel(CURRENT_OPUS_MODEL)).toBe(
      CURRENT_SONNET_MODEL,
    )
  })

  it('crosses providers from haiku to GPT-5', () => {
    expect(getOverloadFallbackModel(CURRENT_HAIKU_MODEL)).toBe(
      CURRENT_GPT5_MODEL,
    )
  })

  it('escalates an arbitrary Anthropic model straight to GPT-5', () => {
    expect(
      getOverloadFallbackModel('anthropic/claude-3.5-sonnet-20240620'),
    ).toBe(CURRENT_GPT5_MODEL)
  })

  it('returns undefined once already on an OpenAI model (no further fallback)', () => {
    expect(getOverloadFallbackModel(CURRENT_GPT5_MODEL)).toBeUndefined()
  })

  it('escapes a non-Anthropic, non-OpenAI model to GPT-5', () => {
    expect(
      getOverloadFallbackModel('google/gemini-3.1-flash-lite-preview'),
    ).toBe(CURRENT_GPT5_MODEL)
  })

  it('produces a terminating escalation chain from sonnet-5', () => {
    const chain: Model[] = []
    let current: Model | undefined = CURRENT_SONNET_MODEL
    // Guard against an accidental infinite loop in the ladder.
    for (let i = 0; i < 10 && current !== undefined; i++) {
      chain.push(current)
      current = getOverloadFallbackModel(current)
    }

    // The chain must terminate (getOverloadFallbackModel eventually returns
    // undefined) rather than cycle forever.
    expect(current).toBeUndefined()
    // It must leave Anthropic by ending on an OpenAI model.
    expect(chain[chain.length - 1].startsWith('openai/')).toBe(true)
    // Concretely: sonnet-5 -> haiku-4.5 -> gpt-5.
    expect(chain).toEqual([
      CURRENT_SONNET_MODEL,
      CURRENT_HAIKU_MODEL,
      CURRENT_GPT5_MODEL,
    ])
  })
})
