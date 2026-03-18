import { describe, expect, it } from 'bun:test'

import {
  generateHippoSessionId,
  resetHippoEnabledCache,
  resetHippoSessionState,
} from '../hippo-hooks'

import type { AgentMode } from '../constants'

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
