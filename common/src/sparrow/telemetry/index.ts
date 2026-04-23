// SPARROW: Public API for the telemetry module. Only the symbols exported here
// should be imported by call sites (sdk/, packages/agent-runtime/, cli/).

import { resolveTelemetryConfig } from '../config/sparrow-config'

export {
  initTelemetry,
  reinitTelemetry,
  shutdownTelemetry,
  flushTelemetry,
  isTelemetryActive,
  __initTelemetryForTests,
  __resetTelemetryForTests,
  getTracer,
  type TelemetryInitOptions,
} from './tracer-provider'

export {
  withSpan,
  withPromptSpan,
  withAgentRunSpan,
  withAgentStepSpan,
  recordLlmCall,
  recordToolCall,
  type LlmCallSpanHandle,
  type PromptSpanAttrs,
  type AgentRunSpanAttrs,
  type AgentStepSpanAttrs,
  type ToolCallSpanParams,
  type ToolCallResult,
} from './span-helpers'

export {
  harvestContext,
  harvestContextAwait,
  harvestContextNow,
  normalizeRemoteUrl,
  extractLinearIssue,
  primeHarvestCache,
  __resetHarvestCache,
  type HarvestedContext,
  type HarvestOptions,
} from './context-harvester'

export { Attr, Events, SpanNames, type RouteValue } from './attributes'

/**
 * Derive a route classification from SDK-internal flags.
 * Centralized so `claude_oauth`/`chatgpt_oauth`/`codebuff_backend`/`direct_*`
 * stay in sync across the codebase.
 */
export function classifyLlmRoute(params: {
  isClaudeOAuth?: boolean
  isChatGptOAuth?: boolean
  /** True when request flows through the Codebuff backend (default). */
  viaCodebuffBackend?: boolean
  /** Fallback direct provider name (openrouter, anthropic, openai, …). */
  directProvider?: string
}): import('./attributes').RouteValue {
  if (params.isClaudeOAuth) return 'claude_oauth'
  if (params.isChatGptOAuth) return 'chatgpt_oauth'
  if (params.viaCodebuffBackend) return 'codebuff_backend'
  const provider = (params.directProvider || 'unknown').toLowerCase()
  return `direct_${provider}`
}

/**
 * True when the caller opted in to full message-content capture.
 *
 * Resolution order (see `resolveTelemetryConfig`):
 *   1. SPARROW_TELEMETRY_CAPTURE_PROMPTS=full env var
 *   2. telemetry.capturePrompts === 'full' in sparrow-config.json
 *   3. default: false
 *
 * Privacy-by-default: any value other than the literal string 'full' keeps
 * this flag off (e.g. 'true', '1', '' all resolve to false).
 */
export function shouldCapturePrompts(): boolean {
  return resolveTelemetryConfig().capturePrompts
}
