import { describe, expect, it, mock } from 'bun:test'

import { McpOAuthProvider } from '../oauth-provider'

const SERVER_URL = 'https://api.sparrow.io/mcp'
const AUTH_URL = new URL('https://auth.sparrow.io/authorize?client_id=x')

describe('McpOAuthProvider interactive gating', () => {
  it('throws an actionable error (and does NOT open a browser) when non-interactive', () => {
    const onAuthorizationUrl = mock(() => {})
    const provider = new McpOAuthProvider(SERVER_URL, {
      interactive: false,
      onAuthorizationUrl,
    })

    expect(() => provider.redirectToAuthorization(AUTH_URL)).toThrow(
      /requires authorization.*\/connect:mcp/,
    )
    // The error message names the server so the user knows which one to connect.
    expect(() => provider.redirectToAuthorization(AUTH_URL)).toThrow(SERVER_URL)
    // Non-interactive must never surface the URL / attempt to open a browser.
    expect(onAuthorizationUrl).not.toHaveBeenCalled()
  })

  it('surfaces the authorization URL (interactive path) by default', () => {
    const onAuthorizationUrl = mock(() => {})
    // Default (no options) is interactive: true.
    const provider = new McpOAuthProvider(SERVER_URL, { onAuthorizationUrl })

    // Should NOT throw; it surfaces the URL and best-effort opens the browser.
    expect(() => provider.redirectToAuthorization(AUTH_URL)).not.toThrow()
    expect(onAuthorizationUrl).toHaveBeenCalledTimes(1)
    expect(onAuthorizationUrl).toHaveBeenCalledWith(AUTH_URL.toString())
  })
})
