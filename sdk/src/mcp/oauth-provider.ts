import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'

import open from 'open'

import { getConfigDir } from '../credentials'

import type { McpOAuthClientProvider } from '@codebuff/common/mcp/client'
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

interface McpServerCredentials {
  clientInformation?: OAuthClientInformationFull
  tokens?: OAuthTokens
  codeVerifier?: string
}

type McpOAuthStorage = Record<string, McpServerCredentials>

const CALLBACK_PATH = '/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

function getMcpOAuthPath(): string {
  return path.join(getConfigDir(), 'mcp-oauth.json')
}

function readMcpOAuthStorage(): McpOAuthStorage {
  const filePath = getMcpOAuthPath()
  if (!fs.existsSync(filePath)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpOAuthStorage
  } catch {
    return {}
  }
}

function writeMcpOAuthStorage(data: McpOAuthStorage): void {
  const filePath = getMcpOAuthPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

function callbackPageHtml(success: boolean, message: string): string {
  const heading = success
    ? '✓ Authorization Successful'
    : 'Authorization Failed'
  const headingColor = success ? '#4ade80' : '#f87171'
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Codebuff MCP</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5">
<div style="text-align:center;padding:2rem">
<h1 style="color:${headingColor};margin-bottom:0.5rem">${heading}</h1>
<p style="color:#a3a3a3">${message}</p>
</div>
<script>setTimeout(() => window.close(), 2000)</script>
</body></html>`
}

/**
 * Returns the current MCP OAuth connection status for all servers.
 */
export function getMcpOAuthStatus(): Array<{
  serverUrl: string
  hasTokens: boolean
  hasClientInfo: boolean
}> {
  const storage = readMcpOAuthStorage()
  return Object.entries(storage).map(([serverUrl, creds]) => ({
    serverUrl,
    hasTokens: Boolean(creds.tokens),
    hasClientInfo: Boolean(creds.clientInformation),
  }))
}

/**
 * Clears stored MCP OAuth credentials.
 * If serverUrl is provided, only clears that server's credentials.
 * Otherwise clears all stored credentials.
 */
export function clearMcpOAuthCredentials(serverUrl?: string): void {
  if (!serverUrl) {
    const filePath = getMcpOAuthPath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return
  }
  const all = readMcpOAuthStorage()
  if (serverUrl in all) {
    delete all[serverUrl]
    writeMcpOAuthStorage(all)
  }
}

/**
 * OAuth client provider for a single remote MCP server.
 *
 * Persists per-server client registration + tokens (keyed by server URL) and
 * runs a local ephemeral-port callback server to receive the authorization
 * code. PKCE and token exchange are handled by the MCP SDK; this class is the
 * storage + browser + callback layer it delegates to.
 */
export class McpOAuthProvider implements McpOAuthClientProvider {
  private readonly serverUrl: string
  private readonly onAuthorizationUrl?: (url: string) => void
  private callbackServer: http.Server | null = null
  private callbackPort: number | null = null
  private cachedState: string | null = null

  private codePromise: Promise<string> | null = null
  private codeResolve: ((code: string) => void) | null = null
  private codeReject: ((error: Error) => void) | null = null
  private callbackTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    serverUrl: string,
    options?: { onAuthorizationUrl?: (url: string) => void },
  ) {
    this.serverUrl = serverUrl
    this.onAuthorizationUrl = options?.onAuthorizationUrl
  }

  get redirectUrl(): string {
    const port = this.callbackPort ?? 0
    return `http://localhost:${port}${CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Codebuff MCP Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  private getStorage(): McpServerCredentials {
    return readMcpOAuthStorage()[this.serverUrl] ?? {}
  }

  private saveStorage(patch: Partial<McpServerCredentials>): void {
    const all = readMcpOAuthStorage()
    all[this.serverUrl] = { ...(all[this.serverUrl] ?? {}), ...patch }
    writeMcpOAuthStorage(all)
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.getStorage().clientInformation
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.saveStorage({ clientInformation: info })
  }

  tokens(): OAuthTokens | undefined {
    return this.getStorage().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    // Clear the code verifier now that the exchange is complete — it's
    // single-use and no longer needed after successful token save.
    const all = readMcpOAuthStorage()
    const current = all[this.serverUrl] ?? {}
    delete current.codeVerifier
    all[this.serverUrl] = { ...current, tokens }
    writeMcpOAuthStorage(all)
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const urlStr = authorizationUrl.toString()
    this.onAuthorizationUrl?.(urlStr)
    open(urlStr).catch(() => {
      // ignore — URL surfaced via callback or browser open
    })
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.saveStorage({ codeVerifier })
  }

  codeVerifier(): string {
    const stored = this.getStorage().codeVerifier
    if (!stored) {
      throw new Error('MCP OAuth: no PKCE code verifier found')
    }
    return stored
  }

  state(): string {
    if (!this.cachedState) {
      this.cachedState = crypto.randomUUID()
    }
    return this.cachedState
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    const all = readMcpOAuthStorage()
    const current = all[this.serverUrl]
    if (!current) {
      return
    }
    if (scope === 'all') {
      delete all[this.serverUrl]
    } else if (scope === 'client') {
      delete current.clientInformation
    } else if (scope === 'tokens') {
      delete current.tokens
      delete current.codeVerifier
    } else if (scope === 'verifier') {
      delete current.codeVerifier
    }
    writeMcpOAuthStorage(all)
  }

  /**
   * Starts the local callback server on an ephemeral port. Resolves once the
   * server is listening, at which point {@link redirectUrl} reflects the real
   * port. Must be called before starting the OAuth flow so the redirect URL
   * (used during dynamic client registration) is correct.
   */
  startCallbackServer(): Promise<void> {
    if (this.callbackServer) {
      return Promise.resolve()
    }

    // Generate a fresh state nonce for each new auth flow.
    this.cachedState = null

    // Clear any stale client registration and PKCE code verifier. We use an
    // ephemeral port each time, so the redirect_uri changes on every auth flow.
    // Reusing an old client_id (registered with a different port) causes the
    // authorization server to reject the redirect_uri mismatch. Clearing here
    // forces fresh DCR with the correct current port. The verifier is cleared
    // so the MCP SDK generates a fresh PKCE pair for this flow.
    this.invalidateCredentials('client')
    this.invalidateCredentials('verifier')

    this.codePromise = new Promise<string>((resolve, reject) => {
      this.codeResolve = resolve
      this.codeReject = reject
    })

    this.callbackTimeout = setTimeout(() => {
      this.settleCode(
        new Error('MCP OAuth: timed out waiting for authorization callback'),
      )
      this.stopCallbackServer()
    }, CALLBACK_TIMEOUT_MS)

    return new Promise<void>((resolveReady, rejectReady) => {
      const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://localhost')
        if (reqUrl.pathname !== CALLBACK_PATH) {
          res.writeHead(404)
          res.end()
          return
        }

        const code = reqUrl.searchParams.get('code')
        const returnedState = reqUrl.searchParams.get('state')
        const error = reqUrl.searchParams.get('error')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(callbackPageHtml(false, error))
          this.settleCode(new Error(`MCP OAuth authorization failed: ${error}`))
          this.stopCallbackServer()
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(callbackPageHtml(false, 'No authorization code received.'))
          this.settleCode(
            new Error('MCP OAuth: no authorization code in callback'),
          )
          this.stopCallbackServer()
          return
        }

        if (this.cachedState && returnedState !== this.cachedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(callbackPageHtml(false, 'OAuth state mismatch.'))
          this.settleCode(new Error('MCP OAuth: state mismatch in callback'))
          this.stopCallbackServer()
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          callbackPageHtml(
            true,
            'You can close this tab and return to Codebuff.',
          ),
        )
        this.settleCode(code)
        this.stopCallbackServer()
      })

      // Bind to '::' (IPv6 wildcard) which enables dual-stack on macOS/Linux,
      // accepting connections from both 127.0.0.1 (IPv4) and ::1 (IPv6). On
      // macOS, Chrome resolves 'localhost' to ::1 first; if the server only
      // binds to 127.0.0.1 the browser gets ERR_CONNECTION_REFUSED.
      // On systems where IPv6 is disabled, fall back to 127.0.0.1.
      const tryListen = (host: string) => {
        server.listen(0, host, () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            this.callbackPort = addr.port
          }
          this.callbackServer = server
          resolveReady()
        })
      }

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (
          (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') &&
          server.address() === null &&
          this.callbackServer === null
        ) {
          // IPv6 not available on this system — retry on IPv4 loopback.
          server.removeAllListeners('error')
          server.on('error', (err2) => {
            this.callbackServer = null
            this.callbackPort = null
            rejectReady(err2)
          })
          tryListen('127.0.0.1')
          return
        }
        this.callbackServer = null
        this.callbackPort = null
        rejectReady(err)
      })

      tryListen('::')
    })
  }

  /**
   * Resolves with the authorization code once the callback is received.
   * {@link startCallbackServer} must have been called first.
   */
  waitForCode(): Promise<string> {
    if (!this.codePromise) {
      return Promise.reject(
        new Error('MCP OAuth: callback server not started'),
      )
    }
    return this.codePromise
  }

  stopCallbackServer(): void {
    if (this.callbackTimeout) {
      clearTimeout(this.callbackTimeout)
      this.callbackTimeout = null
    }
    if (this.callbackServer) {
      try {
        this.callbackServer.close()
      } catch {
        // ignore
      }
      this.callbackServer = null
      // NOTE: deliberately do NOT reset callbackPort here. The MCP SDK's
      // token exchange (transport.finishAuth) reads provider.redirectUrl AFTER
      // the callback has been received (and this method has run), and the
      // redirect_uri in the token exchange must match the one used during the
      // authorization request. Resetting the port to null would make
      // redirectUrl fall back to http://localhost:0/callback, causing a
      // redirect_uri mismatch / ERR_UNSAFE_PORT. A fresh startCallbackServer()
      // always assigns a new port, so keeping the last value here is safe.
    }
  }

  private settleCode(codeOrError: string | Error): void {
    if (codeOrError instanceof Error) {
      this.codeReject?.(codeOrError)
    } else {
      this.codeResolve?.(codeOrError)
    }
    this.codeResolve = null
    this.codeReject = null
  }
}
