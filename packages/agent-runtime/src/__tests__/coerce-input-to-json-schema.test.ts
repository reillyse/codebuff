import { describe, expect, it } from 'bun:test'

import { coerceInputToJsonSchema } from '../tools/tool-executor'

describe('coerceInputToJsonSchema', () => {
  it('coerces string-encoded integers to numbers', () => {
    const result = coerceInputToJsonSchema(
      { year: '2025', quarter: '2', limit: '10' },
      {
        type: 'object',
        properties: {
          year: { type: 'integer' },
          quarter: { type: 'integer' },
          limit: { type: 'number' },
        },
      },
    )
    expect(result).toEqual({ year: 2025, quarter: 2, limit: 10 })
  })

  it('coerces string-encoded booleans to booleans', () => {
    const result = coerceInputToJsonSchema(
      { core_only: 'true', include_archived: 'false' },
      {
        type: 'object',
        properties: {
          core_only: { type: 'boolean' },
          include_archived: { type: 'boolean' },
        },
      },
    )
    expect(result).toEqual({ core_only: true, include_archived: false })
  })

  it('coerces mixed-case boolean strings case-insensitively', () => {
    const result = coerceInputToJsonSchema(
      { a: 'True', b: 'False', c: 'TRUE', d: 'FALSE', e: 'TrUe' },
      {
        type: 'object',
        properties: {
          a: { type: 'boolean' },
          b: { type: 'boolean' },
          c: { type: 'boolean' },
          d: { type: 'boolean' },
          e: { type: 'boolean' },
        },
      },
    )
    expect(result).toEqual({ a: true, b: false, c: true, d: false, e: true })
  })

  it('coerces string-encoded JSON arrays', () => {
    const result = coerceInputToJsonSchema(
      { body_categories: '["investor_update","product_update"]' },
      {
        type: 'object',
        properties: {
          body_categories: { type: 'array' },
        },
      },
    )
    expect(result).toEqual({
      body_categories: ['investor_update', 'product_update'],
    })
  })

  it('coerces string-encoded JSON objects', () => {
    const result = coerceInputToJsonSchema(
      { filters: '{"status":"active"}' },
      {
        type: 'object',
        properties: {
          filters: { type: 'object' },
        },
      },
    )
    expect(result).toEqual({ filters: { status: 'active' } })
  })

  it('is idempotent — already-correct types are left untouched', () => {
    const result = coerceInputToJsonSchema(
      { year: 2025, core_only: true, items: ['a', 'b'] },
      {
        type: 'object',
        properties: {
          year: { type: 'integer' },
          core_only: { type: 'boolean' },
          items: { type: 'array' },
        },
      },
    )
    expect(result).toEqual({ year: 2025, core_only: true, items: ['a', 'b'] })
  })

  it('leaves string values alone for string-typed properties', () => {
    const result = coerceInputToJsonSchema(
      { name: 'Acme Corp', status: 'active' },
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string' },
        },
      },
    )
    expect(result).toEqual({ name: 'Acme Corp', status: 'active' })
  })

  it('handles the full observed failure scenario', () => {
    const result = coerceInputToJsonSchema(
      {
        year: '2025',
        quarter: '2',
        limit: '10',
        core_only: 'true',
        body_categories: '["investor_update"]',
      },
      {
        type: 'object',
        properties: {
          year: { type: 'integer' },
          quarter: { type: 'integer' },
          limit: { type: 'number' },
          core_only: { type: 'boolean' },
          body_categories: { type: 'array' },
        },
      },
    )
    expect(result).toEqual({
      year: 2025,
      quarter: 2,
      limit: 10,
      core_only: true,
      body_categories: ['investor_update'],
    })
  })

  it('does not coerce empty string to 0 for number fields', () => {
    const result = coerceInputToJsonSchema(
      { count: '' },
      {
        type: 'object',
        properties: { count: { type: 'integer' } },
      },
    )
    expect(result).toEqual({ count: '' })
  })

  it('does not coerce non-numeric string for number fields', () => {
    const result = coerceInputToJsonSchema(
      { year: 'not-a-number' },
      {
        type: 'object',
        properties: { year: { type: 'integer' } },
      },
    )
    expect(result).toEqual({ year: 'not-a-number' })
  })

  it('does not coerce invalid JSON string for array fields', () => {
    const result = coerceInputToJsonSchema(
      { tags: 'not-json' },
      {
        type: 'object',
        properties: { tags: { type: 'array' } },
      },
    )
    expect(result).toEqual({ tags: 'not-json' })
  })

  it('ignores properties not present in the schema', () => {
    const result = coerceInputToJsonSchema(
      { unknown_field: '123', known: '42' },
      {
        type: 'object',
        properties: { known: { type: 'integer' } },
      },
    )
    expect(result).toEqual({ unknown_field: '123', known: 42 })
  })

  it('handles schema with no properties gracefully', () => {
    const result = coerceInputToJsonSchema(
      { value: '123' },
      { type: 'object' },
    )
    expect(result).toEqual({ value: '123' })
  })

  it('handles union types as array (e.g. ["integer", "null"])', () => {
    const result = coerceInputToJsonSchema(
      { count: '5' },
      {
        type: 'object',
        properties: { count: { type: ['integer', 'null'] } },
      },
    )
    expect(result).toEqual({ count: 5 })
  })

  // ── Nested / recursive coercion ──────────────────────────────────────────────

  it('recursively coerces properties of a nested object', () => {
    const result = coerceInputToJsonSchema(
      {
        metadata: { year: '2025', active: 'true' },
      },
      {
        type: 'object',
        properties: {
          metadata: {
            type: 'object',
            properties: {
              year: { type: 'integer' },
              active: { type: 'boolean' },
            },
          },
        },
      },
    )
    expect(result).toEqual({ metadata: { year: 2025, active: true } })
  })

  it('coerces a string-encoded object then recursively coerces its properties', () => {
    const result = coerceInputToJsonSchema(
      {
        filter: '{"limit":"10","include_archived":"false"}',
      },
      {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: {
              limit: { type: 'integer' },
              include_archived: { type: 'boolean' },
            },
          },
        },
      },
    )
    expect(result).toEqual({ filter: { limit: 10, include_archived: false } })
  })

  it('coerces items in an already-parsed array using the items schema', () => {
    const result = coerceInputToJsonSchema(
      { scores: ['1', '2', '3'] },
      {
        type: 'object',
        properties: {
          scores: {
            type: 'array',
            items: { type: 'integer' },
          },
        },
      },
    )
    expect(result).toEqual({ scores: [1, 2, 3] })
  })

  it('coerces items in a string-encoded array using the items schema', () => {
    const result = coerceInputToJsonSchema(
      { flags: '["true","false","true"]' },
      {
        type: 'object',
        properties: {
          flags: {
            type: 'array',
            items: { type: 'boolean' },
          },
        },
      },
    )
    expect(result).toEqual({ flags: [true, false, true] })
  })

  it('coerces object items within an array', () => {
    const result = coerceInputToJsonSchema(
      {
        people: [
          { name: 'Alice', age: '30' },
          { name: 'Bob', age: '25' },
        ],
      },
      {
        type: 'object',
        properties: {
          people: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'integer' },
              },
            },
          },
        },
      },
    )
    expect(result).toEqual({
      people: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    })
  })

  it('coerces deeply nested structures', () => {
    const result = coerceInputToJsonSchema(
      {
        config: {
          pagination: { page: '1', per_page: '50' },
          enabled: 'true',
        },
      },
      {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer' },
                  per_page: { type: 'integer' },
                },
              },
              enabled: { type: 'boolean' },
            },
          },
        },
      },
    )
    expect(result).toEqual({
      config: {
        pagination: { page: 1, per_page: 50 },
        enabled: true,
      },
    })
  })

  it('leaves array items without an items schema untouched', () => {
    const result = coerceInputToJsonSchema(
      { tags: ['foo', 'bar'] },
      {
        type: 'object',
        properties: {
          tags: { type: 'array' },
        },
      },
    )
    expect(result).toEqual({ tags: ['foo', 'bar'] })
  })

  // ── anyOf / oneOf / allOf composition keywords ────────────────────────────────

  it('coerces a string-encoded integer via anyOf nullable pattern', () => {
    const result = coerceInputToJsonSchema(
      { count: '5' },
      {
        type: 'object',
        properties: {
          count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ count: 5 })
  })

  it('leaves null untouched with anyOf nullable integer pattern', () => {
    const result = coerceInputToJsonSchema(
      { count: null },
      {
        type: 'object',
        properties: {
          count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ count: null })
  })

  it('leaves already-typed number untouched with anyOf', () => {
    const result = coerceInputToJsonSchema(
      { count: 42 },
      {
        type: 'object',
        properties: {
          count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ count: 42 })
  })

  it('coerces a string-encoded boolean via anyOf nullable pattern', () => {
    const result = coerceInputToJsonSchema(
      { active: 'true' },
      {
        type: 'object',
        properties: {
          active: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ active: true })
  })

  it('leaves a plain string untouched for anyOf string|null', () => {
    const result = coerceInputToJsonSchema(
      { name: 'Alice' },
      {
        type: 'object',
        properties: {
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ name: 'Alice' })
  })

  it('coerces via oneOf identically to anyOf', () => {
    const result = coerceInputToJsonSchema(
      { year: '2025' },
      {
        type: 'object',
        properties: {
          year: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ year: 2025 })
  })

  it('coerces via allOf by applying sub-schemas sequentially', () => {
    // allOf is uncommon for primitive coercion but should pass values through
    const result = coerceInputToJsonSchema(
      { limit: '10' },
      {
        type: 'object',
        properties: {
          limit: { allOf: [{ type: 'integer' }] },
        },
      },
    )
    expect(result).toEqual({ limit: 10 })
  })

  it('coerces anyOf nested inside array items', () => {
    const result = coerceInputToJsonSchema(
      { ids: ['1', '2', '3'] },
      {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
      },
    )
    expect(result).toEqual({ ids: [1, 2, 3] })
  })

  it('handles the full observed failure scenario with anyOf schema', () => {
    // Mirrors the real Sparrow MCP schema pattern where fields are nullable
    const result = coerceInputToJsonSchema(
      { year: '2025', quarter: '2', active: 'true' },
      {
        type: 'object',
        properties: {
          year: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          quarter: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          active: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        },
      },
    )
    expect(result).toEqual({ year: 2025, quarter: 2, active: true })
  })
})
