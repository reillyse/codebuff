import { describe, expect, it } from 'bun:test'

import { normalizeTopLevelUnionSchema } from '../prompts'

describe('normalizeTopLevelUnionSchema', () => {
  // Anthropic: "input_schema does not support oneOf, allOf, or anyOf at the top
  // level". MCP schemas are registered verbatim, so one bad third-party tool
  // 400s every request for the whole session — and the 400 arrives after the
  // stream opens, so it surfaces as an opaque AI_NoOutputGeneratedError.
  it('collapses a top-level anyOf into a single object schema', () => {
    const out = normalizeTopLevelUnionSchema({
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      ],
    })
    expect(out.anyOf).toBeUndefined()
    expect(out.type).toBe('object')
    expect(Object.keys(out.properties as object).sort()).toEqual(['id', 'slug'])
  })

  it('does not mark a field required when only one anyOf branch needs it', () => {
    const out = normalizeTopLevelUnionSchema({
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      ],
    })
    // Either branch alone satisfies the union, so neither field is required
    // overall. Marking both required would reject every valid call.
    expect(out.required).toBeUndefined()
  })

  it('keeps a field required when every anyOf branch requires it', () => {
    const out = normalizeTopLevelUnionSchema({
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' }, a: {} },
          required: ['id'],
        },
        {
          type: 'object',
          properties: { id: { type: 'string' }, b: {} },
          required: ['id'],
        },
      ],
    })
    expect(out.required).toEqual(['id'])
  })

  it('unions required across allOf branches, which must all hold', () => {
    const out = normalizeTopLevelUnionSchema({
      allOf: [
        { type: 'object', properties: { a: {} }, required: ['a'] },
        { type: 'object', properties: { b: {} }, required: ['b'] },
      ],
    })
    expect(out.allOf).toBeUndefined()
    expect((out.required as string[]).sort()).toEqual(['a', 'b'])
  })

  it('handles oneOf the same way as anyOf', () => {
    const out = normalizeTopLevelUnionSchema({
      oneOf: [{ type: 'object', properties: { x: {} } }],
    })
    expect(out.oneOf).toBeUndefined()
    expect(out.type).toBe('object')
  })

  it('forces a top-level object type even without a union', () => {
    expect(normalizeTopLevelUnionSchema({ properties: {} }).type).toBe('object')
  })

  it('leaves an already-valid object schema untouched', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }
    expect(normalizeTopLevelUnionSchema(schema)).toEqual(schema)
  })

  it('leaves NESTED unions alone — only the top level is rejected', () => {
    const out = normalizeTopLevelUnionSchema({
      type: 'object',
      properties: { mode: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    })
    expect((out.properties as Record<string, any>).mode.anyOf).toHaveLength(2)
  })

  it('never emits a required entry with no matching property', () => {
    const out = normalizeTopLevelUnionSchema({
      anyOf: [
        { type: 'object', required: ['ghost'] },
        { type: 'object', required: ['ghost'] },
      ],
    })
    expect(out.required).toBeUndefined()
  })
})
