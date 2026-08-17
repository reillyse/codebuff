/**
 * Claude Code OAuth constants for connecting to user's Claude Pro/Max subscription.
 * These are used by the CLI for the OAuth PKCE flow and by the SDK for direct Anthropic API calls.
 */

/**
 * Feature flag for Claude OAuth (connect:claude) functionality.
 * Enabled by default in this fork. Set CODEBUFF_CLAUDE_OAUTH_ENABLED=false to disable.
 * Controls:
 * - CLI: /connect:claude command, OAuth banner, usage display
 * - SDK: Direct Anthropic API routing via OAuth token
 * - Init: Background credential refresh on startup
 */
export const CLAUDE_OAUTH_ENABLED = process.env.CODEBUFF_CLAUDE_OAUTH_ENABLED !== 'false'

// OAuth client ID used by Claude Code and third-party apps like opencode
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Anthropic OAuth endpoints
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://console.anthropic.com/oauth/authorize'
export const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/oauth/token'

// Anthropic API endpoint for direct calls
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com'

// Environment variable for OAuth token override
export const CLAUDE_OAUTH_TOKEN_ENV_VAR = 'CODEBUFF_CLAUDE_OAUTH_TOKEN'

// Environment variable for OAuth refresh token (enables auto-refresh in headless/K8s environments)
export const CLAUDE_OAUTH_REFRESH_TOKEN_ENV_VAR = 'CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN'

// Required Anthropic API version header
export const ANTHROPIC_API_VERSION = '2023-06-01'

/**
 * Beta headers required for Claude OAuth access to Claude 4+ models.
 * These must be included in the anthropic-beta header when making requests.
 */
export const CLAUDE_OAUTH_BETA_HEADERS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
] as const

/**
 * System prompt prefix required by Anthropic to allow OAuth access to Claude 4+ models.
 * This must be prepended to the system prompt when using Claude OAuth with Claude 4+ models.
 * Without this prefix, requests will fail with "This credential is only authorized for use with Claude Code".
 */
export const CLAUDE_CODE_SYSTEM_PROMPT_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Anthropic model IDs that are currently reachable over the Claude OAuth
 * subscription. Anything not in this set will 404 at the API, so it must never
 * be the *target* of a mapping below.
 *
 * Keep this list in sync when Anthropic ships or retires a model.
 */
export const LIVE_ANTHROPIC_MODEL_IDS = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  // Reachable, but billed as usage credits rather than covered by the
  // subscription — a request may come back 429 `credits_required`.
  'claude-fable-5',
])

/**
 * Model ID mapping from OpenRouter format to Anthropic format.
 * OpenRouter uses prefixed IDs like "anthropic/claude-sonnet-5",
 * while Anthropic uses versioned IDs like "claude-haiku-4-5-20251001".
 *
 * This table contains ONLY models that are currently reachable. Retired models
 * are deliberately absent rather than aliased forward to a successor: silently
 * substituting a different model hides a real configuration problem and can move
 * a caller onto a model with very different behavior and cost. A retired pin
 * instead fails fast in `toAnthropicModelId` with a message naming its
 * successor — see RETIRED_MODEL_SUCCESSORS.
 */
export const OPENROUTER_TO_ANTHROPIC_MODEL_MAP: Record<string, string> = {
  // Claude 4.x Haiku models
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5-20251001',

  // Claude 5.x Sonnet models
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
  'anthropic/claude-sonnet-latest': 'claude-sonnet-5',

  // Claude 4.x Sonnet models
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',

  // Claude Fable models
  'anthropic/claude-fable-5': 'claude-fable-5',
  'anthropic/claude-fable-latest': 'claude-fable-5',

  // Claude 5.x Opus models
  'anthropic/claude-opus-5': 'claude-opus-5',
  'anthropic/claude-opus-latest': 'claude-opus-5',

  // Claude 4.x Opus models
  'anthropic/claude-opus-4.8': 'claude-opus-4-8',
  'anthropic/claude-opus-4.7': 'claude-opus-4-7',
  'anthropic/claude-opus-4.6': 'claude-opus-4-6',
  'anthropic/claude-opus-4.5': 'claude-opus-4-5-20251101',
}

/**
 * Models Anthropic has retired, mapped to the current model in the same family.
 *
 * These are NOT routed. They exist so that a stale pin produces an error that
 * names its replacement instead of a bare "unknown model" — the fix is a
 * one-line edit to the agent definition, and this tells the caller exactly what
 * to write. `claude-opus-5-fast` is included because it is an output-speed mode
 * rather than a distinct API model, so it 404s the same way.
 */
export const RETIRED_MODEL_SUCCESSORS: Record<string, string> = {
  // Claude 3.x
  'anthropic/claude-3-haiku': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3.5-haiku': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3-5-haiku': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3.5-haiku-20241022': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3-5-haiku-20241022': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3-sonnet': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3-5-sonnet': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3-5-sonnet-20241022': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3-5-sonnet-20240620': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3.5-sonnet-20240620': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3.7-sonnet': 'anthropic/claude-sonnet-5',
  'anthropic/claude-3-opus': 'anthropic/claude-opus-5',
  'anthropic/claude-3-opus-20240229': 'anthropic/claude-opus-5',

  // Claude 4.x
  'anthropic/claude-haiku-4': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4': 'anthropic/claude-sonnet-5',
  'anthropic/claude-4-sonnet': 'anthropic/claude-sonnet-5',
  'anthropic/claude-4-sonnet-20250522': 'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4': 'anthropic/claude-opus-5',
  'anthropic/claude-opus-4.1': 'anthropic/claude-opus-5',

  // Fully-versioned forms of the above. Agent definitions pin these directly, so
  // they need their own entries rather than relying on the undated aliases.
  'anthropic/claude-3-haiku-20240307': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-haiku-4-20250514': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3-sonnet-20240229': 'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4-20250514': 'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4-1-20250805': 'anthropic/claude-opus-5',

  // Not a distinct API model — an output-speed mode.
  'anthropic/claude-opus-5-fast': 'anthropic/claude-opus-5',
}

/**
 * Check if a model is a Claude/Anthropic model that can use OAuth.
 */
export function isClaudeModel(model: string): boolean {
  return model.startsWith('anthropic/') || model.startsWith('claude-')
}

/**
 * Throws a "retired model" error naming the replacement, if `lookupKey` refers
 * to a model Anthropic has sunset. `displayName` is what the caller actually
 * wrote, so the message quotes their own string back to them.
 */
function assertNotRetired(lookupKey: string, displayName: string): void {
  const successor = RETIRED_MODEL_SUCCESSORS[lookupKey]
  if (successor) {
    throw new Error(
      `Model "${displayName}" has been retired by Anthropic and is no longer available. Use "${successor}" instead.`,
    )
  }
}

/**
 * Convert an OpenRouter model ID to an Anthropic model ID.
 * Throws an error if the model has a provider prefix but is not an Anthropic model.
 */
export function toAnthropicModelId(openrouterModel: string): string {
  // Already a bare Anthropic model ID (no provider prefix). This still has to be
  // checked: returning it unvalidated would let a retired ID like
  // "claude-sonnet-4-20250514" through to a guaranteed 404.
  if (!openrouterModel.includes('/')) {
    if (LIVE_ANTHROPIC_MODEL_IDS.has(openrouterModel)) {
      return openrouterModel
    }
    assertNotRetired(`anthropic/${openrouterModel}`, openrouterModel)
    throw new Error(
      `Unknown Anthropic model "${openrouterModel}". It is not a known live model, so the request would fail with a 404. ` +
        `Available models: ${Object.keys(OPENROUTER_TO_ANTHROPIC_MODEL_MAP).sort().join(', ')}.`,
    )
  }

  // Require anthropic/ prefix for OpenRouter model IDs
  if (!openrouterModel.startsWith('anthropic/')) {
    throw new Error(
      `Cannot convert non-Anthropic model to Anthropic model ID: ${openrouterModel}`,
    )
  }

  // Check the mapping table
  const mapped = OPENROUTER_TO_ANTHROPIC_MODEL_MAP[openrouterModel]
  if (mapped) {
    return mapped
  }

  // A model Anthropic has retired. Fail with its replacement rather than routing
  // to a substitute: the pin is wrong and only the caller should decide what
  // replaces it.
  assertNotRetired(openrouterModel, openrouterModel)

  // Fallback: strip the "anthropic/" prefix. Only trust this when the result is
  // a model we know is actually reachable — otherwise the request 404s deep
  // inside the stream and resurfaces as an opaque "No output generated" that the
  // retry ladder mistakes for a transient overload. Failing here instead names
  // the real problem at the point where it can still be understood.
  const stripped = openrouterModel.slice('anthropic/'.length)
  if (!LIVE_ANTHROPIC_MODEL_IDS.has(stripped)) {
    throw new Error(
      `Unknown Anthropic model "${openrouterModel}". It is not a known live model, so the request would fail with a 404. ` +
        `Available models: ${Object.keys(OPENROUTER_TO_ANTHROPIC_MODEL_MAP).sort().join(', ')}.`,
    )
  }
  return stripped
}
