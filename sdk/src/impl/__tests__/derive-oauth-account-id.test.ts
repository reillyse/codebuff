// SPARROW (telemetry): Unit tests for deriveOAuthAccountId, which produces
// the per-OAuth-account hash recorded as `codebuff.oauth_account_id` on
// gen_ai.chat spans. Critical properties exercised here:
//   - Stable for identical credential material (same hash on repeated calls)
//   - Different credentials → different hashes
//   - Refresh token preferred over access token when both present
//   - Access token used as fallback for env-var credentials (refreshToken='')
//   - Returns undefined when neither field has usable material
import { describe, expect, test } from 'bun:test'

import { deriveOAuthAccountId } from '../model-provider'

describe('deriveOAuthAccountId', () => {
  test('returns a stable 16-char hex hash for the same refresh token', () => {
    const a = deriveOAuthAccountId({
      refreshToken: 'rt-abc-123',
      accessToken: 'at-1',
    })
    const b = deriveOAuthAccountId({
      refreshToken: 'rt-abc-123',
      accessToken: 'at-2', // different access token, same refresh token
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('different refresh tokens produce different hashes', () => {
    const a = deriveOAuthAccountId({ refreshToken: 'rt-account-A' })
    const b = deriveOAuthAccountId({ refreshToken: 'rt-account-B' })
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
  })

  test('falls back to access token when refresh token is empty (env-var case)', () => {
    const envVarCreds = { refreshToken: '', accessToken: 'env-access-xyz' }
    const a = deriveOAuthAccountId(envVarCreds)
    const b = deriveOAuthAccountId(envVarCreds)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    // Should match the hash of accessToken alone, not refreshToken+accessToken.
    expect(a).toBe(deriveOAuthAccountId({ accessToken: 'env-access-xyz' }))
  })

  test('falls back to access token when refresh token is undefined', () => {
    const a = deriveOAuthAccountId({ accessToken: 'at-only' })
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('returns undefined when neither field is usable', () => {
    expect(deriveOAuthAccountId({})).toBeUndefined()
    expect(deriveOAuthAccountId({ refreshToken: '' })).toBeUndefined()
    expect(deriveOAuthAccountId({ accessToken: '' })).toBeUndefined()
    expect(
      deriveOAuthAccountId({ refreshToken: '', accessToken: '' }),
    ).toBeUndefined()
  })

  test('hash is one-way (output is hex, no recoverable token material)', () => {
    const token = 'super-secret-refresh-token-do-not-leak'
    const hash = deriveOAuthAccountId({ refreshToken: token })
    expect(hash?.length).toBe(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    // No substring of the plaintext token can appear in the hash output.
    for (let i = 0; i + 4 <= token.length; i++) {
      expect(hash).not.toContain(token.slice(i, i + 4))
    }
  })
})
