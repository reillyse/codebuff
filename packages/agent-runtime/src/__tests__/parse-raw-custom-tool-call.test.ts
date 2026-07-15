import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { MCP_TOOL_SEPARATOR } from '../mcp-constants'
import { parseRawCustomToolCall } from '../tools/tool-executor'

import type { CustomToolDefinitions } from '@codebuff/common/util/file'

// Helper to build a minimal MCP tool name as the real code does
const mcpTool = (name: string) => `sparrow${MCP_TOOL_SEPARATOR}${name}`

describe('parseRawCustomToolCall with rawInputSchema', () => {
  it('coerces string-encoded values to correct types before Zod validation', () => {
    // This is the core integration test: the Zod schema is strict (z.number(), z.boolean()),
    // which would REJECT string values. The fact that the result succeeds proves that
    // coerceInputToJsonSchema fires BEFORE safeParse, not after.
    const toolName = mcpTool('list_companies')
    const customToolDefs: CustomToolDefinitions = {
      [toolName]: {
        inputSchema: z.object({
          year: z.number(),
          active: z.boolean(),
          limit: z.number(),
        }),
        rawInputSchema: {
          type: 'object',
          properties: {
            year: { type: 'integer' },
            active: { type: 'boolean' },
            limit: { type: 'number' },
          },
        },
        endsAgentStep: false,
      },
    }

    const result = parseRawCustomToolCall({
      customToolDefs,
      rawToolCall: {
        toolName,
        toolCallId: 'test-call-1',
        input: { year: '2025', active: 'true', limit: '10' },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ year: 2025, active: true, limit: 10 })
      expect(result.toolName).toBe(toolName)
      expect(result.toolCallId).toBe('test-call-1')
    }
  })

  it('returns a ToolCallError when values cannot be coerced to the declared type', () => {
    const toolName = mcpTool('get_report')
    const customToolDefs: CustomToolDefinitions = {
      [toolName]: {
        inputSchema: z.object({ year: z.number() }),
        rawInputSchema: {
          type: 'object',
          properties: { year: { type: 'integer' } },
        },
        endsAgentStep: false,
      },
    }

    const result = parseRawCustomToolCall({
      customToolDefs,
      rawToolCall: {
        toolName,
        toolCallId: 'test-call-2',
        // 'not-a-number' cannot be coerced to integer → stays as string → Zod rejects it
        input: { year: 'not-a-number' },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toMatch(/Invalid parameters/)
    }
  })

  it('handles already-typed values idempotently', () => {
    const toolName = mcpTool('get_company')
    const customToolDefs: CustomToolDefinitions = {
      [toolName]: {
        inputSchema: z.object({ id: z.number(), active: z.boolean() }),
        rawInputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            active: { type: 'boolean' },
          },
        },
        endsAgentStep: false,
      },
    }

    const result = parseRawCustomToolCall({
      customToolDefs,
      rawToolCall: {
        toolName,
        toolCallId: 'test-call-3',
        input: { id: 42, active: true }, // already correct types
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ id: 42, active: true })
    }
  })

  it('coerces string-encoded array before Zod validation', () => {
    const toolName = mcpTool('filter_companies')
    const customToolDefs: CustomToolDefinitions = {
      [toolName]: {
        inputSchema: z.object({ categories: z.array(z.string()) }),
        rawInputSchema: {
          type: 'object',
          properties: { categories: { type: 'array' } },
        },
        endsAgentStep: false,
      },
    }

    const result = parseRawCustomToolCall({
      customToolDefs,
      rawToolCall: {
        toolName,
        toolCallId: 'test-call-4',
        input: { categories: '["investor_update","product_update"]' },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ categories: ['investor_update', 'product_update'] })
    }
  })

  it('skips coercion when rawInputSchema is absent (SDK custom tools)', () => {
    const toolName = 'my_custom_tool'
    const customToolDefs: CustomToolDefinitions = {
      [toolName]: {
        // No rawInputSchema — behaves like an SDK custom tool
        inputSchema: z.object({ name: z.string() }),
        endsAgentStep: false,
      },
    }

    const result = parseRawCustomToolCall({
      customToolDefs,
      rawToolCall: {
        toolName,
        toolCallId: 'test-call-5',
        input: { name: 'Acme Corp' },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ name: 'Acme Corp' })
    }
  })
})
