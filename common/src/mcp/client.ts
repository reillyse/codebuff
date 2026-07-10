import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

import type { MCPConfig } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'

/**
 * OAuth client provider for a remote MCP server, extended with the callback
 * lifecycle that {@link getMCPClient} drives during an interactive auth flow.
 * The concrete implementation lives in the SDK (`sdk/src/mcp/oauth-provider.ts`)
 * so this package stays free of browser/HTTP-server concerns.
 */
export interface McpOAuthClientProvider extends OAuthClientProvider {
  /** Start the local callback server; resolves once it is listening. */
  startCallbackServer(): Promise<void>
  /** Resolve with the authorization code once the callback is received. */
  waitForCode(): Promise<string>
  /** Close the callback server. */
  stopCallbackServer(): void
}

// Module-level mutex to serialize interactive OAuth flows.
// If multiple servers need OAuth at startup they queue up and open browser
// tabs one at a time instead of all simultaneously.
let oauthFlowMutex: Promise<void> = Promise.resolve()

async function runWithOAuthMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = oauthFlowMutex
  oauthFlowMutex = oauthFlowMutex.then(
    () => new Promise<void>(resolve => { release = resolve }),
  )
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}

/**
 * Substitutes environment variable references ($VAR_NAME) in a string with their values.
 * Supports both simple replacement ("$VAR_NAME") and interpolation ("Bearer $VAR_NAME").
 */
function substituteEnvInValue(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      // Return original if env var not found
      return match
    }
    return envValue
  })
}

/**
 * Substitutes environment variable references in all values of a record.
 */
function substituteEnvInRecord(
  record: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value)
  }
  return result
}

function hashConfig(config: MCPConfig): string {
  if (config.type === 'stdio') {
    return JSON.stringify({
      command: config.command,
      args: config.args,
      env: config.env,
    })
  }
  if (config.type === 'http') {
    return JSON.stringify({
      type: 'http',
      url: config.url,
      params: config.params,
      oauth: config.oauth ?? false,
    })
  }
  if (config.type === 'sse') {
    return JSON.stringify({
      type: 'sse',
      url: config.url,
      params: config.params,
      oauth: config.oauth ?? false,
    })
  }
  config.type satisfies never
  throw new Error(
    `Internal error in hashConfig: invalid MCP config type ${config.type}`,
  )
}

/**
 * Returns true if a client for this config is already connected and cached.
 * Useful for commands that want to avoid re-running an interactive auth flow
 * for a server that's already connected.
 */
export function isMCPClientConnected(config: MCPConfig): boolean {
  return hashConfig(config) in runningClients
}

export async function getMCPClient(
  config: MCPConfig,
  oauthOptions?: { authProvider: McpOAuthClientProvider },
): Promise<string> {
  const key = hashConfig(config)
  if (key in runningClients) {
    return key
  }

  const client = new Client({
    name: 'codebuff',
    version: '1.0.0',
  })

  if (config.type === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: substituteEnvInRecord(config.env),
      stderr: 'ignore',
    })
    await client.connect(transport)
    runningClients[key] = client
    return key
  }

  // Remote (http/sse) transports.
  const url = new URL(config.url)
  for (const [paramKey, value] of Object.entries(config.params)) {
    url.searchParams.set(paramKey, value)
  }
  const headers = substituteEnvInRecord(config.headers)
  const useOAuth = Boolean(config.oauth && oauthOptions)

  const createHttpTransport = (): StreamableHTTPClientTransport | SSEClientTransport => {
    const authProvider = useOAuth ? oauthOptions!.authProvider : undefined
    if (config.type === 'http') {
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        authProvider,
      })
    }
    if (config.type === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        authProvider,
      })
    }
    config.type satisfies never
    throw new Error(`Internal error: invalid MCP config type ${config.type}`)
  }

  if (useOAuth) {
    // Serialize OAuth flows so multiple servers requesting auth at startup
    // queue up and open one browser tab at a time.
    await runWithOAuthMutex(async () => {
      // Re-check the cache inside the mutex: a concurrent call for the same
      // server might have completed while we were waiting.
      if (key in runningClients) return

      const { authProvider } = oauthOptions!
      // Start the callback server first so the redirect URL (and dynamic client
      // registration) uses the real ephemeral port before we connect.
      await authProvider.startCallbackServer()
      const transport = createHttpTransport()
      try {
        await client.connect(transport)
        // Already authorized (existing tokens) — no browser needed.
        authProvider.stopCallbackServer()
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) {
          authProvider.stopCallbackServer()
          throw error
        }
        // The SDK opened the browser via redirectToAuthorization; wait for the
        // user to authorize, finish the exchange, then reconnect with the token.
        const authCode = await authProvider.waitForCode()
        try {
          // finishAuth runs the token exchange, which reads redirectUrl for the
          // redirect_uri param. The callback server is already stopped by the
          // request handler, but the port value is preserved (see
          // oauth-provider.ts) so the redirect_uri matches. Stop the server
          // afterwards as a safety net in case no callback ever arrived.
          await transport.finishAuth(authCode)
        } finally {
          authProvider.stopCallbackServer()
        }
        await client.connect(createHttpTransport())
      }
      runningClients[key] = client
    })
  } else {
    const transport: Transport = createHttpTransport()
    await client.connect(transport)
    runningClients[key] = client
  }

  return key
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  if (!listToolsCache[clientId]) {
    listToolsCache[clientId] = client.listTools(...args)
  }
  return listToolsCache[clientId]
}

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

export async function callMCPTool(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.callTool>
): Promise<ToolResultOutput[]> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const callResult = await client.callTool(...args)
  const result = callResult as CallToolResult
  const content = result.content

  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      return {
        type: 'media',
        data: getResourceData(c.resource),
        mediaType: c.resource.mimeType ?? 'text/plain',
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}
