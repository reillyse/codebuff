// SPARROW: Spec task 8.5 — OAuth fallback integration tests.
//
// Validates the shared-span contract enforced by `recordLlmCall()`: when a
// Claude or ChatGPT OAuth attempt fails and `promptAiSdkStream` recurses
// with `sparrowLlmHandle` threaded through, ALL attempts (failed + final
// succeeding) MUST land on the same `gen_ai.chat` span as events, and the
// final attributes MUST reflect only the succeeding attempt.
//
// These tests faithfully reproduce the exact handle-manipulation sequence
// that lives in `sdk/src/impl/llm.ts::promptAiSdkStream` — see the
// `// SPARROW:` comment blocks there for the call sites being exercised.
// This gives us high-signal coverage of the span contract without having
// to mock the `ai` SDK's `streamText()` end-to-end.

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Attr, Events, SpanNames } from '../attributes'
import { __resetHarvestCache, primeHarvestCache } from '../context-harvester'
import { recordLlmCall, withPromptSpan } from '../span-helpers'
import {
  __initTelemetryForTests,
  __resetTelemetryForTests,
} from '../tracer-provider'

function byName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name)
}
function byNameAll(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name)
}

/**
 * Pull the sequence of attempt events off a gen_ai.chat span in order.
 * Returns `{ name, attrs }[]` so tests can assert both the event name
 * (failed/succeeded) and the attributes (route, attempt, error, model).
 */
function attemptEvents(span: ReadableSpan) {
  return span.events
    .filter(
      (e) =>
        e.name === Events.ROUTE_ATTEMPT_FAILED ||
        e.name === Events.ROUTE_ATTEMPT_SUCCEEDED,
    )
    .map((e) => ({ name: e.name, attrs: e.attributes ?? {} }))
}

describe('telemetry integration: OAuth fallback (spec task 8.5)', () => {
  let exporter: InMemorySpanExporter

  beforeEach(async () => {
    __resetHarvestCache()
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
      serviceVersion: 'oauth-fallback-test',
    })
    await primeHarvestCache()
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
    __resetHarvestCache()
  })

  it('Claude OAuth rate-limit → codebuff_backend success: one span, failed+succeeded events, final attrs match attempt 2', async () => {
    // Faithful replay of the rate-limit path in promptAiSdkStream:
    //   - Top-level call opens the span with route_attempt=1 (claude_oauth).
    //   - Rate limit fires: recordAttempt({ succeeded: false,
    //     error: 'claude_oauth_rate_limited' }).
    //   - Recursive call (skipClaudeOAuth=true) classifies route as
    //     codebuff_backend and — on success — calls recordAttempt
    //     ({ succeeded: true, attempt: 2 }) + finalize(...) with cost/usage.
    //   - Only the top-level call owns end().
    await withPromptSpan({ sessionId: 's-rl' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        route: 'claude_oauth',
        routeAttempt: 1,
      })

      // Attempt 1: claude_oauth rate limited.
      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'anthropic/claude-sonnet-4',
        succeeded: false,
        error: 'claude_oauth_rate_limited',
      })

      // Attempt 2: fallback to codebuff_backend succeeds.
      llm.recordAttempt({
        attempt: 2,
        route: 'codebuff_backend',
        model: 'anthropic/claude-sonnet-4',
        succeeded: true,
      })
      llm.finalize({
        route: 'codebuff_backend',
        attempt: 2,
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        responseModel: 'anthropic/claude-sonnet-4-20250514',
        finishReason: 'stop',
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 100,
        costUsd: 0.0234,
        costCredits: 234,
      })
      llm.end()
    })

    const spans = exporter.getFinishedSpans()

    // Spec 8.5: "exactly one gen_ai.chat span".
    const chatSpans = byNameAll(spans, SpanNames.GEN_AI_CHAT)
    expect(chatSpans.length).toBe(1)
    const genAi = chatSpans[0]

    // Parent is the prompt span (not the handle being double-opened).
    const prompt = byName(spans, SpanNames.PROMPT)!
    expect(genAi.parentSpanContext?.spanId).toBe(prompt.spanContext().spanId)

    // Exactly two attempt events, in order: failed (claude_oauth) → succeeded (codebuff_backend).
    const events = attemptEvents(genAi)
    expect(events.length).toBe(2)
    expect(events[0].name).toBe(Events.ROUTE_ATTEMPT_FAILED)
    expect(events[0].attrs[Attr.ROUTE]).toBe('claude_oauth')
    expect(events[0].attrs[Attr.ROUTE_ATTEMPT]).toBe(1)
    expect(events[0].attrs.error).toBe('claude_oauth_rate_limited')
    expect(events[0].attrs[Attr.GEN_AI_REQUEST_MODEL]).toBe(
      'anthropic/claude-sonnet-4',
    )
    expect(events[1].name).toBe(Events.ROUTE_ATTEMPT_SUCCEEDED)
    expect(events[1].attrs[Attr.ROUTE]).toBe('codebuff_backend')
    expect(events[1].attrs[Attr.ROUTE_ATTEMPT]).toBe(2)
    // Succeeded events don't carry an 'error' attribute.
    expect(events[1].attrs.error).toBeUndefined()

    // Spec 8.5: "final attributes matching the successful attempt" — route
    // and attempt number must reflect attempt 2 (codebuff_backend), not the
    // initial claude_oauth attempt.
    expect(genAi.attributes[Attr.ROUTE]).toBe('codebuff_backend')
    expect(genAi.attributes[Attr.ROUTE_ATTEMPT]).toBe(2)
    expect(genAi.attributes[Attr.GEN_AI_RESPONSE_MODEL]).toBe(
      'anthropic/claude-sonnet-4-20250514',
    )
    expect(genAi.attributes[Attr.GEN_AI_RESPONSE_FINISH_REASON]).toBe('stop')
    expect(genAi.attributes[Attr.GEN_AI_USAGE_INPUT_TOKENS]).toBe(1234)
    expect(genAi.attributes[Attr.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(567)
    expect(genAi.attributes[Attr.GEN_AI_USAGE_CACHE_READ_TOKENS]).toBe(100)
    expect(genAi.attributes[Attr.COST_CREDITS]).toBe(234)
    expect(genAi.attributes[Attr.COST_USD]).toBeCloseTo(0.0234, 6)

    // Span status should not be ERROR — overall call succeeded. (OTel
    // SpanStatusCode.UNSET = 0, OK = 1, ERROR = 2.)
    expect(genAi.status.code).not.toBe(2)
  })

  it('Claude OAuth auth-error → refresh fails → codebuff_backend success: one span, two failed events, one succeeded event, final attrs match attempt 3', async () => {
    // Replay of the auth-error path when the refresh succeeds, the refreshed
    // token retries on claude_oauth AND also fails, then finally falls back.
    // This is the worst-case Claude OAuth path in promptAiSdkStream:
    //   attempt 1 (claude_oauth): auth_error
    //   attempt 2 (claude_oauth, refreshed): also fails — e.g. rate_limited
    //   attempt 3 (codebuff_backend): succeeds
    // Validates that the shared handle accumulates ALL failures, not just
    // the first one, and that final attrs still reflect the winning attempt.
    await withPromptSpan({ sessionId: 's-auth' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-opus-4',
        route: 'claude_oauth',
        routeAttempt: 1,
      })

      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'anthropic/claude-opus-4',
        succeeded: false,
        error: 'claude_oauth_auth_error',
      })

      llm.recordAttempt({
        attempt: 2,
        route: 'claude_oauth',
        model: 'anthropic/claude-opus-4',
        succeeded: false,
        error: 'claude_oauth_rate_limited',
      })

      llm.recordAttempt({
        attempt: 3,
        route: 'codebuff_backend',
        model: 'anthropic/claude-opus-4',
        succeeded: true,
      })
      llm.finalize({
        route: 'codebuff_backend',
        attempt: 3,
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-opus-4',
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.015,
        costCredits: 150,
      })
      llm.end()
    })

    const chatSpans = byNameAll(
      exporter.getFinishedSpans(),
      SpanNames.GEN_AI_CHAT,
    )
    expect(chatSpans.length).toBe(1)
    const genAi = chatSpans[0]

    const events = attemptEvents(genAi)
    expect(events.length).toBe(3)

    expect(events[0].name).toBe(Events.ROUTE_ATTEMPT_FAILED)
    expect(events[0].attrs.error).toBe('claude_oauth_auth_error')
    expect(events[0].attrs[Attr.ROUTE_ATTEMPT]).toBe(1)

    expect(events[1].name).toBe(Events.ROUTE_ATTEMPT_FAILED)
    expect(events[1].attrs.error).toBe('claude_oauth_rate_limited')
    expect(events[1].attrs[Attr.ROUTE_ATTEMPT]).toBe(2)

    expect(events[2].name).toBe(Events.ROUTE_ATTEMPT_SUCCEEDED)
    expect(events[2].attrs[Attr.ROUTE]).toBe('codebuff_backend')
    expect(events[2].attrs[Attr.ROUTE_ATTEMPT]).toBe(3)

    // Final attrs reflect the winning attempt.
    expect(genAi.attributes[Attr.ROUTE]).toBe('codebuff_backend')
    expect(genAi.attributes[Attr.ROUTE_ATTEMPT]).toBe(3)
    expect(genAi.attributes[Attr.GEN_AI_USAGE_INPUT_TOKENS]).toBe(500)
    expect(genAi.attributes[Attr.COST_CREDITS]).toBe(150)
  })

  it('ChatGPT OAuth rate-limit → codebuff_backend success: same shared-span contract as Claude path', async () => {
    // Spec 8.5 applies equally to ChatGPT OAuth fallback — the handle
    // contract is the same; we just swap the initial route / error label.
    await withPromptSpan({ sessionId: 's-chatgpt' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'openai/gpt-5',
        route: 'chatgpt_oauth',
        routeAttempt: 1,
      })

      llm.recordAttempt({
        attempt: 1,
        route: 'chatgpt_oauth',
        model: 'openai/gpt-5',
        succeeded: false,
        error: 'chatgpt_oauth_rate_limited',
      })

      llm.recordAttempt({
        attempt: 2,
        route: 'codebuff_backend',
        model: 'openai/gpt-5',
        succeeded: true,
      })
      llm.finalize({
        route: 'codebuff_backend',
        attempt: 2,
        system: 'ai-sdk',
        requestModel: 'openai/gpt-5',
        inputTokens: 800,
        outputTokens: 250,
        costUsd: 0.018,
        costCredits: 180,
      })
      llm.end()
    })

    const chatSpans = byNameAll(
      exporter.getFinishedSpans(),
      SpanNames.GEN_AI_CHAT,
    )
    expect(chatSpans.length).toBe(1)
    const genAi = chatSpans[0]

    const events = attemptEvents(genAi)
    expect(events.length).toBe(2)
    expect(events[0].name).toBe(Events.ROUTE_ATTEMPT_FAILED)
    expect(events[0].attrs[Attr.ROUTE]).toBe('chatgpt_oauth')
    expect(events[0].attrs[Attr.ROUTE_ATTEMPT]).toBe(1)
    expect(events[0].attrs.error).toBe('chatgpt_oauth_rate_limited')
    expect(events[1].name).toBe(Events.ROUTE_ATTEMPT_SUCCEEDED)
    expect(events[1].attrs[Attr.ROUTE]).toBe('codebuff_backend')
    expect(events[1].attrs[Attr.ROUTE_ATTEMPT]).toBe(2)

    expect(genAi.attributes[Attr.ROUTE]).toBe('codebuff_backend')
    expect(genAi.attributes[Attr.ROUTE_ATTEMPT]).toBe(2)
    expect(genAi.attributes[Attr.COST_CREDITS]).toBe(180)
  })

  it('cost rollup on the parent prompt span uses the succeeding attempt only (not a sum across attempts)', async () => {
    // Regression guard: finalize() triggers cost rollup to ancestors. If
    // recordAttempt() were accidentally rolling up failed attempts as well,
    // the prompt's COST_USD would be inflated. It must reflect attempt 2
    // only.
    await withPromptSpan({ sessionId: 's-rollup' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        route: 'claude_oauth',
        routeAttempt: 1,
      })
      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'anthropic/claude-sonnet-4',
        succeeded: false,
        error: 'claude_oauth_rate_limited',
      })
      llm.recordAttempt({
        attempt: 2,
        route: 'codebuff_backend',
        model: 'anthropic/claude-sonnet-4',
        succeeded: true,
      })
      llm.finalize({
        route: 'codebuff_backend',
        attempt: 2,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
        costCredits: 100,
      })
      llm.end()
    })

    const prompt = byName(
      exporter.getFinishedSpans(),
      SpanNames.PROMPT,
    )!
    // The shared gen_ai.chat span counts as exactly ONE LLM call, even
    // though two network attempts were made.
    expect(prompt.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
    expect(prompt.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(100)
    expect(prompt.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBe(50)
    expect(prompt.attributes[Attr.COST_CREDITS]).toBe(100)
    expect(prompt.attributes[Attr.COST_USD]).toBeCloseTo(0.01, 6)
  })

  it('happy path: attempt 1 succeeds outright fires exactly one route_attempt_succeeded event (spec 8.5: "on every success")', async () => {
    // Spec task 8.5 says `route_attempt_succeeded` fires on EVERY successful
    // attempt — including the no-fallback happy path where attempt 1 wins.
    //
    // This is ALSO the regression guard for spec task 5.5: the two
    // non-streaming success paths in `sdk/src/impl/llm.ts` (generateText
    // and generateObject) now explicitly call
    // `recordAttempt({ succeeded: true, attempt: 1 })` before finalize() so
    // Honeycomb sees a symmetric event stream whether or not a fallback
    // occurred. If that call were removed, this test would fail with
    // events.length === 0.
    await withPromptSpan({ sessionId: 's-happy' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        route: 'claude_oauth',
        routeAttempt: 1,
      })
      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'anthropic/claude-sonnet-4',
        succeeded: true,
      })
      llm.finalize({
        route: 'claude_oauth',
        attempt: 1,
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.005,
        costCredits: 50,
      })
      llm.end()
    })

    const chatSpans = byNameAll(
      exporter.getFinishedSpans(),
      SpanNames.GEN_AI_CHAT,
    )
    expect(chatSpans.length).toBe(1)
    const genAi = chatSpans[0]

    const events = attemptEvents(genAi)
    // Exactly one event, and it's a success on attempt 1.
    expect(events.length).toBe(1)
    expect(events[0].name).toBe(Events.ROUTE_ATTEMPT_SUCCEEDED)
    expect(events[0].attrs[Attr.ROUTE]).toBe('claude_oauth')
    expect(events[0].attrs[Attr.ROUTE_ATTEMPT]).toBe(1)
    expect(events[0].attrs.error).toBeUndefined()

    // Final attrs reflect the winning (and only) attempt.
    expect(genAi.attributes[Attr.ROUTE]).toBe('claude_oauth')
    expect(genAi.attributes[Attr.ROUTE_ATTEMPT]).toBe(1)
    expect(genAi.status.code).not.toBe(2)
  })

  it('fatal error on the fallback attempt ends the span in ERROR status with a final failed event', async () => {
    // When even the codebuff_backend fallback throws a fatal (non-OAuth)
    // error, promptAiSdkStream calls recordAttempt({ succeeded: false })
    // then end(err). This leaves the span with N failed events, no
    // succeeded event, and ERROR status — still exactly one span.
    await withPromptSpan({ sessionId: 's-fatal' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'anthropic/claude-sonnet-4',
        route: 'claude_oauth',
        routeAttempt: 1,
      })
      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'anthropic/claude-sonnet-4',
        succeeded: false,
        error: 'claude_oauth_rate_limited',
      })
      llm.recordAttempt({
        attempt: 2,
        route: 'codebuff_backend',
        model: 'anthropic/claude-sonnet-4',
        succeeded: false,
        error: 'APICallError',
      })
      llm.end(new Error('upstream 500'))
    })

    const chatSpans = byNameAll(
      exporter.getFinishedSpans(),
      SpanNames.GEN_AI_CHAT,
    )
    expect(chatSpans.length).toBe(1)
    const genAi = chatSpans[0]

    const events = attemptEvents(genAi)
    expect(events.length).toBe(2)
    expect(events.every((e) => e.name === Events.ROUTE_ATTEMPT_FAILED)).toBe(
      true,
    )
    // ERROR status code in @opentelemetry/api is 2.
    expect(genAi.status.code).toBe(2)
  })
})
