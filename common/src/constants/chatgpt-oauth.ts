/**
 * ChatGPT subscription OAuth constants for experimental direct OpenAI routing.
 */

/**
 * Feature flag for ChatGPT OAuth (connect:chatgpt) functionality.
 * Default OFF until validated.
 */
export const CHATGPT_OAUTH_ENABLED = true

/** OAuth client id used by Codex-compatible OAuth ecosystems. */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** OAuth endpoints */
export const CHATGPT_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CHATGPT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Pinned redirect URI for paste-based localhost callback flow. */
export const CHATGPT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

/** Base URL for ChatGPT backend API (Codex endpoint). */
export const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api'

/** Environment variable for OAuth token override. */
export const CHATGPT_OAUTH_TOKEN_ENV_VAR = 'CODEBUFF_CHATGPT_OAUTH_TOKEN'

/**
 * ID-override table for ChatGPT OAuth routing.
 * Maps OpenRouter-style model IDs to their direct OpenAI model IDs when they differ.
 * All openai/* models are routed via ChatGPT OAuth; this map is only consulted
 * when the internal OpenAI model ID differs from stripping the "openai/" prefix.
 */
export const OPENROUTER_TO_OPENAI_MODEL_MAP: Record<string, string> = {
  // Add entries here only when the internal OpenAI model ID differs from
  // stripping the "openai/" prefix (e.g. 'openai/foo-alias': 'foo-internal-id').
  // All other openai/* models are handled by the prefix-strip fallback in toOpenAIModelId.
}

export function isOpenAIProviderModel(model: string): boolean {
  return model.startsWith('openai/')
}

/**
 * Check if a model should be routed via ChatGPT OAuth.
 * All openai/* models are eligible — no explicit allowlist needed.
 */
export function isChatGptOAuthModelAllowed(model: string): boolean {
  return isOpenAIProviderModel(model)
}

/**
 * Normalize OpenRouter-style model IDs to direct OpenAI model IDs.
 * Example: "openai/gpt-5.3-codex" => "gpt-5.3-codex"
 */
export function toOpenAIModelId(model: string): string {
  if (!model.includes('/')) {
    return model
  }

  if (!model.startsWith('openai/')) {
    throw new Error(
      `Cannot convert non-OpenAI model to OpenAI model ID: ${model}`,
    )
  }

  const mapped = OPENROUTER_TO_OPENAI_MODEL_MAP[model]
  if (mapped) {
    return mapped
  }

  // Fallback: strip the "openai/" prefix, same pattern as toAnthropicModelId.
  return model.slice('openai/'.length)
}
