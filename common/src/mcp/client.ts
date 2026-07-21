import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { MCPConfig } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

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

/**
 * Thrown by {@link getMCPClient} on the NON-interactive OAuth path when a
 * server requires authorization but no on-disk tokens exist yet.
 *
 * This is a distinct, typed error (not a generic failure) so callers can tell
 * "you must run /connect:mcp first" apart from a transient network/provider
 * error. Crucially, we throw it BEFORE connecting so we never cache a zombie
 * client or fetch a degraded (empty-`properties`) tool list that would poison
 * the shared module-level cache for the parent agent AND every subagent.
 */
export class McpAuthorizationRequiredError extends Error {
  constructor(serverUrl: string) {
    super(
      `MCP server ${serverUrl} requires authorization. Run '/connect:mcp' to authenticate, then retry.`,
    )
    this.name = 'McpAuthorizationRequiredError'
  }
}

// Module-level mutex to serialize interactive OAuth flows.
// If multiple servers need OAuth at startup they queue up and open browser
// tabs one at a time instead of all simultaneously.
let oauthFlowMutex: Promise<void> = Promise.resolve()

async function runWithOAuthMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = oauthFlowMutex
  oauthFlowMutex = oauthFlowMutex.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
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

/**
 * Removes a cached MCP client (and its tool-list cache) for the given config.
 *
 * This is needed to recover from a "zombie" client: the agent-runtime tool path
 * connects with `interactive: false`, and servers like Sparrow accept the MCP
 * `initialize` handshake WITHOUT auth — so `connect()` succeeds and the client
 * is cached even though it has no tokens and can't list/call tools. That zombie
 * makes {@link isMCPClientConnected} report "connected", which would cause
 * `/connect:mcp` to skip the OAuth flow. Clearing it here lets the interactive
 * flow run and replace it with a fully-authenticated client that both the
 * parent agent AND its subagents (which share this module-level cache) reuse.
 */
export function clearMCPClient(config: MCPConfig): void {
  const key = hashConfig(config)
  const client = runningClients[key]
  if (client) {
    try {
      client.close()
    } catch {
      // Best-effort: a failed close shouldn't block clearing the cache.
    }
    delete runningClients[key]
  }
  delete listToolsCache[key]
}

export async function getMCPClient(
  config: MCPConfig,
  oauthOptions?: {
    authProvider: McpOAuthClientProvider
    /**
     * Whether an interactive browser-based auth flow may run. Defaults to true.
     * When false (the agent-runtime tool path, incl. subagents), we still
     * attach the authProvider so stored on-disk tokens are sent as a Bearer
     * token, but we skip the callback-server orchestration and let a needed
     * authorization surface as an error instead of opening a browser.
     */
    interactive?: boolean
  },
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
  const interactive = oauthOptions?.interactive ?? true

  // When using OAuth, wrap fetch to strip `null` scope values from JSON
  // responses before the MCP SDK's Zod schema validates them. Some servers
  // (e.g. Sparrow) return `"scope": null` in token/DCR responses, but the
  // MCP SDK's `OAuthTokensSchema` uses `z.string().optional()` which accepts
  // `undefined` (field absent) but rejects `null`, causing a parse error.
  const oauthFetch: FetchLike | undefined = useOAuth
    ? async (...args: Parameters<FetchLike>) => {
        const response = await globalThis.fetch(...args)
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('application/json')) return response
        const text = await response.text()
        let body = text
        try {
          const json: unknown = JSON.parse(text)
          if (
            json !== null &&
            typeof json === 'object' &&
            'scope' in json &&
            (json as Record<string, unknown>).scope === null
          ) {
            const sanitized = { ...(json as Record<string, unknown>) }
            delete sanitized.scope
            body = JSON.stringify(sanitized)
          }
        } catch {
          // Not valid JSON — pass through unchanged.
        }
        // Copy headers and remove content-length: the sanitized body may be a
        // different size and the runtime will recalculate it from the new body.
        const responseHeaders = new Headers(response.headers)
        responseHeaders.delete('content-length')
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }
    : undefined

  const createHttpTransport = ():
    | StreamableHTTPClientTransport
    | SSEClientTransport => {
    const authProvider = useOAuth ? oauthOptions!.authProvider : undefined
    if (config.type === 'http') {
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        authProvider,
        fetch: oauthFetch,
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

  if (useOAuth && !interactive) {
    // Non-interactive OAuth path (agent-runtime tool calls, incl. subagents).
    // Attach the authProvider so any stored on-disk tokens are used, but do NOT
    // run the callback-server / browser orchestration.
    //
    // If there are no on-disk tokens yet, do NOT connect. Sparrow-style servers
    // accept the MCP `initialize` handshake WITHOUT auth, so connecting here
    // would (a) cache a zombie client that reports "connected" without being
    // able to call tools, and (b) let a subsequent listMCPTools fetch a
    // DEGRADED tool list (empty `inputSchema.properties`) that gets cached in
    // the shared module-level cache — stripping every tool's parameters for the
    // parent agent AND all subagents. Throwing here (before connecting) keeps
    // the cache clean and surfaces a clear "run /connect:mcp" message instead.
    if (!oauthOptions!.authProvider.tokens()) {
      throw new McpAuthorizationRequiredError(config.url)
    }
    const transport = createHttpTransport()
    await client.connect(transport)
    runningClients[key] = client
    return key
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

      // Helper: exchange the auth code that arrives at the callback server.
      // The SDK has already opened the browser; we just wait for the code.
      const completeAuthFlow = async () => {
        const authCode = await authProvider.waitForCode()
        try {
          // finishAuth runs the token exchange. The callback server has been
          // stopped by the request handler, but callbackPort is preserved (see
          // oauth-provider.ts) so redirectUrl still has the correct port for
          // the redirect_uri parameter.
          await transport.finishAuth(authCode)
        } finally {
          authProvider.stopCallbackServer()
        }
      }

      try {
        await client.connect(transport)
      } catch (connectError) {
        if (!(connectError instanceof UnauthorizedError)) {
          authProvider.stopCallbackServer()
          throw connectError
        }
        // connect() triggered an auth redirect. Complete the flow and reconnect.
        await completeAuthFlow()
        await client.connect(createHttpTransport())
        runningClients[key] = client
        return
      }

      // connect() succeeded. Some servers (e.g. Sparrow) accept the MCP
      // initialize handshake without auth but require it for tool calls.
      // If we don't have tokens yet, probe with listTools while the callback
      // server is still listening so we can handle the 401 correctly.
      if (!authProvider.tokens()) {
        try {
          await client.listTools()
          // Succeeded — server doesn't need auth for tool calls either.
        } catch (listError) {
          if (listError instanceof UnauthorizedError) {
            // listTools() triggered an auth redirect (SDK opened the browser).
            // The callback server is still running — complete the flow.
            // No reconnect needed: the MCP session is already established;
            // subsequent requests will carry the new Bearer token.
            await completeAuthFlow()
            runningClients[key] = client
            return
          }
          // Any other listTools error (permission denied, unsupported, etc.)
          // is non-fatal here — individual tool calls will surface the error.
        }
      }

      // Already authorized (tokens existed or listTools succeeded without auth).
      authProvider.stopCallbackServer()
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
    const promise = client.listTools(...args)
    // Don't cache rejected promises. A failed listTools (e.g. a not-yet-
    // authenticated OAuth server) must be retryable: otherwise every future
    // call — including subagents sharing this cache — would get the same stale
    // rejection even after `/connect:mcp` re-authenticates and replaces the
    // client. Drop the entry on rejection so the next call tries fresh.
    promise.catch(() => {
      if (listToolsCache[clientId] === promise) {
        delete listToolsCache[clientId]
      }
    })
    // Don't cache a DEGRADED tools/list either. Servers like Sparrow accept the
    // MCP `initialize` handshake WITHOUT auth (a "zombie" session — see
    // clearMCPClient), so a pre-auth listTools can resolve (HTTP 200) yet return
    // tools whose `inputSchema.properties` is empty. Caching that would strip
    // every tool's parameters for the parent AND all subagents (shared cache),
    // making the model call tools with empty `{}` args.
    //
    // We evict (treat as retryable) when the response is degraded in EITHER of
    // two ways:
    //  1. ALL tools lack properties — a whole-list zombie response. (Tradeoff: a
    //     healthy server whose tools ALL legitimately take zero params is
    //     re-listed on every call — niche and low-cost.)
    //  2. ANY tool has empty properties BUT declares `required` fields — a
    //     self-contradictory (a required param that isn't described) and
    //     therefore degraded schema. This catches a MIXED response where most
    //     tools loaded fine but one (e.g. quarterly_status_save) came back with
    //     its parameters stripped — which would otherwise be cached and silently
    //     poison just that one tool for every agent and subagent.
    promise.then(
      (result) => {
        const tools = result?.tools ?? []
        const isEmptyProps = (tool: (typeof tools)[number]): boolean => {
          const properties = tool.inputSchema?.properties
          return (
            !properties ||
            typeof properties !== 'object' ||
            Object.keys(properties).length === 0
          )
        }
        const declaresRequired = (tool: (typeof tools)[number]): boolean => {
          const required = tool.inputSchema?.required
          return Array.isArray(required) && required.length > 0
        }
        const allDegraded = tools.length > 0 && tools.every(isEmptyProps)
        const anySelfContradictory = tools.some(
          (tool: (typeof tools)[number]) =>
            isEmptyProps(tool) && declaresRequired(tool),
        )
        if (
          (allDegraded || anySelfContradictory) &&
          listToolsCache[clientId] === promise
        ) {
          delete listToolsCache[clientId]
        }
      },
      () => {
        // Rejection is handled by the `.catch` above; this no-op arm just
        // prevents an unhandled rejection on this derived promise.
      },
    )
    listToolsCache[clientId] = promise
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
