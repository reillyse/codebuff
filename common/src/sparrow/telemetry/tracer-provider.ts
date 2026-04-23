// SPARROW: Tracer provider wiring — silent no-op unless telemetry is enabled
// via either sparrow-config.json or HONEYCOMB_API_KEY env var.

import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { context, trace } from '@opentelemetry/api'
// SPARROW: AsyncLocalStorageContextManager is OTel's recommended context
// manager for Node 14+. It uses node:async_hooks' AsyncLocalStorage, which
// propagates reliably across await boundaries on both Node and Bun. The older
// AsyncHooksContextManager has known gaps on Bun (context is lost after the
// first await inside a context.with callback).
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { ExportResultCode } from '@opentelemetry/core'

import { resolveTelemetryConfig } from '../config/sparrow-config'
import { Attr } from './attributes'

const TRACER_NAME = 'sparrow-codebuff'
const HONEYCOMB_ENDPOINT = 'https://api.honeycomb.io/v1/traces'

let provider: BasicTracerProvider | null = null
let initialized = false
let loggedExporterError = false
let debugEnabled = false
// Remember the most recent init options so `reinitTelemetry()` can preserve
// non-config fields like serviceVersion and extraProcessors across an
// in-process config change. Only explicit per-call overrides are kept —
// config-derived fields are re-resolved fresh on every init.
let lastInitOpts: TelemetryInitOptions = {}

export type TelemetryInitOptions = {
  serviceVersion?: string
  extraProcessors?: SpanProcessor[]
  /**
   * Explicit overrides (highest precedence). Usually left empty so env and
   * sparrow-config.json drive configuration.
   */
  apiKey?: string
  dataset?: string
  enabled?: boolean
}

function debugLog(message: string, err?: unknown): void {
  // debugEnabled is set from resolved config (env DEBUG=sparrow:telemetry OR
  // telemetry.debug=true in sparrow-config.json). Quiet by default.
  if (!debugEnabled) return
  try {
    // eslint-disable-next-line no-console
    console.error(`[sparrow:telemetry] ${message}`, err ?? '')
  } catch {
    /* ignore */
  }
}

/**
 * Initialize telemetry. Activates only when the resolved config has both
 * `enabled: true` AND a non-empty apiKey. Otherwise silent no-op.
 *
 * Config precedence: opts args > env vars (HONEYCOMB_*) > sparrow-config.json.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initTelemetry(opts: TelemetryInitOptions = {}): void {
  if (initialized) return
  initialized = true
  lastInitOpts = opts

  const resolved = resolveTelemetryConfig({
    apiKey: opts.apiKey,
    dataset: opts.dataset,
    enabled: opts.enabled,
  })

  debugEnabled = resolved.debug

  // enabled=false or no apiKey → silent no-op (matches D4 in the spec).
  if (!resolved.enabled || !resolved.apiKey) {
    return
  }

  try {
    const apiKey = resolved.apiKey
    const dataset = resolved.dataset

    const exporter = new OTLPTraceExporter({
      url: HONEYCOMB_ENDPOINT,
      headers: {
        'x-honeycomb-team': apiKey,
        'x-honeycomb-dataset': dataset,
      },
    })

    // Wrap the SpanExporter.export() method to swallow network errors so a
    // dead Honeycomb endpoint can never crash the CLI. BatchSpanProcessor
    // already handles retries; we just need to prevent unhandled rejections
    // and noisy logs.
    const originalExport = exporter.export.bind(exporter)
    exporter.export = (spans, resultCallback) => {
      try {
        originalExport(spans, (result) => {
          try {
            if (result && result.error && !loggedExporterError) {
              loggedExporterError = true
              debugLog('OTLP exporter error (logged once)', result.error)
            }
            resultCallback(result)
          } catch (err) {
            debugLog('OTLP resultCallback threw', err)
          }
        })
      } catch (err) {
        if (!loggedExporterError) {
          loggedExporterError = true
          debugLog('OTLP export threw', err)
        }
        try {
          resultCallback({ code: ExportResultCode.FAILED })
        } catch {
          /* ignore */
        }
      }
    }

    const resource = resourceFromAttributes({
      [Attr.SERVICE_NAME]: TRACER_NAME,
      [Attr.SERVICE_VERSION]: opts.serviceVersion ?? 'dev',
    })

    const processors: SpanProcessor[] = [
      new BatchSpanProcessor(exporter, {
        // Bounded queue; drop silently if overflowing.
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 10_000,
      }),
      ...(opts.extraProcessors ?? []),
    ]
    void processors

    provider = new BasicTracerProvider({
      resource,
      spanProcessors: processors,
    })

    // Enable async context propagation. AsyncLocalStorage works correctly on
    // Bun and Node 14+; async_hooks-based propagation has Bun quirks.
    try {
      const contextManager = new AsyncLocalStorageContextManager()
      contextManager.enable()
      context.setGlobalContextManager(contextManager)
    } catch (err) {
      debugLog('Failed to enable AsyncLocalStorageContextManager', err)
    }

    trace.setGlobalTracerProvider(provider)
  } catch (err) {
    provider = null
    debugLog('initTelemetry failed', err)
  }
}

/**
 * Flush and shut down with a 2-second budget. Safe to call without init.
 *
 * Also disables the OTel global tracer / context managers so a subsequent
 * `initTelemetry()` call can install a fresh provider. OTel 2.x silently
 * ignores `setGlobalTracerProvider` when a non-null global is already set,
 * so without this we'd leak the old provider across a reinit.
 */
export async function shutdownTelemetry(): Promise<void> {
  const p = provider
  // Always clear module-level flags so reinit is possible even if nothing
  // was ever activated (e.g. config said enabled=false the first time).
  provider = null
  initialized = false
  loggedExporterError = false

  if (p) {
    try {
      await Promise.race([
        p.forceFlush(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    } catch (err) {
      debugLog('forceFlush failed', err)
    }
    try {
      await Promise.race([
        p.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    } catch (err) {
      debugLog('shutdown failed', err)
    }
  }

  // Tear down OTel globals so a future initTelemetry() can replace them.
  try {
    trace.disable()
  } catch {
    /* ignore */
  }
  try {
    context.disable()
  } catch {
    /* ignore */
  }
}

/**
 * Re-apply telemetry configuration in-process.
 *
 * Intended for the `/telemetry enable|disable|dataset|capture-prompts|debug`
 * command handlers so changes take effect without requiring a CLI restart.
 * Internally: flushes + shuts down the current provider, disables OTel
 * globals, then re-runs `initTelemetry()` with the original boot-time options
 * (preserves `serviceVersion`, `extraProcessors`). Caller can override any
 * field via `opts`.
 *
 * Safe to call from any state (uninitialized, active, or already shut down).
 */
export async function reinitTelemetry(
  opts: TelemetryInitOptions = {},
): Promise<void> {
  await shutdownTelemetry()
  const merged: TelemetryInitOptions = { ...lastInitOpts, ...opts }
  initTelemetry(merged)
}

export function isTelemetryActive(): boolean {
  return provider !== null
}

/**
 * Force a synchronous flush of pending spans to the exporter without
 * tearing down the provider. Intended for `/telemetry flush` so users can
 * push pending traces to Honeycomb before shutting down the CLI or after a
 * short-lived session where the BatchSpanProcessor's 5-second timer hasn't
 * fired yet.
 *
 * Resolves to one of:
 *   - 'flushed'     — provider was active and forceFlush() completed within
 *                     the timeout budget
 *   - 'timeout'     — provider was active but forceFlush() didn't settle in
 *                     time (spans may still be in flight)
 *   - 'error'       — forceFlush() threw
 *   - 'inactive'    — no provider to flush (silent-no-op mode)
 *
 * Safe to call from any state.
 */
export async function flushTelemetry(
  timeoutMs: number = 2_000,
): Promise<'flushed' | 'timeout' | 'error' | 'inactive'> {
  const p = provider
  if (!p) return 'inactive'

  // Capture the timer handle so we can clear it on the fast path. Without
  // this, a successful flush leaves a dangling timer running for up to
  // timeoutMs, which (on Node) keeps the process alive.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  try {
    return await Promise.race([
      p.forceFlush().then(() => 'flushed' as const),
      timeoutPromise,
    ])
  } catch (err) {
    debugLog('forceFlush failed', err)
    return 'error'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Test-only: allow re-init after shutdown. Clears the OTel global tracer /
 * context providers so subsequent __initTelemetryForTests calls actually
 * replace them (OTel 2.x silently refuses to overwrite a non-null global). */
export function __resetTelemetryForTests(): void {
  try {
    trace.disable()
  } catch {
    /* ignore */
  }
  try {
    context.disable()
  } catch {
    /* ignore */
  }
  provider = null
  initialized = false
  loggedExporterError = false
}

/** Test-only: inject a span processor alongside the real one. */
export function __initTelemetryForTests(opts: {
  processors: SpanProcessor[]
  serviceVersion?: string
}): void {
  initialized = true
  loggedExporterError = false
  const resource = resourceFromAttributes({
    [Attr.SERVICE_NAME]: TRACER_NAME,
    [Attr.SERVICE_VERSION]: opts.serviceVersion ?? 'test',
  })
  provider = new BasicTracerProvider({
    resource,
    spanProcessors: opts.processors,
  })
  try {
    const contextManager = new AsyncLocalStorageContextManager()
    contextManager.enable()
    context.setGlobalContextManager(contextManager)
  } catch {
    /* ignore */
  }
  trace.setGlobalTracerProvider(provider)
}

export function getTracer() {
  return trace.getTracer(TRACER_NAME)
}
