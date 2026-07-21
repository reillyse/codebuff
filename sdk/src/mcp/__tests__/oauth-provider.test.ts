import { describe, expect, it, mock } from 'bun:test'

import {
  MCP_TOKEN_EXPIRY_MARGIN_MS,
  McpOAuthProvider,
  isMcpAccessTokenExpired,
} from '../oauth-provider'

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

describe('isMcpAccessTokenExpired', () => {
  const NOW = 1_700_000_000_000
  const MARGIN = MCP_TOKEN_EXPIRY_MARGIN_MS

  it('returns false for a freshly-obtained token', () => {
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: 3600,
        obtainedAtMs: NOW,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(false)
  })

  it('returns true for a token obtained longer ago than its lifetime', () => {
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: 3600,
        // Obtained two hours ago — well past a 1h lifetime.
        obtainedAtMs: NOW - 2 * 3600 * 1000,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(true)
  })

  it('treats a token inside the safety margin as already expired', () => {
    // Expires exactly 30s from now — inside the 60s margin, so expired.
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: 3600,
        obtainedAtMs: NOW - (3600 - 30) * 1000,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(true)
  })

  it('treats a token just outside the safety margin as still valid', () => {
    // Expires 120s from now — outside the 60s margin, so still valid.
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: 3600,
        obtainedAtMs: NOW - (3600 - 120) * 1000,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(false)
  })

  it('treats a token with no expires_in as non-expiring', () => {
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: undefined,
        obtainedAtMs: NOW - 10 * 3600 * 1000,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(false)
  })

  it('treats a token with no obtainedAt (legacy storage) as non-expiring', () => {
    expect(
      isMcpAccessTokenExpired({
        expiresInSeconds: 3600,
        obtainedAtMs: undefined,
        nowMs: NOW,
        marginMs: MARGIN,
      }),
    ).toBe(false)
  })
})
