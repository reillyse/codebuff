import fs from 'fs'
import os from 'os'
import path from 'node:path'

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { __resetSparrowConfigCacheForTests } from '../../config/sparrow-config'
import {
  __initTelemetryForTests,
  __resetTelemetryForTests,
  flushTelemetry,
  getTracer,
  initTelemetry,
  isTelemetryActive,
  reinitTelemetry,
  shutdownTelemetry,
} from '../tracer-provider'

describe('tracer-provider: silent no-op mode', () => {
  const originalKey = process.env.HONEYCOMB_API_KEY

  beforeEach(() => {
    delete process.env.HONEYCOMB_API_KEY
    __resetTelemetryForTests()
  })

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.HONEYCOMB_API_KEY
    } else {
      process.env.HONEYCOMB_API_KEY = originalKey
    }
    __resetTelemetryForTests()
  })

  it('initTelemetry without HONEYCOMB_API_KEY does nothing', () => {
    initTelemetry()
    expect(isTelemetryActive()).toBe(false)
  })

  it('empty HONEYCOMB_API_KEY also no-ops', () => {
    process.env.HONEYCOMB_API_KEY = '   '
    initTelemetry()
    expect(isTelemetryActive()).toBe(false)
  })

  it('getTracer still returns a tracer even when inactive', () => {
    // The global @opentelemetry/api tracer is always defined; it's just a no-op
    // proxy when no provider is registered.
    const tracer = getTracer()
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
  })

  it('shutdownTelemetry is safe to call without init', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })
})

describe('tracer-provider: idempotent init', () => {
  beforeEach(() => {
    __resetTelemetryForTests()
  })

  afterEach(() => {
    __resetTelemetryForTests()
  })

  it('second initTelemetry call is a no-op (same provider state)', () => {
    const exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
    })
    expect(isTelemetryActive()).toBe(true)

    // Calling the real initTelemetry now should be a no-op because `initialized`
    // is already true.
    process.env.HONEYCOMB_API_KEY = 'test-key'
    initTelemetry()
    expect(isTelemetryActive()).toBe(true)
    delete process.env.HONEYCOMB_API_KEY
  })

  it('__resetTelemetryForTests allows re-init', () => {
    const exporter1 = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter1)],
    })
    expect(isTelemetryActive()).toBe(true)

    __resetTelemetryForTests()
    expect(isTelemetryActive()).toBe(false)

    const exporter2 = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter2)],
    })
    expect(isTelemetryActive()).toBe(true)
  })
})

describe('tracer-provider: reinitTelemetry live-apply', () => {
  const originalHome = process.env.HOME
  const originalKey = process.env.HONEYCOMB_API_KEY
  const originalDataset = process.env.HONEYCOMB_DATASET
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reinit-telemetry-'))
    process.env.HOME = tmpHome
    delete process.env.HONEYCOMB_API_KEY
    delete process.env.HONEYCOMB_DATASET
    __resetSparrowConfigCacheForTests()
    __resetTelemetryForTests()
  })

  afterEach(async () => {
    await shutdownTelemetry()
    __resetTelemetryForTests()
    __resetSparrowConfigCacheForTests()
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalKey === undefined) delete process.env.HONEYCOMB_API_KEY
    else process.env.HONEYCOMB_API_KEY = originalKey
    if (originalDataset === undefined) delete process.env.HONEYCOMB_DATASET
    else process.env.HONEYCOMB_DATASET = originalDataset
  })

  it('activates a previously-inactive tracer when env/config adds an apiKey', async () => {
    // First init: no key → inactive.
    initTelemetry({ serviceVersion: 'reinit-test' })
    expect(isTelemetryActive()).toBe(false)

    // Simulate the user running `/telemetry enable <key>` — env arrives via
    // explicit override so we don't depend on disk/config-file plumbing here.
    process.env.HONEYCOMB_API_KEY = 'hcik_fake_but_nonempty'
    __resetSparrowConfigCacheForTests()
    await reinitTelemetry()

    expect(isTelemetryActive()).toBe(true)
  })

  it('deactivates the tracer when apiKey goes away', async () => {
    process.env.HONEYCOMB_API_KEY = 'hcik_fake_but_nonempty'
    initTelemetry({ serviceVersion: 'reinit-test' })
    expect(isTelemetryActive()).toBe(true)

    delete process.env.HONEYCOMB_API_KEY
    __resetSparrowConfigCacheForTests()
    await reinitTelemetry()

    expect(isTelemetryActive()).toBe(false)
  })

  it('preserves serviceVersion from the original init across reinit', async () => {
    // Seed an initial live provider with a specific serviceVersion.
    process.env.HONEYCOMB_API_KEY = 'hcik_k1'
    initTelemetry({ serviceVersion: 'v-original' })
    expect(isTelemetryActive()).toBe(true)

    // Reinit without passing serviceVersion — lastInitOpts must carry
    // 'v-original' forward. We inject a *fresh* in-memory exporter via
    // `reinitTelemetry` so we can read the new provider's resource
    // attributes. (The exporter from the original init would be unusable
    // here because `shutdownTelemetry()` calls processor.shutdown() on it.)
    process.env.HONEYCOMB_DATASET = 'custom-dataset'
    __resetSparrowConfigCacheForTests()
    const exporter = new InMemorySpanExporter()
    await reinitTelemetry({
      extraProcessors: [new SimpleSpanProcessor(exporter)],
    })
    expect(isTelemetryActive()).toBe(true)

    const tracer = getTracer()
    const span = tracer.startSpan('reinit.resource.check')
    span.end()
    // SimpleSpanProcessor forwards synchronously but the exporter accumulates
    // via its async export() — give the microtask queue one tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const finished = exporter.getFinishedSpans()
    expect(finished.length).toBeGreaterThan(0)
    expect(finished[0].resource.attributes['service.version']).toBe(
      'v-original',
    )
  })

  it('is safe to call before any init (acts as a cold init)', async () => {
    delete process.env.HONEYCOMB_API_KEY
    await expect(reinitTelemetry()).resolves.toBeUndefined()
    expect(isTelemetryActive()).toBe(false)
  })
})

describe('tracer-provider: flushTelemetry', () => {
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    __resetTelemetryForTests()
  })

  afterEach(() => {
    if (exporter) exporter.reset()
    __resetTelemetryForTests()
  })

  it('returns "inactive" when no provider is registered (silent no-op mode)', async () => {
    expect(isTelemetryActive()).toBe(false)
    await expect(flushTelemetry()).resolves.toBe('inactive')
  })

  it('returns "flushed" when the provider is active and forceFlush settles', async () => {
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
    })
    // Produce a span so forceFlush has something to push.
    const tracer = getTracer()
    const span = tracer.startSpan('flush.test')
    span.end()

    const result = await flushTelemetry()
    expect(result).toBe('flushed')
    // Provider must still be active — flush does NOT shut down.
    expect(isTelemetryActive()).toBe(true)
    // The span reached the exporter.
    expect(exporter.getFinishedSpans().length).toBe(1)
  })

  it('does not tear down the provider (subsequent spans still export)', async () => {
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
    })
    const tracer = getTracer()

    const s1 = tracer.startSpan('before.flush')
    s1.end()
    await flushTelemetry()
    expect(isTelemetryActive()).toBe(true)

    // After flush, tracer should still be able to emit spans because
    // the provider was not shut down.
    const s2 = tracer.startSpan('after.flush')
    s2.end()
    await flushTelemetry()

    const finished = exporter.getFinishedSpans()
    expect(finished.length).toBe(2)
    expect(finished.map((s) => s.name)).toEqual([
      'before.flush',
      'after.flush',
    ])
  })

  it('returns "timeout" when forceFlush exceeds the budget', async () => {
    // Build a processor whose forceFlush hangs forever, so the timeout path
    // is exercised deterministically.
    const hangingProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: () => new Promise<void>(() => {}), // never resolves
      shutdown: () => Promise.resolve(),
    }
    __initTelemetryForTests({ processors: [hangingProcessor] })

    const result = await flushTelemetry(50)
    expect(result).toBe('timeout')
    // Still active — flush didn't shut anything down.
    expect(isTelemetryActive()).toBe(true)
  })

  it('returns "error" when forceFlush rejects', async () => {
    const erroringProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: () => Promise.reject(new Error('boom')),
      shutdown: () => Promise.resolve(),
    }
    __initTelemetryForTests({ processors: [erroringProcessor] })

    const result = await flushTelemetry()
    expect(result).toBe('error')
    // Provider survives an error — caller can retry.
    expect(isTelemetryActive()).toBe(true)
  })
})

describe('tracer-provider: test-mode init', () => {
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
      serviceVersion: '1.2.3-test',
    })
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
  })

  it('creates a real tracer that produces exportable spans', async () => {
    const tracer = getTracer()
    const span = tracer.startSpan('test.span')
    span.setAttribute('foo', 'bar')
    span.end()

    await exporter.forceFlush()
    const finished = exporter.getFinishedSpans()
    expect(finished.length).toBe(1)
    expect(finished[0].name).toBe('test.span')
    expect(finished[0].attributes.foo).toBe('bar')
  })

  it('applies service.version from init options to the resource', async () => {
    const tracer = getTracer()
    const span = tracer.startSpan('resource.check')
    span.end()
    await exporter.forceFlush()
    const finished = exporter.getFinishedSpans()
    expect(finished.length).toBe(1)
    // service.version is a Resource attribute, not a span attribute
    const resourceAttrs = finished[0].resource.attributes
    expect(resourceAttrs['service.version']).toBe('1.2.3-test')
    expect(resourceAttrs['service.name']).toBe('sparrow-codebuff')
  })
})
