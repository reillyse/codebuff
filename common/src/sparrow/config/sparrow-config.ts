// SPARROW: Shared Sparrow config stored at ~/.config/manicode{-env}/sparrow-config.json
//
// Design goals:
// - Single file for all Sparrow-only, non-credential config (telemetry, future
//   features). Credentials live separately in credentials.json.
// - Env-suffixed path mirrors the existing credentials pattern
//   (credentials.json / auth.ts / sdk/credentials.ts) so dev / test / prod
//   stay isolated.
// - Layered resolution: explicit args > env vars > file > defaults. Env vars
//   stay as an escape hatch for CI and one-off overrides.
// - Writes are read-modify-write with JSON.parse fallback — never clobber
//   fields this version doesn't know about.
// - No side effects at import time. No logging on missing file (first-run OK).

import fs from 'fs'
import os from 'os'
import path from 'node:path'

import { z } from 'zod/v4'

/**
 * Telemetry section of sparrow-config.json.
 *
 * All fields optional so that partial configs are valid. Env var overrides
 * apply in {@link resolveTelemetryConfig}.
 */
const telemetrySchema = z
  .object({
    /**
     * Explicit opt-out switch. When false, telemetry is inactive regardless of
     * apiKey presence. When undefined, telemetry activates iff an apiKey is
     * resolvable (from env or file).
     */
    enabled: z.boolean().optional(),
    honeycomb: z
      .object({
        apiKey: z.string().optional(),
        /** Default dataset is 'sparrow-codebuff' (see tracer-provider.ts). */
        dataset: z.string().optional(),
      })
      .optional(),
    /**
     * 'full' captures prompt/message content as span events. Any other value
     * (including undefined) keeps privacy-by-default behavior.
     */
    capturePrompts: z.enum(['full', 'off']).optional(),
    /** Gate exporter debug logs (noisier than the DEBUG env var). */
    debug: z.boolean().optional(),
    /**
     * Set to true by /telemetry commands once a first-run hint has been shown,
     * so we never nag twice.
     */
    hintShown: z.boolean().optional(),
  })
  .optional()

const sparrowConfigSchema = z
  .object({
    telemetry: telemetrySchema,
  })
  // Catch-all preserves unknown fields on load/save round-trips so newer
  // versions adding fields don't get clobbered by older versions writing.
  .catchall(z.unknown())

export type SparrowConfig = z.infer<typeof sparrowConfigSchema>
export type TelemetryConfig = NonNullable<SparrowConfig['telemetry']>

const CONFIG_FILE = 'sparrow-config.json'

/**
 * Env var used to derive the config dir suffix. Kept narrow so the config
 * module doesn't pull in the full ClientEnv contract.
 */
function getEnvSuffix(envOverride?: string | null): string {
  const cbEnv =
    envOverride !== undefined
      ? envOverride
      : process.env.NEXT_PUBLIC_CB_ENVIRONMENT
  if (!cbEnv || cbEnv === 'prod') return ''
  return `-${cbEnv}`
}

/**
 * Resolve the home directory.
 *
 * Honors `process.env.HOME` when set so tests can redirect I/O to a tmp dir;
 * otherwise falls back to `os.homedir()` (which reads the OS password DB and
 * does NOT re-read `HOME` between calls on macOS).
 */
function getHomeDir(): string {
  const fromEnv = process.env.HOME
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return os.homedir()
}

/**
 * ~/.config/manicode{-env}/
 *
 * Mirrors `cli/src/utils/auth.ts::getConfigDir()` and
 * `sdk/src/credentials.ts::getConfigDir()`. Kept as its own function here
 * because this module must be importable from `common/` (which can't depend
 * on cli/ or sdk/).
 */
export function getSparrowConfigDir(envOverride?: string | null): string {
  return path.join(getHomeDir(), '.config', `manicode${getEnvSuffix(envOverride)}`)
}

/** Path to the sparrow-config.json file for the current environment. */
export function getSparrowConfigPath(envOverride?: string | null): string {
  return path.join(getSparrowConfigDir(envOverride), CONFIG_FILE)
}

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// Module-level cache keyed by envOverride so repeated calls don't re-read the
// file on every hot path (shouldCapturePrompts runs per LLM call). Invalidated
// by saveSparrowConfig and __resetSparrowConfigCacheForTests.
const loadCache = new Map<string, SparrowConfig>()

function cacheKey(envOverride?: string | null): string {
  // Normalize undefined/null to '' so "no override" always hits the same slot.
  if (envOverride === undefined || envOverride === null) return ''
  return envOverride
}

/**
 * Load the raw on-disk config. Missing file returns `{}` (first-run default).
 * Corrupt JSON is swallowed and treated as missing — we never throw from
 * config load paths so telemetry can't crash the CLI.
 *
 * Results are cached per envOverride; mutations go through
 * {@link saveSparrowConfig} which invalidates the cache automatically.
 */
export function loadSparrowConfig(envOverride?: string | null): SparrowConfig {
  const key = cacheKey(envOverride)
  const cached = loadCache.get(key)
  if (cached !== undefined) return cached

  const filePath = getSparrowConfigPath(envOverride)
  let result: SparrowConfig = {}
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = sparrowConfigSchema.safeParse(JSON.parse(raw))
      if (parsed.success) result = parsed.data
    } catch {
      /* ignore — fall through to {} */
    }
  }
  loadCache.set(key, result)
  return result
}

/** Test-only: clear the in-process config cache between tests. */
export function __resetSparrowConfigCacheForTests(): void {
  loadCache.clear()
}

/**
 * Merge-save config. Reads the current file, deep-merges the new values at
 * the top level and within `telemetry`, and writes atomically.
 *
 * Top-level catchall fields (unknown to this version) are preserved
 * verbatim. Within `telemetry`, individual keys are replaced when supplied
 * and left alone otherwise.
 */
export function saveSparrowConfig(
  partial: Partial<SparrowConfig>,
  envOverride?: string | null,
): void {
  const dir = getSparrowConfigDir(envOverride)
  const filePath = getSparrowConfigPath(envOverride)

  ensureDirSync(dir)

  const existing = loadSparrowConfig(envOverride)

  const merged: SparrowConfig = {
    ...existing,
    ...partial,
    telemetry: mergeTelemetry(existing.telemetry, partial.telemetry),
  }

  // Strip undefined telemetry key entirely to keep file tidy.
  if (merged.telemetry === undefined) {
    delete (merged as Record<string, unknown>).telemetry
  }

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2))

  // Invalidate cache so subsequent loads see the new values. We clear all
  // envOverride slots rather than guessing which one the caller used.
  loadCache.clear()
}

function mergeTelemetry(
  existing: TelemetryConfig | undefined,
  incoming: TelemetryConfig | undefined,
): TelemetryConfig | undefined {
  if (!existing && !incoming) return undefined
  if (!existing) return incoming
  if (!incoming) return existing
  return {
    ...existing,
    ...incoming,
    honeycomb: incoming.honeycomb
      ? { ...(existing.honeycomb ?? {}), ...incoming.honeycomb }
      : existing.honeycomb,
  }
}

/**
 * Source a single resolved value came from. Surfaced by
 * {@link resolveTelemetryConfig} so `/telemetry status` can explain
 * precedence to the user.
 */
export type ResolvedSource = 'arg' | 'env' | 'file' | 'default'

export type ResolvedTelemetryConfig = {
  enabled: boolean
  apiKey: string | undefined
  dataset: string
  capturePrompts: boolean
  debug: boolean
  sources: {
    enabled: ResolvedSource
    apiKey: ResolvedSource
    dataset: ResolvedSource
    capturePrompts: ResolvedSource
    debug: ResolvedSource
  }
}

const DEFAULT_DATASET = 'sparrow-codebuff'

/**
 * Resolve the effective telemetry config with precedence:
 *   explicit args > env vars > config file > defaults.
 *
 * Returns resolved values plus a parallel `sources` map so callers can show
 * *where* each value came from (the `/telemetry status` command uses this).
 *
 * Pure: no disk writes, safe to call repeatedly. Reads disk once via
 * {@link loadSparrowConfig}.
 */
export function resolveTelemetryConfig(args?: {
  apiKey?: string
  dataset?: string
  enabled?: boolean
  capturePrompts?: boolean
  debug?: boolean
  /** Override NEXT_PUBLIC_CB_ENVIRONMENT resolution (for tests). */
  envSuffix?: string | null
}): ResolvedTelemetryConfig {
  const file = loadSparrowConfig(args?.envSuffix).telemetry ?? {}

  // API KEY
  let apiKey: string | undefined
  let apiKeySource: ResolvedSource = 'default'
  if (args?.apiKey !== undefined && args.apiKey.trim().length > 0) {
    apiKey = args.apiKey.trim()
    apiKeySource = 'arg'
  } else {
    const envKey = (process.env.HONEYCOMB_API_KEY || '').trim()
    if (envKey.length > 0) {
      apiKey = envKey
      apiKeySource = 'env'
    } else {
      const fileKey = (file.honeycomb?.apiKey || '').trim()
      if (fileKey.length > 0) {
        apiKey = fileKey
        apiKeySource = 'file'
      }
    }
  }

  // DATASET
  let dataset = DEFAULT_DATASET
  let datasetSource: ResolvedSource = 'default'
  if (args?.dataset && args.dataset.trim().length > 0) {
    dataset = args.dataset.trim()
    datasetSource = 'arg'
  } else {
    const envDataset = (process.env.HONEYCOMB_DATASET || '').trim()
    if (envDataset.length > 0) {
      dataset = envDataset
      datasetSource = 'env'
    } else if (file.honeycomb?.dataset && file.honeycomb.dataset.trim().length > 0) {
      dataset = file.honeycomb.dataset.trim()
      datasetSource = 'file'
    }
  }

  // ENABLED — if not explicitly set, activate iff we have an apiKey.
  let enabled: boolean
  let enabledSource: ResolvedSource = 'default'
  if (args?.enabled !== undefined) {
    enabled = args.enabled
    enabledSource = 'arg'
  } else if (file.enabled !== undefined) {
    enabled = file.enabled
    enabledSource = 'file'
  } else {
    enabled = apiKey !== undefined
    enabledSource = apiKey !== undefined ? apiKeySource : 'default'
  }

  // CAPTURE PROMPTS
  let capturePrompts = false
  let capturePromptsSource: ResolvedSource = 'default'
  if (args?.capturePrompts !== undefined) {
    capturePrompts = args.capturePrompts
    capturePromptsSource = 'arg'
  } else if (process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS === 'full') {
    capturePrompts = true
    capturePromptsSource = 'env'
  } else if (file.capturePrompts === 'full') {
    capturePrompts = true
    capturePromptsSource = 'file'
  }

  // DEBUG
  let debug = false
  let debugSource: ResolvedSource = 'default'
  if (args?.debug !== undefined) {
    debug = args.debug
    debugSource = 'arg'
  } else if (process.env.DEBUG && /sparrow:telemetry/.test(process.env.DEBUG)) {
    debug = true
    debugSource = 'env'
  } else if (file.debug === true) {
    debug = true
    debugSource = 'file'
  }

  return {
    enabled,
    apiKey,
    dataset,
    capturePrompts,
    debug,
    sources: {
      enabled: enabledSource,
      apiKey: apiKeySource,
      dataset: datasetSource,
      capturePrompts: capturePromptsSource,
      debug: debugSource,
    },
  }
}
