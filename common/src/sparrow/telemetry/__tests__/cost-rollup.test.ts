import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Attr } from '../attributes'
import {
  flushRollupOnEnd,
  getActiveSpan,
  registerSpanParent,
  rollupLlmCall,
} from '../cost-rollup'
import {
  __initTelemetryForTests,
  __resetTelemetryForTests,
  getTracer,
} from '../tracer-provider'

describe('cost-rollup', () => {
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
    })
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
  })

  it('rollupLlmCall accumulates onto the registered parent', async () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const child = tracer.startSpan('child')

    registerSpanParent(root, undefined)
    registerSpanParent(child, root)

    rollupLlmCall({
      span: child,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      costCredits: 10,
    })

    // End child first (has no rollups of its own to flush), then flush root.
    child.end()
    flushRollupOnEnd(root)
    root.end()

    await exporter.forceFlush()
    const spans = exporter.getFinishedSpans()
    const rootSpan = spans.find((s) => s.name === 'root')!
    expect(rootSpan).toBeDefined()
    expect(rootSpan.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(100)
    expect(rootSpan.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBe(50)
    expect(rootSpan.attributes[Attr.COST_USD]).toBe(0.001)
    expect(rootSpan.attributes[Attr.COST_CREDITS]).toBe(10)
    expect(rootSpan.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
  })

  it('walks the full ancestor chain (3 levels)', async () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const mid = tracer.startSpan('mid')
    const leaf = tracer.startSpan('leaf')

    registerSpanParent(root, undefined)
    registerSpanParent(mid, root)
    registerSpanParent(leaf, mid)

    rollupLlmCall({
      span: leaf,
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheCreationTokens: 20,
      costUsd: 0.005,
      costCredits: 50,
    })

    leaf.end()
    flushRollupOnEnd(mid)
    mid.end()
    flushRollupOnEnd(root)
    root.end()

    await exporter.forceFlush()
    const spans = exporter.getFinishedSpans()
    const rootSpan = spans.find((s) => s.name === 'root')!
    const midSpan = spans.find((s) => s.name === 'mid')!
    expect(rootSpan.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(200)
    expect(rootSpan.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBe(80)
    expect(rootSpan.attributes[Attr.ROLLUP_CACHE_READ_TOKENS]).toBe(40)
    expect(rootSpan.attributes[Attr.ROLLUP_CACHE_CREATION_TOKENS]).toBe(20)
    expect(rootSpan.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
    expect(midSpan.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(200)
    expect(midSpan.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
  })

  it('multiple LLM calls accumulate on the same ancestor', async () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const a = tracer.startSpan('llm-a')
    const b = tracer.startSpan('llm-b')
    const c = tracer.startSpan('llm-c')

    registerSpanParent(root, undefined)
    registerSpanParent(a, root)
    registerSpanParent(b, root)
    registerSpanParent(c, root)

    rollupLlmCall({
      span: a,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
      costCredits: 1,
    })
    rollupLlmCall({
      span: b,
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.0002,
      costCredits: 2,
    })
    rollupLlmCall({
      span: c,
      inputTokens: 30,
      outputTokens: 15,
      costUsd: 0.0003,
      costCredits: 3,
    })

    a.end()
    b.end()
    c.end()
    flushRollupOnEnd(root)
    root.end()

    await exporter.forceFlush()
    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === 'root')!
    expect(rootSpan.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(60)
    expect(rootSpan.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBe(30)
    expect(rootSpan.attributes[Attr.COST_CREDITS]).toBe(6)
    expect(rootSpan.attributes[Attr.LLM_CALL_COUNT]).toBe(3)
    // costUsd is rounded to 6 decimals by flushRollupOnEnd.
    const costUsd = rootSpan.attributes[Attr.COST_USD] as number
    expect(costUsd).toBeCloseTo(0.0006, 6)
  })

  it('rounds costUsd to 6 decimals in the final attribute', async () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const child = tracer.startSpan('child')
    registerSpanParent(root, undefined)
    registerSpanParent(child, root)

    rollupLlmCall({
      span: child,
      costUsd: 0.123456789,
      costCredits: 100,
    })

    child.end()
    flushRollupOnEnd(root)
    root.end()

    await exporter.forceFlush()
    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === 'root')!
    // toFixed(6) => "0.123457" (rounded), parsed back to number
    expect(rootSpan.attributes[Attr.COST_USD]).toBeCloseTo(0.123457, 7)
  })

  it('flushRollupOnEnd is a no-op for spans with no registered rollups', async () => {
    const tracer = getTracer()
    const solo = tracer.startSpan('solo')
    // No registerSpanParent, no rollupLlmCall
    // flushRollupOnEnd should not throw and not set any rollup attributes.
    flushRollupOnEnd(solo)
    solo.end()

    await exporter.forceFlush()
    const span = exporter.getFinishedSpans().find((s) => s.name === 'solo')!
    expect(span.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBeUndefined()
    expect(span.attributes[Attr.LLM_CALL_COUNT]).toBeUndefined()
  })

  it('flushRollupOnEnd omits zero-value attributes', async () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const child = tracer.startSpan('child')
    registerSpanParent(root, undefined)
    registerSpanParent(child, root)

    // Only input tokens; output/cache/cost should stay unset on root.
    rollupLlmCall({ span: child, inputTokens: 5 })

    child.end()
    flushRollupOnEnd(root)
    root.end()

    await exporter.forceFlush()
    const rootSpan = exporter.getFinishedSpans().find((s) => s.name === 'root')!
    expect(rootSpan.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(5)
    expect(rootSpan.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBeUndefined()
    expect(rootSpan.attributes[Attr.COST_USD]).toBeUndefined()
    expect(rootSpan.attributes[Attr.COST_CREDITS]).toBeUndefined()
    expect(rootSpan.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
  })

  it('rollupLlmCall on a child without a registered parent is a no-op (no throw)', () => {
    const tracer = getTracer()
    const orphan = tracer.startSpan('orphan')
    // Intentionally skip registerSpanParent
    expect(() =>
      rollupLlmCall({
        span: orphan,
        inputTokens: 999,
        costUsd: 9.99,
      }),
    ).not.toThrow()
    orphan.end()
  })

  it('getActiveSpan returns undefined outside of context.with', () => {
    // When called at the top level with no active span in context, returns undefined.
    expect(getActiveSpan()).toBeUndefined()
  })
})
