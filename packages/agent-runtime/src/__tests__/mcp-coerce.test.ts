import { describe, expect, it } from 'bun:test'

import { coerceInputToJsonSchema } from '../mcp-coerce'

describe('coerceInputToJsonSchema', () => {
  it('coerces the reported year/quarter/limit string bug into numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        quarter: { type: 'integer' },
        limit: { type: 'number' },
      },
      required: ['year', 'quarter'],
    }
    const result = coerceInputToJsonSchema(
      { year: '2026', quarter: '2', limit: '5' },
      schema,
    )
    expect(result).toEqual({ year: 2026, quarter: 2, limit: 5 })
  })

  it('leaves already-numeric values unchanged', () => {
    const schema = {
      type: 'object',
      properties: { year: { type: 'integer' } },
    }
    expect(coerceInputToJsonSchema({ year: 2026 }, schema)).toEqual({
      year: 2026,
    })
  })

  it('does NOT coerce a non-numeric string for a number field (still invalid)', () => {
    const schema = {
      type: 'object',
      properties: { year: { type: 'integer' } },
    }
    // Left as a string so downstream Zod / server validation still rejects it.
    expect(coerceInputToJsonSchema({ year: 'not-a-year' }, schema)).toEqual({
      year: 'not-a-year',
    })
  })

  it('does NOT coerce a fractional string for an integer field', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
    }
    expect(coerceInputToJsonSchema({ count: '2.5' }, schema)).toEqual({
      count: '2.5',
    })
  })

  it('coerces a fractional string for a number field', () => {
    const schema = {
      type: 'object',
      properties: { rate: { type: 'number' } },
    }
    expect(coerceInputToJsonSchema({ rate: '3.14' }, schema)).toEqual({
      rate: 3.14,
    })
  })

  it('coerces boolean strings', () => {
    const schema = {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        archived: { type: 'boolean' },
        keep: { type: 'boolean' },
      },
    }
    expect(
      coerceInputToJsonSchema(
        { active: 'true', archived: 'FALSE', keep: 'maybe' },
        schema,
      ),
    ).toEqual({ active: true, archived: false, keep: 'maybe' })
  })

  it('leaves string fields untouched', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    }
    expect(coerceInputToJsonSchema({ name: '2026' }, schema)).toEqual({
      name: '2026',
    })
  })

  it('coerces items inside arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        years: { type: 'array', items: { type: 'integer' } },
      },
    }
    expect(
      coerceInputToJsonSchema({ years: ['2024', '2025', '2026'] }, schema),
    ).toEqual({ years: [2024, 2025, 2026] })
  })

  it('coerces nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
    }
    expect(
      coerceInputToJsonSchema({ filter: { year: '2026' } }, schema),
    ).toEqual({ filter: { year: 2026 } })
  })

  it('coerces union types like ["integer", "null"]', () => {
    const schema = {
      type: 'object',
      properties: { limit: { type: ['integer', 'null'] } },
    }
    expect(coerceInputToJsonSchema({ limit: '10' }, schema)).toEqual({
      limit: 10,
    })
  })

  it('resolves $ref against $defs (Pydantic/FastMCP style)', () => {
    const schema = {
      $defs: {
        Period: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
      type: 'object',
      properties: { period: { $ref: '#/$defs/Period' } },
    }
    expect(
      coerceInputToJsonSchema({ period: { year: '2026' } }, schema),
    ).toEqual({ period: { year: 2026 } })
  })

  it('coerces BOTH sibling properties that reuse the same $ref', () => {
    // Regression: a shared cycle-guard set would coerce the first sibling and
    // silently skip the second. Each sibling must be coerced independently.
    const schema = {
      $defs: {
        Period: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
      type: 'object',
      properties: {
        start: { $ref: '#/$defs/Period' },
        end: { $ref: '#/$defs/Period' },
      },
    }
    expect(
      coerceInputToJsonSchema(
        { start: { year: '2024' }, end: { year: '2026' } },
        schema,
      ),
    ).toEqual({ start: { year: 2024 }, end: { year: 2026 } })
  })

  it('unwraps a single-element array into an object when the schema expects an object (lp_update bug)', () => {
    const schema = {
      type: 'object',
      properties: {
        lp_update: {
          type: 'object',
          properties: { title: { type: 'string' }, year: { type: 'integer' } },
        },
      },
    }
    // LLM wrapped the object in a one-element array; unwrap AND coerce inner year.
    expect(
      coerceInputToJsonSchema(
        { lp_update: [{ title: 'Q2', year: '2026' }] },
        schema,
      ),
    ).toEqual({ lp_update: { title: 'Q2', year: 2026 } })
  })

  it('unwraps a single-element array for an anyOf object-or-null (Pydantic Optional) field', () => {
    const schema = {
      type: 'object',
      properties: {
        lp_update: {
          anyOf: [
            { type: 'object', properties: { year: { type: 'integer' } } },
            { type: 'null' },
          ],
        },
      },
    }
    expect(
      coerceInputToJsonSchema({ lp_update: [{ year: '2026' }] }, schema),
    ).toEqual({ lp_update: { year: 2026 } })
  })

  it('unwraps a single-element array for a $ref object field', () => {
    const schema = {
      $defs: {
        LpUpdate: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
      type: 'object',
      properties: { lp_update: { $ref: '#/$defs/LpUpdate' } },
    }
    expect(
      coerceInputToJsonSchema({ lp_update: [{ year: '2026' }] }, schema),
    ).toEqual({ lp_update: { year: 2026 } })
  })

  it('does NOT unwrap when the schema expects an array', () => {
    const schema = {
      type: 'object',
      properties: {
        replacements: {
          type: 'array',
          items: { type: 'object', properties: { old: { type: 'string' } } },
        },
      },
    }
    // A legitimate one-element array for an array field must stay an array.
    expect(
      coerceInputToJsonSchema({ replacements: [{ old: 'x' }] }, schema),
    ).toEqual({ replacements: [{ old: 'x' }] })
  })

  it('does NOT unwrap when a schema branch permits an array (object-or-array union)', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
    }
    // Ambiguous: schema accepts arrays too, so respect the array.
    expect(coerceInputToJsonSchema({ value: [{ a: 'x' }] }, schema)).toEqual({
      value: [{ a: 'x' }],
    })
  })

  it('does NOT unwrap a multi-element array for an object field', () => {
    const schema = {
      type: 'object',
      properties: {
        lp_update: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
    }
    // Two elements can't be deterministically unwrapped — leave as-is.
    expect(
      coerceInputToJsonSchema(
        { lp_update: [{ year: '2024' }, { year: '2026' }] },
        schema,
      ),
    ).toEqual({ lp_update: [{ year: '2024' }, { year: '2026' }] })
  })

  it('does NOT unwrap an empty array for an object field', () => {
    const schema = {
      type: 'object',
      properties: {
        lp_update: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
    }
    expect(coerceInputToJsonSchema({ lp_update: [] }, schema)).toEqual({
      lp_update: [],
    })
  })

  it('does NOT unwrap a single-element array of a non-object (primitive)', () => {
    const schema = {
      type: 'object',
      properties: {
        lp_update: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
      },
    }
    expect(coerceInputToJsonSchema({ lp_update: ['x'] }, schema)).toEqual({
      lp_update: ['x'],
    })
  })

  it('unwraps a single-element array for a genuinely uninformative ({}) node (synthesis subagent bug)', () => {
    // Pydantic `Any` / freeform-JSON field arrives as `{}` (no type/properties).
    // The LLM wrapped the object in a one-element array; the blind-unwrap
    // defense-in-depth rescues it even though the node describes no shape.
    const schema = {
      type: 'object',
      properties: {
        synthesis: {},
        metrics_snapshot: {},
      },
    }
    expect(
      coerceInputToJsonSchema(
        {
          synthesis: [{ health: 'healthy', trend: 'stable' }],
          metrics_snapshot: [{ cash: 15_880_000 }],
        },
        schema,
      ),
    ).toEqual({
      synthesis: { health: 'healthy', trend: 'stable' },
      metrics_snapshot: { cash: 15_880_000 },
    })
  })

  it('does NOT blind-unwrap a genuinely uninformative node when the value is a multi-element array', () => {
    const schema = {
      type: 'object',
      properties: { metrics_snapshot: {} },
    }
    // 18 metric records can't be deterministically unwrapped — leave as-is.
    expect(
      coerceInputToJsonSchema(
        { metrics_snapshot: [{ a: 1 }, { b: 2 }] },
        schema,
      ),
    ).toEqual({ metrics_snapshot: [{ a: 1 }, { b: 2 }] })
  })

  it('does NOT blind-unwrap when the uninformative-looking node actually declares items (array)', () => {
    // `items` present => node permits an array => never unwrap, even without `type`.
    const schema = {
      type: 'object',
      properties: {
        records: { items: { type: 'object', properties: { a: { type: 'string' } } } },
      },
    }
    expect(
      coerceInputToJsonSchema({ records: [{ a: 'x' }] }, schema),
    ).toEqual({ records: [{ a: 'x' }] })
  })

  it('does NOT blind-unwrap a single-element array of a non-object for a {} node', () => {
    const schema = {
      type: 'object',
      properties: { synthesis: {} },
    }
    // Element is a primitive, not an object — leave the array untouched.
    expect(coerceInputToJsonSchema({ synthesis: ['x'] }, schema)).toEqual({
      synthesis: ['x'],
    })
  })

  it('wraps a bare string into a single-element array (body_categories bug)', () => {
    const schema = {
      type: 'object',
      properties: {
        body_categories: { type: 'array', items: { type: 'string' } },
      },
    }
    expect(
      coerceInputToJsonSchema({ body_categories: 'foo' }, schema),
    ).toEqual({ body_categories: ['foo'] })
  })

  it('wraps AND coerces a bare numeric string for an integer array', () => {
    const schema = {
      type: 'object',
      properties: { years: { type: 'array', items: { type: 'integer' } } },
    }
    expect(coerceInputToJsonSchema({ years: '2026' }, schema)).toEqual({
      years: [2026],
    })
  })

  it('parses a bracketed JSON-array string and coerces its items', () => {
    const schema = {
      type: 'object',
      properties: { years: { type: 'array', items: { type: 'integer' } } },
    }
    expect(
      coerceInputToJsonSchema({ years: '["2024", "2026"]' }, schema),
    ).toEqual({ years: [2024, 2026] })
  })

  it('parses a bracketed JSON-array string of strings', () => {
    const schema = {
      type: 'object',
      properties: {
        email_sources: { type: 'array', items: { type: 'string' } },
      },
    }
    expect(
      coerceInputToJsonSchema({ email_sources: '["a", "b"]' }, schema),
    ).toEqual({ email_sources: ['a', 'b'] })
  })

  it('wraps a bare string for an anyOf array-or-null (Pydantic Optional[List]) field', () => {
    const schema = {
      type: 'object',
      properties: {
        email_sources: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
        },
      },
    }
    expect(
      coerceInputToJsonSchema({ email_sources: 'foo' }, schema),
    ).toEqual({ email_sources: ['foo'] })
  })

  it('leaves null unchanged for an anyOf array-or-null field', () => {
    const schema = {
      type: 'object',
      properties: {
        email_sources: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
        },
      },
    }
    expect(
      coerceInputToJsonSchema({ email_sources: null }, schema),
    ).toEqual({ email_sources: null })
  })

  it('does NOT wrap when a schema branch accepts the string directly (string-or-array union)', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
    }
    // A bare string is legitimately valid — respect it, don't wrap.
    expect(coerceInputToJsonSchema({ value: 'foo' }, schema)).toEqual({
      value: 'foo',
    })
  })

  it('resolves an ambiguous scalar to the scalar branch, not a wrapped array (int-or-int-array union)', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }],
        },
      },
    }
    // "5" coerces to the integer 5 via the composite loop, NOT [5].
    expect(coerceInputToJsonSchema({ value: '5' }, schema)).toEqual({
      value: 5,
    })
  })

  it('wraps a bare object into a single-element array for an array-of-objects field', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { year: { type: 'integer' } },
          },
        },
      },
    }
    // Wrap AND coerce the inner year.
    expect(
      coerceInputToJsonSchema({ items: { year: '2026' } }, schema),
    ).toEqual({ items: [{ year: 2026 }] })
  })

  it('wraps a bare string for a $ref array field', () => {
    const schema = {
      $defs: {
        Tags: { type: 'array', items: { type: 'string' } },
      },
      type: 'object',
      properties: { tags: { $ref: '#/$defs/Tags' } },
    }
    expect(coerceInputToJsonSchema({ tags: 'foo' }, schema)).toEqual({
      tags: ['foo'],
    })
  })

  it('leaves an already-correct array unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        body_categories: { type: 'array', items: { type: 'string' } },
      },
    }
    expect(
      coerceInputToJsonSchema({ body_categories: ['a', 'b'] }, schema),
    ).toEqual({ body_categories: ['a', 'b'] })
  })

  it('resolves anyOf branches (e.g. optional number)', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    }
    expect(coerceInputToJsonSchema({ limit: '25' }, schema)).toEqual({
      limit: 25,
    })
  })

  it('does not infinite-loop on a cyclic $ref schema', () => {
    const schema = {
      $defs: {
        Node: {
          type: 'object',
          properties: {
            value: { type: 'integer' },
            next: { $ref: '#/$defs/Node' },
          },
        },
      },
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' } },
    }
    // Should terminate and coerce the first level without hanging.
    const result = coerceInputToJsonSchema(
      { root: { value: '1', next: { value: '2' } } },
      schema,
    )
    expect((result as any).root.value).toBe(1)
  })

  it('returns the value unchanged when the schema is not an object', () => {
    expect(coerceInputToJsonSchema({ year: '2026' }, null)).toEqual({
      year: '2026',
    })
    expect(coerceInputToJsonSchema('x', undefined)).toBe('x')
  })

  it('handles missing properties gracefully', () => {
    const schema = {
      type: 'object',
      properties: { year: { type: 'integer' }, quarter: { type: 'integer' } },
    }
    // Only `year` present — quarter absent should not be invented.
    expect(coerceInputToJsonSchema({ year: '2026' }, schema)).toEqual({
      year: 2026,
    })
  })
})
