// SPARROW (telemetry): Tests for the `codebuff.claude_oauth_eligible`
// attribute on gen_ai.chat spans.
//
// Unlike the ChatGPT case there is no internal allowlist within the
// anthropic/* namespace — every Claude model the SDK recognizes can take
// the OAuth path. So this attribute is binary:
//
//   1. Anthropic model (anthropic/* or claude-*) => attribute = true
//   2. Non-Claude model (OpenAI, Google, etc.)   => attribute is omitted
//
// The attribute is decoupled from the route so dashboards can count silent
// fallback misses with `claude_oauth_eligible = true AND codebuff.route =
// codebuff_backend` (Claude call that didn't take the OAuth path).
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Attr, SpanNames } from '../attributes'
import { __resetHarvestCache, primeHarvestCache } from '../context-harvester'
import { recordLlmCall, withPromptSpan } from '../span-helpers'
import {
  __initTelemetryForTests,
  __resetTelemetryForTests,
} from '../tracer-provider'

describe('gen_ai.chat: claude_oauth_eligible attribute', () => {
  let exporter: InMemorySpanExporter

  beforeEach(async () => {
    __resetHarvestCache()
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
      serviceVersion: 'test',
    })
    await primeHarvestCache()
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
    __resetHarvestCache()
  })

  function getGenAiSpan() {
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === SpanNames.GEN_AI_CHAT)
    if (!span) throw new Error('expected a gen_ai.chat span')
    return span
  }

  it('sets eligible=true for an OpenRouter-style anthropic/* model', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'anthropic/claude-opus-4.7',
        route: 'claude_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE]).toBe(true)
  })

  it('sets eligible=true for anthropic/claude-sonnet-4.6', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'anthropic/claude-sonnet-4.6',
        route: 'claude_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE]).toBe(true)
  })

  it('sets eligible=true for a bare Anthropic id (claude-*)', async () => {
    // The SDK accepts both `anthropic/claude-*` and unprefixed `claude-*`
    // forms; both are eligible for the OAuth route.
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'claude-opus-4-7',
        route: 'claude_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE]).toBe(true)
  })

  it('omits the attribute for an OpenAI model', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5.4',
        route: 'chatgpt_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(
      getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })

  it('omits the attribute for a Google model', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'google/gemini-2.5-flash-lite',
        route: 'codebuff_backend',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(
      getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })

  it('omits the attribute when no requestModel is provided', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({ route: 'codebuff_backend' })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(
      getGenAiSpan().attributes[Attr.CLAUDE_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })

  it('eligible=true + route=codebuff_backend models the silent-fallback case', async () => {
    // The headline use-case: Claude model whose call ended up on the
    // codebuff_backend route. Two known causes (indistinguishable at the
    // span level today):
    //   (a) user has no Claude OAuth credentials installed
    //   (b) the call went through promptAiSdk / promptAiSdkStructured
    //       (backend-only by design \u2014 only promptAiSdkStream consults OAuth)
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'anthropic/claude-opus-4.7',
        route: 'codebuff_backend',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    const span = getGenAiSpan()
    expect(span.attributes[Attr.CLAUDE_OAUTH_ELIGIBLE]).toBe(true)
    expect(span.attributes[Attr.ROUTE]).toBe('codebuff_backend')
  })

  it('does not also set chatgpt_oauth_eligible for a Claude model', async () => {
    // Sanity: the two attributes are independent. A Claude model should
    // mark only claude_oauth_eligible, not chatgpt_oauth_eligible.
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'anthropic/claude-opus-4.7',
        route: 'claude_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    const span = getGenAiSpan()
    expect(span.attributes[Attr.CLAUDE_OAUTH_ELIGIBLE]).toBe(true)
    expect(
      span.attributes[Attr.CHATGPT_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })
})
