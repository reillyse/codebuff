import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
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
): Promise<{
  customToolDefinitions: CustomToolDefinitions
  mcpLoadErrors: string[]
}> {
  const withDefaults = { writeTo: {}, ...params }
  const { toolNames, mcpServers, writeTo, requestMcpToolData, logger } =
    withDefaults

  // Human-readable reasons for each MCP server that failed to load its tools.
  // These are surfaced to the model (see run-agent-step.ts) so subagents can
  // explain WHY certain tools are missing instead of silently omitting them.
  const mcpLoadErrors: string[] = []

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
  // `mcpServers` is typed as non-optional, but some runtime templates can have
  // it undefined; guard so tool-def loading never crashes.
  for (const [mcpName, mcpConfig] of Object.entries(mcpServers ?? {})) {
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
          //
          // Rather than failing silently, record a human-readable reason so the
          // caller can surface it to the model (and, through it, the user).
          const isAuthError =
            error instanceof UnauthorizedError ||
            (error instanceof Error &&
              /401|unauthorized/i.test(error.message))
          const errorMessage = isAuthError
            ? `not authenticated — run /connect:mcp ${mcpName} to authorize access`
            : error instanceof Error
              ? error.message
              : String(error)
          mcpLoadErrors.push(`'${mcpName}': ${errorMessage}`)
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

  return { customToolDefinitions: writeTo, mcpLoadErrors }
}
