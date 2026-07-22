import z from 'zod/v4'

import type { $ToolParams } from '../../constants'

export const searchMcpToolsParams = {
  toolName: 'search_mcp_tools' as const,
  description: `Search for MCP tools by keyword and activate matching tools for use in subsequent steps.

Use this tool to find and load specific MCP tools (e.g. Sparrow CRM tools) without loading all 400+ tools at once. After calling this tool, the matching tools will be available as native tools in your next steps.

Examples:
- query: "company list" → finds tools for listing companies
- query: "investment create deal" → finds investment-related tools
- query: "person email" → finds tools for managing person emails`,
  inputSchema: z.object({
    query: z.string().describe('Keywords to search for in tool names and descriptions'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe('Maximum number of tools to activate (default: 20)'),
  }),
  outputSchema: z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
        activatedTools: z.array(z.string()).optional(),
        totalMcpTools: z.number().optional(),
      }),
    }),
  ]),
  endsAgentStep: false,
} satisfies $ToolParams<'search_mcp_tools'>
