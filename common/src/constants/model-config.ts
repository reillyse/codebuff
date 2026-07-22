import { isExplicitlyDefinedModel } from '../util/model-utils'

// Allowed model prefixes for validation.
// Standardized on OpenAI + Anthropic (routed via OAuth subscriptions).
export const ALLOWED_MODEL_PREFIXES = ['anthropic', 'openai'] as const

export const costModes = [
  'free',
  'normal',
  'max',
  'experimental',
  'ask',
] as const
export type CostMode = (typeof costModes)[number]

export const openaiModels = {
  gpt4_1: 'gpt-4.1-2025-04-14',
  gpt4o: 'gpt-4o-2024-11-20',
  gpt4omini: 'gpt-4o-mini-2024-07-18',
  o3mini: 'o3-mini-2025-01-31',
  o3: 'o3-2025-04-16',
  o3pro: 'o3-pro-2025-06-10',
  o4mini: 'o4-mini-2025-04-16',
  generatePatch:
    'ft:gpt-4o-2024-08-06:manifold-markets:generate-patch-batch2:AKYtDIhk',
} as const
export type OpenAIModel = (typeof openaiModels)[keyof typeof openaiModels]

export const openrouterModels = {
  openrouter_claude_sonnet_5: 'anthropic/claude-sonnet-5',
  openrouter_claude_sonnet_4_6: 'anthropic/claude-sonnet-4.6',
  openrouter_claude_sonnet_4: 'anthropic/claude-4-sonnet-20250522',
  openrouter_claude_opus_4: 'anthropic/claude-opus-4.8',
  openrouter_claude_fable_5: 'anthropic/claude-fable-5',
  // Updated from claude-3.5-haiku to claude-haiku-4.5
  openrouter_claude_3_5_haiku: 'anthropic/claude-haiku-4.5',
  openrouter_claude_3_5_sonnet: 'anthropic/claude-3.5-sonnet-20240620',
  openrouter_gpt4o: 'openai/gpt-4o-2024-11-20',
  openrouter_gpt5: 'openai/gpt-5.2',
  openrouter_gpt5_chat: 'openai/gpt-5.2-chat',
  openrouter_gpt4o_mini: 'openai/gpt-4o-mini-2024-07-18',
  openrouter_gpt4_1_nano: 'openai/gpt-4.1-nano',
  openrouter_o3_mini: 'openai/o3-mini-2025-01-31',
  openrouter_gemini2_5_pro_preview: 'google/gemini-2.5-pro',
  // Migrated from gemini-2.5-flash (deprecated June 1, 2026)
  openrouter_gemini2_5_flash: 'google/gemini-3.1-flash-lite-preview',
  openrouter_gemini2_5_flash_thinking:
    'google/gemini-2.5-flash-preview:thinking',
} as const
export type openrouterModel =
  (typeof openrouterModels)[keyof typeof openrouterModels]

// Vertex uses "endpoint IDs" for finetuned models, which are just integers
export const finetunedVertexModels = {
  ft_filepicker_003: '196166068534771712',
  ft_filepicker_005: '8493203957034778624',
  ft_filepicker_007: '2589952415784501248',
  ft_filepicker_topk_001: '3676445825887633408',
  ft_filepicker_008: '2672143108984012800',
  ft_filepicker_topk_002: '1694861989844615168',
  ft_filepicker_010: '3808739064941641728',
  ft_filepicker_010_epoch_2: '6231675664466968576',
  ft_filepicker_topk_003: '1502192368286171136',
} as const
export const finetunedVertexModelNames: Record<string, string> = {
  [finetunedVertexModels.ft_filepicker_003]: 'ft_filepicker_003',
  [finetunedVertexModels.ft_filepicker_005]: 'ft_filepicker_005',
  [finetunedVertexModels.ft_filepicker_007]: 'ft_filepicker_007',
  [finetunedVertexModels.ft_filepicker_topk_001]: 'ft_filepicker_topk_001',
  [finetunedVertexModels.ft_filepicker_008]: 'ft_filepicker_008',
  [finetunedVertexModels.ft_filepicker_topk_002]: 'ft_filepicker_topk_002',
  [finetunedVertexModels.ft_filepicker_010]: 'ft_filepicker_010',
  [finetunedVertexModels.ft_filepicker_010_epoch_2]:
    'ft_filepicker_010_epoch_2',
  [finetunedVertexModels.ft_filepicker_topk_003]: 'ft_filepicker_topk_003',
}
export type FinetunedVertexModel =
  (typeof finetunedVertexModels)[keyof typeof finetunedVertexModels]

export const models = {
  ...openaiModels,
  ...openrouterModels,
  ...finetunedVertexModels,
} as const

/** The current Opus model version used by agents. Update this single constant when upgrading. */
export const CURRENT_OPUS_MODEL = (process.env.CODEBUFF_OPUS_MODEL ?? 'anthropic/claude-opus-4.8') as 'anthropic/claude-opus-4.8'

/**
 * The current Sonnet model version used by agents. Update this single constant
 * when upgrading.
 *
 * NOTE: temporarily pinned to sonnet-4.6 (was sonnet-5). sonnet-5 was dropping
 * streams (empty responses) for many sessions, so it's been pulled from the
 * default/agent path for now. The `openrouter_claude_sonnet_5` model constant
 * and the `'sonnet-5'` short name are retained so it can still be selected
 * explicitly and re-promoted here later.
 */
export const CURRENT_SONNET_MODEL = 'anthropic/claude-sonnet-4.6' as const

/**
 * The current Fable model version used by agents. Update this single constant when upgrading.
 * Fable is Anthropic's premium planning/debugging model (~2x the cost of Opus), so it is only
 * used on deliberate, opt-in paths (PLAN mode and the spawnable fable-agent).
 */
export const CURRENT_FABLE_MODEL = (process.env.CODEBUFF_FABLE_MODEL ?? 'anthropic/claude-fable-5') as 'anthropic/claude-fable-5'

/** The current GPT-5 model version used by agents. Update this single constant when upgrading. */
export const CURRENT_GPT5_MODEL = 'openai/gpt-5.2' as const

/** The current lightweight GPT-5 model used by reasoning/research utility agents (routed via ChatGPT OAuth). */
export const CURRENT_GPT5_MINI_MODEL = 'openai/gpt-5-mini' as const

/** The current Haiku model used by lightweight utility agents (routed via Claude OAuth). */
export const CURRENT_HAIKU_MODEL = 'anthropic/claude-haiku-4.5' as const

export const shortModelNames = {
  'gemini-2.5-pro': models.openrouter_gemini2_5_pro_preview,
  'flash-3.1': models.openrouter_gemini2_5_flash,
  'flash-2.5': models.openrouter_gemini2_5_flash, // deprecated alias
  'opus-4': models.openrouter_claude_opus_4,
  'sonnet-5': models.openrouter_claude_sonnet_5,
  'sonnet-4.6': models.openrouter_claude_sonnet_4_6,
  'sonnet-4.5': models.openrouter_claude_sonnet_4_6, // deprecated alias (was sonnet-5; repointed while sonnet-5 is pulled)
  'sonnet-4': models.openrouter_claude_sonnet_4,
  'sonnet-3.7': models.openrouter_claude_sonnet_4,
  'sonnet-3.6': models.openrouter_claude_3_5_sonnet,
  'sonnet-3.5': models.openrouter_claude_3_5_sonnet,
  'gpt-4.1': models.gpt4_1,
  'o3-mini': models.o3mini,
  o3: models.o3,
  'o4-mini': models.o4mini,
  'o3-pro': models.o3pro,
}

export const providerModelNames = {
  ...Object.fromEntries(
    Object.entries(openaiModels).map(([name, model]) => [
      model,
      'openai' as const,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(openrouterModels).map(([name, model]) => [
      model,
      'openrouter' as const,
    ]),
  ),
}

export type Model = (typeof models)[keyof typeof models] | (string & {})

export const shouldCacheModels = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-opus-4',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-haiku-4.5',
  'z-ai/glm-4.5',
  'qwen/qwen3-coder',
]
const nonCacheableModels: string[] = []
export function supportsCacheControl(model: Model): boolean {
  if (model.startsWith('openai/')) {
    return true
  }
  if (model.startsWith('anthropic/')) {
    return true
  }
  if (!isExplicitlyDefinedModel(model)) {
    // Default to no cache control for unknown models
    return false
  }
  return !nonCacheableModels.includes(model)
}

export function getModelFromShortName(
  modelName: string | undefined,
): Model | undefined {
  if (!modelName) return undefined
  if (modelName && !(modelName in shortModelNames)) {
    throw new Error(
      `Unknown model: ${modelName}. Please use a valid model. Valid models are: ${Object.keys(
        shortModelNames,
      ).join(', ')}`,
    )
  }

  return shortModelNames[modelName as keyof typeof shortModelNames]
}

export const providerDomains = {
  google: 'google.com',
  anthropic: 'anthropic.com',
  openai: 'chatgpt.com',
  deepseek: 'deepseek.com',
  xai: 'x.ai',
} as const

export function getLogoForModel(modelName: string): string | undefined {
  let domain: string | undefined

  if (Object.values(openaiModels).includes(modelName as OpenAIModel))
    domain = providerDomains.openai
  else if (modelName.includes('claude')) domain = providerDomains.anthropic
  else if (modelName.includes('grok')) domain = providerDomains.xai

  return domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=256`
    : undefined
}

export const getModelForMode = (
  costMode: CostMode,
  operation: 'agent' | 'file-requests' | 'check-new-files',
) => {
  if (operation === 'agent') {
    return {
      free: models.openrouter_claude_3_5_haiku,
      normal: models.openrouter_claude_sonnet_4_6,
      max: models.openrouter_claude_sonnet_4_6,
      experimental: models.openrouter_claude_opus_4,
      ask: models.openrouter_claude_opus_4,
    }[costMode]
  }
  if (operation === 'file-requests') {
    return {
      free: models.openrouter_claude_3_5_haiku,
      normal: models.openrouter_claude_3_5_haiku,
      max: models.openrouter_claude_sonnet_4_6,
      experimental: models.openrouter_claude_sonnet_4,
      ask: models.openrouter_claude_3_5_haiku,
    }[costMode]
  }
  if (operation === 'check-new-files') {
    return {
      free: models.openrouter_claude_3_5_haiku,
      normal: models.openrouter_claude_sonnet_4,
      max: models.openrouter_claude_sonnet_4_6,
      experimental: models.openrouter_claude_sonnet_4,
      ask: models.openrouter_claude_sonnet_4,
    }[costMode]
  }
  throw new Error(`Unknown operation: ${operation}`)
}

/**
 * Escalation ladder used to escape Anthropic 529 (Overloaded) errors.
 *
 * A 529 is an Anthropic-wide capacity signal, so we first try a *peer-strength*
 * sibling Anthropic model (a different model may draw from a different capacity
 * pool, and opus is a peer of sonnet so a 529 doesn't drop coding quality), and
 * if that keeps overloading we cross-provider fall back to GPT-5, which leaves
 * Anthropic entirely.
 *
 * Returns the next model to try, or `undefined` when there is no further
 * fallback (e.g. we're already on an OpenAI model).
 *
 * Example ladders:
 *   sonnet-4.6 -> opus -> gpt-5.2
 *   fable-5    -> sonnet-4.6 -> opus -> gpt-5.2
 */
export function getOverloadFallbackModel(
  currentModel: Model,
): Model | undefined {
  // Already off Anthropic — no further overload fallback needed.
  if (currentModel.startsWith('openai/')) return undefined

  if (currentModel === CURRENT_SONNET_MODEL) return CURRENT_OPUS_MODEL
  if (currentModel === CURRENT_FABLE_MODEL) return CURRENT_SONNET_MODEL
  if (currentModel === CURRENT_OPUS_MODEL) return CURRENT_GPT5_MODEL
  if (currentModel === CURRENT_HAIKU_MODEL) return CURRENT_GPT5_MODEL

  // Any other Anthropic model: escalate straight to GPT-5.
  if (currentModel.startsWith('anthropic/')) return CURRENT_GPT5_MODEL

  // Non-Anthropic, non-OpenAI models: escape to GPT-5.
  return CURRENT_GPT5_MODEL
}

/**
 * Escalation ladder used to escape EMPTY responses (a dropped/truncated
 * provider stream that finished "cleanly" — no content, no tool calls).
 *
 * Unlike a 529 (an Anthropic-wide capacity signal), an empty response is often
 * a per-model/per-request stream hiccup, so we escalate to a peer-strength
 * sibling (Opus preserves coding quality while likely drawing from a different
 * capacity pool), and finally cross-provider to GPT-5 if the stream keeps
 * dropping. This is intentionally SEPARATE from getOverloadFallbackModel so
 * changing empty-response recovery never alters 529 behavior.
 *
 * (Historically this stepped Sonnet -> a distinct older Sonnet first; that rung
 * was removed when sonnet-5 was pulled and sonnet-4.6 became the base Sonnet.)
 *
 * Returns the next model to try, or `undefined` when there is no further
 * fallback (e.g. we're already on an OpenAI model).
 *
 * Example ladder:
 *   sonnet-4.6 -> opus -> gpt-5.2
 */
export function getEmptyResponseFallbackModel(
  currentModel: Model,
): Model | undefined {
  // Already off Anthropic — no further empty-response fallback needed.
  if (currentModel.startsWith('openai/')) return undefined

  if (currentModel === CURRENT_SONNET_MODEL) return CURRENT_OPUS_MODEL
  if (currentModel === CURRENT_FABLE_MODEL) return CURRENT_SONNET_MODEL
  if (currentModel === CURRENT_OPUS_MODEL) return CURRENT_GPT5_MODEL
  if (currentModel === CURRENT_HAIKU_MODEL) return CURRENT_GPT5_MODEL

  // Any other Anthropic model: escalate straight to GPT-5.
  if (currentModel.startsWith('anthropic/')) return CURRENT_GPT5_MODEL

  // Non-Anthropic, non-OpenAI models: escape to GPT-5.
  return CURRENT_GPT5_MODEL
}
