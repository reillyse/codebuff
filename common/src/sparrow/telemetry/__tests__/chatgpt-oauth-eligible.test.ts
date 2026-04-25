// SPARROW (telemetry): Tests for the `codebuff.chatgpt_oauth_eligible`
// attribute on gen_ai.chat spans. Three behaviors are exercised:
//
//   1. openai/* model on allowlist          => attribute = true
//   2. openai/* model NOT on allowlist      => attribute = false
//   3. non-openai model (Anthropic/Google)  => attribute is omitted
//
// The attribute is decoupled from the route so dashboards can count silent
// fallback misses with `chatgpt_oauth_eligible = true AND codebuff.route =
// codebuff_backend` (i.e. eligible model that didn't take the OAuth path).
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

describe('gen_ai.chat: chatgpt_oauth_eligible attribute', () => {
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

  it('sets eligible=true for an OpenAI model on the allowlist (gpt-5.4)', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5.4',
        route: 'chatgpt_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE]).toBe(true)
  })

  it('sets eligible=true for openai/gpt-5.1-chat (also on allowlist)', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5.1-chat',
        route: 'chatgpt_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE]).toBe(true)
  })

  it('sets eligible=false for an OpenAI model NOT on the allowlist (gpt-5-nano)', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5-nano',
        route: 'codebuff_backend',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE]).toBe(false)
  })

  it('sets eligible=false for openai/gpt-5-mini (not on allowlist)', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5-mini',
        route: 'codebuff_backend',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE]).toBe(false)
  })

  it('omits the attribute for an Anthropic model', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'anthropic/claude-opus-4.7',
        route: 'claude_oauth',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(
      getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE],
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
      getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })

  it('omits the attribute when no requestModel is provided', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({ route: 'codebuff_backend' })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    expect(
      getGenAiSpan().attributes[Attr.CHATGPT_OAUTH_ELIGIBLE],
    ).toBeUndefined()
  })

  it('eligible=true + route=codebuff_backend models the silent-fallback case', async () => {
    // This is the headline use-case: the model qualifies for chatgpt_oauth
    // but the call was routed to codebuff_backend (e.g. user has no creds).
    // Honeycomb dashboards filter on these two attrs together to count
    // these "missed OAuth" calls.
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        requestModel: 'openai/gpt-5.4',
        route: 'codebuff_backend',
      })
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })
    const span = getGenAiSpan()
    expect(span.attributes[Attr.CHATGPT_OAUTH_ELIGIBLE]).toBe(true)
    expect(span.attributes[Attr.ROUTE]).toBe('codebuff_backend')
  })
})
