// SPARROW: Running cost / token rollups.
// When a gen_ai.chat span ends, it calls rollupToAncestors() which walks the
// active context's span + its parents and accumulates a running total on each.
// We keep the running totals in a WeakMap keyed by the span so the final attribute
// values written at span end reflect the sum of descendants.

import { trace, type Span } from '@opentelemetry/api'

import { Attr } from './attributes'

type RollupTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  costCredits: number
  llmCallCount: number
}

const totals: WeakMap<Span, RollupTotals> = new WeakMap()

// Parent pointers for climbing; we store at span-start.
const parents: WeakMap<Span, Span | undefined> = new WeakMap()

function emptyTotals(): RollupTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costCredits: 0,
    llmCallCount: 0,
  }
}

/**
 * Record that `child`'s parent is `parent`. Called when a new rollup-eligible
 * span is created so we can climb the chain at rollup time. OTel's Span API
 * doesn't expose .parent so we track it ourselves.
 */
export function registerSpanParent(child: Span, parent: Span | undefined): void {
  parents.set(child, parent)
  if (!totals.has(child)) totals.set(child, emptyTotals())
}

/**
 * Called at gen_ai.chat span end. Writes the call's own attributes and then
 * accumulates into every ancestor's running total.
 */
export function rollupLlmCall(params: {
  span: Span
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  costCredits?: number
}): void {
  const {
    span,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
    costUsd = 0,
    costCredits = 0,
  } = params

  // The span itself carries its own usage (already set by recordLlmCall).
  // Walk ancestors and accumulate.
  let cursor: Span | undefined = parents.get(span)
  while (cursor) {
    let t = totals.get(cursor)
    if (!t) {
      t = emptyTotals()
      totals.set(cursor, t)
    }
    t.inputTokens += inputTokens
    t.outputTokens += outputTokens
    t.cacheReadTokens += cacheReadTokens
    t.cacheCreationTokens += cacheCreationTokens
    t.costUsd += costUsd
    t.costCredits += costCredits
    t.llmCallCount += 1
    cursor = parents.get(cursor)
  }
}

/**
 * Called just before a parent span ends; flushes its running totals onto its
 * attributes. No-op if no rollups were registered (no children emitted).
 */
export function flushRollupOnEnd(span: Span): void {
  const t = totals.get(span)
  if (!t) return
  try {
    if (t.inputTokens > 0) span.setAttribute(Attr.ROLLUP_INPUT_TOKENS, t.inputTokens)
    if (t.outputTokens > 0) span.setAttribute(Attr.ROLLUP_OUTPUT_TOKENS, t.outputTokens)
    if (t.cacheReadTokens > 0)
      span.setAttribute(Attr.ROLLUP_CACHE_READ_TOKENS, t.cacheReadTokens)
    if (t.cacheCreationTokens > 0)
      span.setAttribute(Attr.ROLLUP_CACHE_CREATION_TOKENS, t.cacheCreationTokens)
    if (t.costUsd > 0) span.setAttribute(Attr.COST_USD, Number(t.costUsd.toFixed(6)))
    if (t.costCredits > 0) span.setAttribute(Attr.COST_CREDITS, t.costCredits)
    if (t.llmCallCount > 0) span.setAttribute(Attr.LLM_CALL_COUNT, t.llmCallCount)
  } catch {
    /* attribute setter failures are swallowed */
  }
}

/**
 * Resolve the current active span (used when we want to register a new child).
 * Returns undefined if no active span or context propagation is disabled.
 */
export function getActiveSpan(): Span | undefined {
  try {
    return trace.getActiveSpan()
  } catch {
    return undefined
  }
}

/** Test-only: clear rollup state. */
export function __resetRollupsForTests(): void {
  // WeakMaps can't be cleared directly; create a token that no existing span uses.
  // Since WeakMaps auto-free, tests should scope spans to blocks. This helper exists
  // for parity with other __reset* helpers.
}
