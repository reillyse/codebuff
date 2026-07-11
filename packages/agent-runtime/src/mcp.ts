import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import { MCP_TOOL_SEPARATOR } from './mcp-constants'

import type { AgentTemplate } from './templates/types'
import type { RequestMcpToolDataFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { OptionalFields } from '@codebuff/common/types/function-params'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

export async function getMCPToolData(
  params: OptionalFields<
    {
      toolNames: AgentTemplate['toolNames']
      mcpServers: AgentTemplate['mcpServers']
      writeTo: ProjectFileContext['customToolDefinitions']
      requestMcpToolData: RequestMcpToolDataFn
      logger: Logger
    },
    'writeTo'
  >,
): Promise<CustomToolDefinitions> {
  const withDefaults = { writeTo: {}, ...params }
  const { toolNames, mcpServers, writeTo, requestMcpToolData, logger } =
    withDefaults

  // User-facing toolNames use '/' as separator (e.g., 'supabase/list_tables')
  // but internally we use MCP_TOOL_SEPARATOR ('__') for LLM API compatibility
  const USER_INPUT_SEPARATOR = '/'
  const requestedToolsByMcp: Record<string, string[] | undefined> = {}
  for (const t of toolNames) {
    if (!t.includes(USER_INPUT_SEPARATOR)) {
      continue
    }
    const [mcpName, ...remaining] = t.split(USER_INPUT_SEPARATOR)
    const toolName = remaining.join(USER_INPUT_SEPARATOR)
    if (!requestedToolsByMcp[mcpName]) {
      requestedToolsByMcp[mcpName] = []
    }
    requestedToolsByMcp[mcpName].push(toolName)
  }

  const promises: Promise<any>[] = []
  for (const [mcpName, mcpConfig] of Object.entries(mcpServers)) {
    promises.push(
      (async () => {
        try {
          const mcpData = await requestMcpToolData({
            mcpConfig,
            toolNames: requestedToolsByMcp[mcpName] ?? null,
          })

          for (const { name, description, inputSchema } of mcpData) {
            writeTo[mcpName + MCP_TOOL_SEPARATOR + name] = {
              inputSchema: convertJsonSchemaToZod(inputSchema as any) as any,
              endsAgentStep: true,
              description,
            }
          }
        } catch (error) {
          // Degrade gracefully: a single MCP server that fails to list tools
          // (e.g. an unauthenticated OAuth server inherited from the parent, or
          // a server that's temporarily down) must NOT break tool-def loading
          // for the whole agent. Skip that server's tools and continue; the
          // model simply won't see them, and any explicit call surfaces the
          // real error. This keeps subagents (which now inherit the parent's
          // mcpServers) resilient to a not-yet-connected server.
          logger.warn(
            {
              mcpServer: mcpName,
              error: error instanceof Error ? error.message : String(error),
            },
            `Failed to load MCP tools from server '${mcpName}'; skipping its tools`,
          )
        }
      })(),
    )
  }
  await Promise.all(promises)

  return writeTo
}
