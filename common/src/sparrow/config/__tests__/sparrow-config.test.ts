import fs from 'fs'
import os from 'os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  __resetSparrowConfigCacheForTests,
  getSparrowConfigDir,
  getSparrowConfigPath,
  loadSparrowConfig,
  resolveTelemetryConfig,
  saveSparrowConfig,
} from '../sparrow-config'

// Each test runs inside its own temp HOME so the real ~/.config isn't touched.
let tmpHome: string
const originalHome = process.env.HOME
const originalCbEnv = process.env.NEXT_PUBLIC_CB_ENVIRONMENT
const originalHoneycombKey = process.env.HONEYCOMB_API_KEY
const originalHoneycombDataset = process.env.HONEYCOMB_DATASET
const originalCapturePrompts = process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS
const originalDebug = process.env.DEBUG

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-config-test-'))
  process.env.HOME = tmpHome
  delete process.env.NEXT_PUBLIC_CB_ENVIRONMENT
  delete process.env.HONEYCOMB_API_KEY
  delete process.env.HONEYCOMB_DATASET
  delete process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS
  delete process.env.DEBUG
  // Clear module-level load cache so each test sees a fresh state (the
  // module caches loadSparrowConfig results for hot-path perf).
  __resetSparrowConfigCacheForTests()
})

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  restore('HOME', originalHome)
  restore('NEXT_PUBLIC_CB_ENVIRONMENT', originalCbEnv)
  restore('HONEYCOMB_API_KEY', originalHoneycombKey)
  restore('HONEYCOMB_DATASET', originalHoneycombDataset)
  restore('SPARROW_TELEMETRY_CAPTURE_PROMPTS', originalCapturePrompts)
  restore('DEBUG', originalDebug)
})

describe('getSparrowConfigDir / getSparrowConfigPath', () => {
  it('defaults to ~/.config/manicode/ (no env suffix)', () => {
    expect(getSparrowConfigDir()).toBe(path.join(tmpHome, '.config', 'manicode'))
    expect(getSparrowConfigPath()).toBe(
      path.join(tmpHome, '.config', 'manicode', 'sparrow-config.json'),
    )
  })

  it('appends env suffix from NEXT_PUBLIC_CB_ENVIRONMENT', () => {
    process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'dev'
    expect(getSparrowConfigDir()).toBe(
      path.join(tmpHome, '.config', 'manicode-dev'),
    )
  })

  it('"prod" env is treated as no suffix', () => {
    process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'prod'
    expect(getSparrowConfigDir()).toBe(path.join(tmpHome, '.config', 'manicode'))
  })

  it('respects explicit envOverride argument', () => {
    expect(getSparrowConfigDir('test')).toBe(
      path.join(tmpHome, '.config', 'manicode-test'),
    )
    // null explicitly disables suffix lookup via env too
    process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'dev'
    expect(getSparrowConfigDir(null)).toBe(
      path.join(tmpHome, '.config', 'manicode'),
    )
  })
})

describe('loadSparrowConfig', () => {
  it('returns {} when the file does not exist', () => {
    expect(loadSparrowConfig()).toEqual({})
  })

  it('parses a valid file', () => {
    const filePath = getSparrowConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        telemetry: {
          enabled: true,
          honeycomb: { apiKey: 'hcik_abc', dataset: 'my-dataset' },
          capturePrompts: 'full',
          debug: false,
        },
      }),
    )
    const loaded = loadSparrowConfig()
    expect(loaded.telemetry?.enabled).toBe(true)
    expect(loaded.telemetry?.honeycomb?.apiKey).toBe('hcik_abc')
    expect(loaded.telemetry?.honeycomb?.dataset).toBe('my-dataset')
    expect(loaded.telemetry?.capturePrompts).toBe('full')
  })

  it('falls back to {} on corrupt JSON', () => {
    const filePath = getSparrowConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{not-json')
    expect(loadSparrowConfig()).toEqual({})
  })

  it('falls back to {} on schema-violating JSON', () => {
    const filePath = getSparrowConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // capturePrompts accepts 'full' | 'off' only; 'yes' should fail validation
    fs.writeFileSync(
      filePath,
      JSON.stringify({ telemetry: { capturePrompts: 'yes' } }),
    )
    expect(loadSparrowConfig()).toEqual({})
  })

  it('preserves unknown top-level fields via catchall (round-trip safe)', () => {
    const filePath = getSparrowConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        telemetry: { enabled: true },
        futureFeature: { nested: 42 },
      }),
    )
    const loaded = loadSparrowConfig()
    expect((loaded as Record<string, unknown>).futureFeature).toEqual({
      nested: 42,
    })
  })
})

describe('saveSparrowConfig', () => {
  it('creates the config directory if missing', () => {
    saveSparrowConfig({ telemetry: { enabled: true } })
    expect(fs.existsSync(getSparrowConfigPath())).toBe(true)
  })

  it('writes the config to disk as pretty-printed JSON', () => {
    saveSparrowConfig({ telemetry: { enabled: true } })
    const raw = fs.readFileSync(getSparrowConfigPath(), 'utf8')
    expect(raw).toContain('"enabled": true')
  })

  it('merges new telemetry keys with existing file', () => {
    saveSparrowConfig({
      telemetry: { honeycomb: { apiKey: 'original' } },
    })
    saveSparrowConfig({
      telemetry: { enabled: true, honeycomb: { dataset: 'new-dataset' } },
    })
    const loaded = loadSparrowConfig()
    expect(loaded.telemetry?.enabled).toBe(true)
    expect(loaded.telemetry?.honeycomb?.apiKey).toBe('original')
    expect(loaded.telemetry?.honeycomb?.dataset).toBe('new-dataset')
  })

  it('preserves unknown top-level fields across writes', () => {
    const filePath = getSparrowConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        telemetry: { enabled: true },
        unknownExtension: 'keep me',
      }),
    )

    saveSparrowConfig({ telemetry: { enabled: false } })

    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.unknownExtension).toBe('keep me')
    expect(parsed.telemetry.enabled).toBe(false)
  })

  it('replaces scalar telemetry keys (not deep-merged)', () => {
    saveSparrowConfig({
      telemetry: { capturePrompts: 'full' },
    })
    saveSparrowConfig({
      telemetry: { capturePrompts: 'off' },
    })
    expect(loadSparrowConfig().telemetry?.capturePrompts).toBe('off')
  })
})

describe('resolveTelemetryConfig — precedence', () => {
  it('defaults when no file, no env, no args', () => {
    const r = resolveTelemetryConfig()
    expect(r.enabled).toBe(false)
    expect(r.apiKey).toBeUndefined()
    expect(r.dataset).toBe('sparrow-codebuff')
    expect(r.capturePrompts).toBe(false)
    expect(r.debug).toBe(false)
    expect(r.sources.apiKey).toBe('default')
    expect(r.sources.dataset).toBe('default')
    expect(r.sources.capturePrompts).toBe('default')
  })

  it('uses file values when no env/args are set', () => {
    saveSparrowConfig({
      telemetry: {
        enabled: true,
        honeycomb: { apiKey: 'file-key', dataset: 'file-dataset' },
        capturePrompts: 'full',
        debug: true,
      },
    })
    const r = resolveTelemetryConfig()
    expect(r.apiKey).toBe('file-key')
    expect(r.dataset).toBe('file-dataset')
    expect(r.capturePrompts).toBe(true)
    expect(r.debug).toBe(true)
    expect(r.sources.apiKey).toBe('file')
    expect(r.sources.dataset).toBe('file')
    expect(r.sources.capturePrompts).toBe('file')
    expect(r.sources.debug).toBe('file')
  })

  it('env vars override the config file', () => {
    saveSparrowConfig({
      telemetry: {
        enabled: true,
        honeycomb: { apiKey: 'file-key', dataset: 'file-dataset' },
        capturePrompts: 'off',
      },
    })
    process.env.HONEYCOMB_API_KEY = 'env-key'
    process.env.HONEYCOMB_DATASET = 'env-dataset'
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'full'

    const r = resolveTelemetryConfig()
    expect(r.apiKey).toBe('env-key')
    expect(r.dataset).toBe('env-dataset')
    expect(r.capturePrompts).toBe(true)
    expect(r.sources.apiKey).toBe('env')
    expect(r.sources.dataset).toBe('env')
    expect(r.sources.capturePrompts).toBe('env')
  })

  it('explicit args override env vars and file', () => {
    saveSparrowConfig({
      telemetry: { honeycomb: { apiKey: 'file-key' } },
    })
    process.env.HONEYCOMB_API_KEY = 'env-key'

    const r = resolveTelemetryConfig({ apiKey: 'arg-key' })
    expect(r.apiKey).toBe('arg-key')
    expect(r.sources.apiKey).toBe('arg')
  })

  it('empty/whitespace env values fall through to the file', () => {
    saveSparrowConfig({
      telemetry: { honeycomb: { apiKey: 'file-key' } },
    })
    process.env.HONEYCOMB_API_KEY = '   '

    const r = resolveTelemetryConfig()
    expect(r.apiKey).toBe('file-key')
    expect(r.sources.apiKey).toBe('file')
  })

  it('enabled derives from apiKey presence when not explicitly set', () => {
    process.env.HONEYCOMB_API_KEY = 'env-key'
    const r = resolveTelemetryConfig()
    expect(r.enabled).toBe(true)
  })

  it('explicit enabled:false overrides apiKey presence', () => {
    process.env.HONEYCOMB_API_KEY = 'env-key'
    saveSparrowConfig({ telemetry: { enabled: false } })
    const r = resolveTelemetryConfig()
    expect(r.enabled).toBe(false)
    expect(r.sources.enabled).toBe('file')
  })

  it('capturePrompts only accepts the literal string "full" (privacy-default)', () => {
    // Env var is case-sensitive and only matches exactly 'full'
    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'true'
    expect(resolveTelemetryConfig().capturePrompts).toBe(false)

    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'Full'
    expect(resolveTelemetryConfig().capturePrompts).toBe(false)

    process.env.SPARROW_TELEMETRY_CAPTURE_PROMPTS = 'full'
    expect(resolveTelemetryConfig().capturePrompts).toBe(true)
  })

  it('debug picks up DEBUG=sparrow:telemetry only', () => {
    process.env.DEBUG = 'something-else'
    expect(resolveTelemetryConfig().debug).toBe(false)

    process.env.DEBUG = 'foo,sparrow:telemetry,bar'
    expect(resolveTelemetryConfig().debug).toBe(true)
  })
})
