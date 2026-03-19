import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  generateHippoSessionId,
  HIPPO_BINARY,
  resetHippoEnabledCache,
  resetHippoSessionState,
  resolveHippoBinary,
} from '../hippo-hooks'

import type { AgentMode } from '../constants'

describe('resolveHippoBinary', () => {
  let originalHippoPath: string | undefined
  let originalPath: string | undefined

  beforeEach(() => {
    originalHippoPath = process.env.HIPPO_PATH
    originalPath = process.env.PATH
  })

  afterEach(() => {
    if (originalHippoPath !== undefined) {
      process.env.HIPPO_PATH = originalHippoPath
    } else {
      delete process.env.HIPPO_PATH
    }
    if (originalPath !== undefined) {
      process.env.PATH = originalPath
    } else {
      delete process.env.PATH
    }
  })

  it('should return HIPPO_PATH when env var is set', () => {
    process.env.HIPPO_PATH = '/custom/path/to/hippo'
    expect(resolveHippoBinary()).toBe('/custom/path/to/hippo')
  })

  it('should return a non-empty string when HIPPO_PATH is not set', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('should find hippo via PATH or fall back to dev path when HIPPO_PATH is not set', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    const devFallback = path.join(os.homedir(), 'Programming/hippo/build/hippo')
    // Result is either a PATH-resolved binary or the dev fallback
    expect(result === devFallback || result.endsWith('/hippo')).toBe(true)
  })

  it('should always return a path ending with hippo', () => {
    delete process.env.HIPPO_PATH
    const result = resolveHippoBinary()
    expect(result).toMatch(/hippo$/)
  })

  it('dev fallback path should be under home directory', () => {
    // Verify the dev fallback path format is correct
    const devFallback = path.join(os.homedir(), 'Programming/hippo/build/hippo')
    expect(devFallback).toContain(os.homedir())
    expect(devFallback).toMatch(/Programming\/hippo\/build\/hippo$/)
  })
})

describe('HIPPO_BINARY', () => {
  it('should be a non-empty string', () => {
    expect(typeof HIPPO_BINARY).toBe('string')
    expect(HIPPO_BINARY.length).toBeGreaterThan(0)
  })

  it('should end with hippo', () => {
    expect(HIPPO_BINARY).toMatch(/hippo$/)
  })
})

describe('resetHippoSessionState', () => {
  it('should not throw when called', () => {
    expect(() => resetHippoSessionState()).not.toThrow()
  })

  it('should be safe to call multiple times', () => {
    resetHippoSessionState()
    resetHippoSessionState()
    resetHippoSessionState()
  })
})

describe('resetHippoEnabledCache', () => {
  it('should not throw when called', () => {
    expect(() => resetHippoEnabledCache()).not.toThrow()
  })
})

describe('generateHippoSessionId', () => {
  it('should return a string starting with codebuff-', () => {
    const id = generateHippoSessionId('DEFAULT' as AgentMode)
    expect(id).toMatch(/^codebuff-/)
  })

  it('should include the lowercased agent mode', () => {
    const id = generateHippoSessionId('MAX' as AgentMode)
    expect(id).toContain('-max-')
  })

  it('should include a date component', () => {
    const id = generateHippoSessionId('DEFAULT' as AgentMode)
    // Should match pattern: codebuff-default-YYYY-MM-DD-HHmm
    expect(id).toMatch(/^codebuff-default-\d{4}-\d{2}-\d{2}-\d{4}$/)
  })

  it('should return different IDs for different modes', () => {
    const defaultId = generateHippoSessionId('DEFAULT' as AgentMode)
    const maxId = generateHippoSessionId('MAX' as AgentMode)
    expect(defaultId).not.toBe(maxId)
  })
})
