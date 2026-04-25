// SPARROW: Error-safe span wrappers. Every entry point is wrapped in try/catch
// and falls back to running the callback directly if telemetry is disabled or
// anything goes wrong during span creation.

import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api'

import { Attr, Events, SpanNames, type RouteValue } from './attributes'
import {
  flushRollupOnEnd,
  getActiveSpan,
  registerSpanParent,
  rollupLlmCall,
} from './cost-rollup'
import { harvestContext, harvestContextAwait } from './context-harvester'
import {
  flushTelemetry,
  getTracer,
  isTelemetryActive,
} from './tracer-provider'

// SPARROW: Timeout budget for the auto-flush kicked off at the end of every
// top-level prompt span. Fire-and-forget — we never await this, so the budget
// only caps how long the pending Promise lives before resolving to 'timeout'.
// Kept short so the BatchSpanProcessor's background queue doesn't build up
// long retry chains when Honeycomb is unreachable.
const PROMPT_END_FLUSH_TIMEOUT_MS = 2_000

type AttrValue = string | number | boolean | undefined | null

function setAttrs(span: Span, attrs: Record<string, AttrValue>): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    try {
      span.setAttribute(k, v as string | number | boolean)
    } catch {
      /* drop bad attr, continue */
    }
  }
}

/**
 * Run `fn` inside an active span. Errors in telemetry are swallowed; errors
 * thrown by `fn` propagate but are recorded on the span.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, AttrValue>,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (!isTelemetryActive()) {
    return fn(undefined)
  }

  let span: Span | undefined
  try {
    const tracer = getTracer()
    const parent = getActiveSpan()
    span = tracer.startSpan(name)
    if (span) {
      registerSpanParent(span, parent)
      setAttrs(span, attrs)
    }
  } catch {
    return fn(undefined)
  }

  if (!span) return fn(undefined)

  const ctx = trace.setSpan(context.active(), span)
  try {
    return await context.with(ctx, () => fn(span))
  } catch (err) {
    try {
      span.recordException(err as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.name : 'error',
      })
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    try {
      flushRollupOnEnd(span)
      span.end()
    } catch {
      /* ignore */
    }
  }
}

export type PromptSpanAttrs = {
  sessionId?: string
  serviceVersion?: string
}

/**
 * Root prompt span. Auto-harvests git/project/user context onto this span.
 * Awaits the context fetch when the cache is cold so the first prompt of a
 * session includes full git/project attributes.
 *
 * SPARROW: fires a non-blocking `flushTelemetry()` in a `finally` after the
 * prompt span has ended. The prompt span represents one complete user turn,
 * and by the time it closes every descendant (agent.run/step, gen_ai.chat,
 * tool.call) has already been `end()`ed and handed to the BatchSpanProcessor.
 * Flushing here gets that turn to Honeycomb immediately rather than waiting
 * for the next 5s batch timer. Fire-and-forget (never awaited), so it adds
 * zero latency to the turn response; errors are swallowed.
 */
export async function withPromptSpan<T>(
  attrs: PromptSpanAttrs,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  let harvested: Record<string, AttrValue> = {}
  try {
    harvested = (await harvestContextAwait({
      sessionId: attrs.sessionId,
    })) as Record<string, AttrValue>
  } catch {
    /* ignore harvest failures */
  }
  const spanAttrs: Record<string, AttrValue> = { ...harvested }
  if (attrs.serviceVersion) spanAttrs[Attr.SERVICE_VERSION] = attrs.serviceVersion
  try {
    return await withSpan(SpanNames.PROMPT, spanAttrs, fn)
  } finally {
    // SPARROW: fire-and-forget turn-end flush. `withSpan`'s finally has
    // already `end()`ed the prompt span before we reach this block, so the
    // BatchSpanProcessor has the full trace queued and ready to export.
    // `.catch` alone is sufficient: flushTelemetry is `async` and cannot
    // throw synchronously; it can only return a rejected promise.
    void flushTelemetry(PROMPT_END_FLUSH_TIMEOUT_MS).catch(() => {
      /* swallow: telemetry must never break user workflows */
    })
  }
}

export type AgentRunSpanAttrs = {
  agentId?: string
  agentDisplayId?: string
  parentAgentId?: string
}

export function withAgentRunSpan<T>(
  attrs: AgentRunSpanAttrs,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  return withSpan(
    SpanNames.AGENT_RUN,
    {
      [Attr.AGENT_ID]: attrs.agentId,
      [Attr.AGENT_DISPLAY_ID]: attrs.agentDisplayId,
      [Attr.PARENT_AGENT_ID]: attrs.parentAgentId,
    },
    fn,
  )
}

export type AgentStepSpanAttrs = {
  agentId?: string
  agentDisplayId?: string
  stepNumber?: number
}

export function withAgentStepSpan<T>(
  attrs: AgentStepSpanAttrs,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  return withSpan(
    SpanNames.AGENT_STEP,
    {
      [Attr.AGENT_ID]: attrs.agentId,
      [Attr.AGENT_DISPLAY_ID]: attrs.agentDisplayId,
      [Attr.STEP_NUMBER]: attrs.stepNumber,
    },
    fn,
  )
}

export type LlmCallSpanHandle = {
  span: Span | undefined
  /** Record a fallback attempt on the same logical span. */
  recordAttempt(info: {
    attempt: number
    route: RouteValue
    model?: string
    succeeded: boolean
    error?: string
  }): void
  /** Finalize with usage + cost; will also roll up to ancestors. */
  finalize(info: {
    route?: RouteValue
    attempt?: number
    system?: string
    requestModel?: string
    responseModel?: string
    finishReason?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    costCredits?: number
    costUsd?: number
    toolCallsEmitted?: number
    // SPARROW (telemetry): stable per-OAuth-account identifier; only set when
    // the call resolved to claude_oauth or chatgpt_oauth route.
    oauthAccountId?: string
  }): void
  /** Attach opt-in message history as a span event (only when caller decides). */
  recordMessages(serialized: string): void
  /** End the span; safe to call multiple times. */
  end(error?: unknown): void
}

/**
 * Open a gen_ai.chat span. Returns a handle rather than a function-scoped wrapper
 * because the LLM call site is a generator that can't be neatly wrapped in
 * `context.with` across multiple yields.
 */
export function recordLlmCall(initial: {
  system?: string
  requestModel?: string
  // SPARROW (telemetry): request-side max output tokens cap. Recorded at
  // span creation so a `length`-truncated response on a failed/aborted call
  // can still be diagnosed against its cap. Maps to OTel semconv
  // `gen_ai.request.max_tokens`.
  maxTokens?: number
  route?: RouteValue
  routeAttempt?: number
  // NOTE: oauthAccountId is intentionally NOT in the initial config. The
  // route (and therefore the account) is decided after credentials lookup,
  // which happens after recordLlmCall is called from the streaming path.
  // It's set via finalize() instead.
}): LlmCallSpanHandle {
  if (!isTelemetryActive()) {
    return NOOP_LLM_HANDLE
  }
  let span: Span | undefined
  try {
    const tracer = getTracer()
    const parent = getActiveSpan()
    span = tracer.startSpan(SpanNames.GEN_AI_CHAT)
    registerSpanParent(span, parent)
    // SPARROW (telemetry): propagate identity attributes from the per-prompt
    // harvest cache onto every gen_ai.chat span so token totals can be sliced
    // by user/machine without joining through trace IDs. The harvest cache is
    // already warm by this point because the root prompt span pre-populated
    // it via `harvestContextAwait`. We use the sync API (cache-only) to avoid
    // blocking LLM dispatch; if the cache somehow isn't warm the attrs are
    // simply omitted (setAttrs filters undefined). harvestContext is
    // documented as never-throws — the outer try/catch on this whole block
    // is the safety net.
    const ctx = harvestContext({})
    setAttrs(span, {
      [Attr.USER_EMAIL]: ctx[Attr.USER_EMAIL],
      [Attr.USER_NAME]: ctx[Attr.USER_NAME],
      [Attr.HOST_NAME]: ctx[Attr.HOST_NAME],
      [Attr.GEN_AI_SYSTEM]: initial.system,
      [Attr.GEN_AI_REQUEST_MODEL]: initial.requestModel,
      [Attr.GEN_AI_REQUEST_MAX_TOKENS]: initial.maxTokens,
      [Attr.ROUTE]: initial.route,
      [Attr.ROUTE_ATTEMPT]: initial.routeAttempt ?? 1,
    })
  } catch {
    return NOOP_LLM_HANDLE
  }

  let ended = false

  return {
    span,
    recordAttempt(info) {
      if (!span || ended) return
      try {
        span.addEvent(
          info.succeeded
            ? Events.ROUTE_ATTEMPT_SUCCEEDED
            : Events.ROUTE_ATTEMPT_FAILED,
          {
            [Attr.ROUTE_ATTEMPT]: info.attempt,
            [Attr.ROUTE]: info.route,
            [Attr.GEN_AI_REQUEST_MODEL]: info.model,
            ...(info.error ? { error: info.error } : {}),
          } as Attributes,
        )
      } catch {
        /* ignore */
      }
    },
    finalize(info) {
      if (!span || ended) return
      setAttrs(span, {
        [Attr.GEN_AI_SYSTEM]: info.system,
        [Attr.GEN_AI_REQUEST_MODEL]: info.requestModel,
        [Attr.GEN_AI_RESPONSE_MODEL]: info.responseModel,
        [Attr.GEN_AI_RESPONSE_FINISH_REASON]: info.finishReason,
        [Attr.GEN_AI_USAGE_INPUT_TOKENS]: info.inputTokens,
        [Attr.GEN_AI_USAGE_OUTPUT_TOKENS]: info.outputTokens,
        [Attr.GEN_AI_USAGE_CACHE_READ_TOKENS]: info.cacheReadTokens,
        [Attr.GEN_AI_USAGE_CACHE_CREATION_TOKENS]: info.cacheCreationTokens,
        [Attr.ROUTE]: info.route,
        [Attr.ROUTE_ATTEMPT]: info.attempt,
        [Attr.OAUTH_ACCOUNT_ID]: info.oauthAccountId,
        [Attr.COST_CREDITS]: info.costCredits,
        [Attr.COST_USD]:
          info.costUsd !== undefined
            ? Number(info.costUsd.toFixed(6))
            : undefined,
        [Attr.TOOL_CALLS_EMITTED]: info.toolCallsEmitted,
      })
      try {
        rollupLlmCall({
          span,
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          cacheReadTokens: info.cacheReadTokens,
          cacheCreationTokens: info.cacheCreationTokens,
          costUsd: info.costUsd,
          costCredits: info.costCredits,
        })
      } catch {
        /* ignore */
      }
    },
    recordMessages(serialized) {
      if (!span || ended) return
      try {
        span.addEvent(Events.PROMPT_MESSAGES, {
          [Attr.PROMPT_MESSAGES]: serialized,
        } as Attributes)
      } catch {
        /* ignore */
      }
    },
    end(error) {
      if (!span || ended) return
      ended = true
      try {
        if (error) {
          span.recordException(error as Error)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.name : 'error',
          })
        }
      } catch {
        /* ignore */
      }
      try {
        span.end()
      } catch {
        /* ignore */
      }
    },
  }
}

const NOOP_LLM_HANDLE: LlmCallSpanHandle = {
  span: undefined,
  recordAttempt() {
    /* no-op */
  },
  finalize() {
    /* no-op */
  },
  recordMessages() {
    /* no-op */
  },
  end() {
    /* no-op */
  },
}

export type ToolCallSpanParams = {
  toolName: string
  input: unknown
  childAgentId?: string
}

export type ToolCallResult = {
  success: boolean
  output?: unknown
  error?: unknown
}

/**
 * Open a tool.call span and provide `finish` to end it with the result.
 */
export function recordToolCall(params: ToolCallSpanParams): {
  span: Span | undefined
  finish(result: ToolCallResult): void
} {
  if (!isTelemetryActive()) {
    return { span: undefined, finish() {} }
  }
  let span: Span | undefined
  const startTime = Date.now()
  try {
    const tracer = getTracer()
    const parent = getActiveSpan()
    span = tracer.startSpan(SpanNames.TOOL_CALL)
    registerSpanParent(span, parent)
    const bytesIn = safeByteSize(params.input)
    setAttrs(span, {
      [Attr.TOOL_NAME]: params.toolName,
      [Attr.TOOL_BYTES_IN]: bytesIn,
      [Attr.CHILD_AGENT_ID]: params.childAgentId,
    })
  } catch {
    return { span: undefined, finish() {} }
  }

  let ended = false
  return {
    span,
    finish(result) {
      if (!span || ended) return
      ended = true
      try {
        const duration = Date.now() - startTime
        const bytesOut = safeByteSize(result.output)
        setAttrs(span, {
          [Attr.TOOL_SUCCESS]: result.success,
          [Attr.TOOL_DURATION_MS]: duration,
          [Attr.TOOL_BYTES_OUT]: bytesOut,
        })
        if (!result.success) {
          const errName =
            result.error instanceof Error
              ? result.error.name
              : typeof result.error === 'string'
                ? result.error.slice(0, 64)
                : 'error'
          span.setStatus({ code: SpanStatusCode.ERROR, message: errName })
        }
      } catch {
        /* ignore */
      }
      try {
        span.end()
      } catch {
        /* ignore */
      }
    },
  }
}

function safeByteSize(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  try {
    if (typeof v === 'string') return Buffer.byteLength(v, 'utf8')
    return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')
  } catch {
    return undefined
  }
}
