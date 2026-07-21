import { describe, expect, it } from 'bun:test'

import { classifyToolListDegradation } from '../client'

describe('classifyToolListDegradation', () => {
  it('flags a tool with empty properties but declared required fields as self-contradictory', () => {
    // The exact fingerprint of a parameter-stripped, under-authenticated
    // response (e.g. sparrow_companies_get losing its company_id param).
    const tools = [
      {
        inputSchema: {
          type: 'object',
          properties: {},
          required: ['company_id'],
        },
      },
    ]
    expect(classifyToolListDegradation(tools)).toBe('self-contradictory')
  })

  it('flags a MIXED list where only one tool is self-contradictory', () => {
    const tools = [
      {
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      {
        // This one came back stripped.
        inputSchema: {
          type: 'object',
          properties: {},
          required: ['fund_id'],
        },
      },
    ]
    expect(classifyToolListDegradation(tools)).toBe('self-contradictory')
  })

  it('classifies an all-empty-properties list with NO required fields as all-degraded', () => {
    const tools = [
      { inputSchema: { type: 'object', properties: {} } },
      { inputSchema: { type: 'object', properties: {} } },
    ]
    expect(classifyToolListDegradation(tools)).toBe('all-degraded')
  })

  it('treats missing properties (undefined) the same as empty properties', () => {
    const tools = [{ inputSchema: { type: 'object', properties: undefined } }]
    expect(classifyToolListDegradation(tools)).toBe('all-degraded')
  })

  it('returns none for a healthy list with populated properties', () => {
    const tools = [
      {
        inputSchema: {
          type: 'object',
          properties: { company_id: { type: 'string' } },
          required: ['company_id'],
        },
      },
      {
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' } },
        },
      },
    ]
    expect(classifyToolListDegradation(tools)).toBe('none')
  })

  it('self-contradictory takes precedence over all-degraded', () => {
    // Every tool has empty properties, but one declares required — the
    // self-contradictory signal is the stronger (unambiguous) one, so we must
    // report it (and hard-error) rather than the milder all-degraded.
    const tools = [
      { inputSchema: { type: 'object', properties: {} } },
      { inputSchema: { type: 'object', properties: {}, required: ['x'] } },
    ]
    expect(classifyToolListDegradation(tools)).toBe('self-contradictory')
  })

  it('returns none for an empty tool list (nothing to judge)', () => {
    expect(classifyToolListDegradation([])).toBe('none')
  })

  it('does not flag a healthy zero-param tool mixed with real tools', () => {
    const tools = [
      { inputSchema: { type: 'object', properties: {} } }, // legit zero-param
      {
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
      },
    ]
    // Not ALL are degraded, and none is self-contradictory → healthy.
    expect(classifyToolListDegradation(tools)).toBe('none')
  })
})
