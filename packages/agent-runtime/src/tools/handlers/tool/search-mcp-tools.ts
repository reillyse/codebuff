import { jsonToolResult } from '@codebuff/common/util/messages'

import { MCP_TOOL_SEPARATOR } from '../../../mcp-constants'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'

type ToolName = 'search_mcp_tools'

export const handleSearchMcpTools: CodebuffToolHandlerFunction<ToolName> = async (params) => {
  const { previousToolCallFinished, toolCall, fileContext } = params

  await previousToolCallFinished

  const { query, limit = 20 } = toolCall.input
  const queryLower = query.toLowerCase()

  // Search through all loaded MCP tools (those with the MCP separator)
  const allMcpTools = Object.entries(fileContext.customToolDefinitions).filter(
    ([name]) => name.includes(MCP_TOOL_SEPARATOR),
  )

  if (allMcpTools.length === 0) {
    return {
      output: jsonToolResult({
        message:
          'No MCP tools are currently loaded. Make sure MCP servers are configured and connected.',
        activatedTools: [],
      }),
    }
  }

  // Score tools by relevance to query
  const queryTerms = queryLower.split(/\s+/).filter(Boolean)
  const scored = allMcpTools
    .map(([name, def]) => {
      const nameLower = name.toLowerCase()
      const descLower = (def.description ?? '').toLowerCase()

      let score = 0
      for (const term of queryTerms) {
        if (nameLower.includes(term)) score += 3
        if (descLower.includes(term)) score += 1
      }
      return { name, def, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const selectedNames = scored.map(({ name }) => name)

  // Activate the selected tools for subsequent steps
  fileContext.activeMcpToolNames = selectedNames

  if (selectedNames.length === 0) {
    return {
      output: jsonToolResult({
        message: `No MCP tools found matching "${query}". Try different keywords. Available MCP tools can be found by searching with broader terms.`,
        activatedTools: [],
        totalMcpTools: allMcpTools.length,
      }),
    }
  }

  const toolList = scored.map(({ name, def }) => {
    // Extract server name and tool name from the combined key (e.g. "sparrow__companies_list")
    const separatorIdx = name.indexOf(MCP_TOOL_SEPARATOR)
    const serverName = name.slice(0, separatorIdx)
    const toolName = name.slice(separatorIdx + MCP_TOOL_SEPARATOR.length)
    const desc = (def.description ?? '').slice(0, 120)
    return `- ${serverName}/${toolName}: ${desc}`
  })

  return {
    output: jsonToolResult({
      message: `Activated ${selectedNames.length} MCP tool(s) matching "${query}". These tools are now available in your next steps:`,
      activatedTools: toolList,
    }),
  }
}
