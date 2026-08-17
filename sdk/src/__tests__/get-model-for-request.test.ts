import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  markClaudeOAuthRateLimited,
  resetClaudeOAuthRateLimit,
  getModelForRequest,
  setClaudeOAuthFallbackEnabled,
} from '../impl/model-provider'

const OAUTH_TOKEN_ENV = 'CODEBUFF_CLAUDE_OAUTH_TOKEN'
const OAUTH_REFRESH_TOKEN_ENV = 'CODEBUFF_CLAUDE_OAUTH_REFRESH_TOKEN'
const BYOK_OPENROUTER_ENV = 'CODEBUFF_BYOK_OPENROUTER'

describe('getModelForRequest', () => {
  let savedEnvToken: string | undefined
  let savedRefreshToken: string | undefined
  let savedByokOpenRouter: string | undefined

  beforeEach(() => {
    savedEnvToken = process.env[OAUTH_TOKEN_ENV]
    savedRefreshToken = process.env[OAUTH_REFRESH_TOKEN_ENV]
    savedByokOpenRouter = process.env[BYOK_OPENROUTER_ENV]
    delete process.env[OAUTH_TOKEN_ENV]
    delete process.env[OAUTH_REFRESH_TOKEN_ENV]
    delete process.env[BYOK_OPENROUTER_ENV]
    resetClaudeOAuthRateLimit()
    setClaudeOAuthFallbackEnabled(true)
  })

  afterEach(() => {
    if (savedEnvToken !== undefined) {
      process.env[OAUTH_TOKEN_ENV] = savedEnvToken
    } else {
      delete process.env[OAUTH_TOKEN_ENV]
    }
    if (savedRefreshToken !== undefined) {
      process.env[OAUTH_REFRESH_TOKEN_ENV] = savedRefreshToken
    } else {
      delete process.env[OAUTH_REFRESH_TOKEN_ENV]
    }
    if (savedByokOpenRouter !== undefined) {
      process.env[BYOK_OPENROUTER_ENV] = savedByokOpenRouter
    } else {
      delete process.env[BYOK_OPENROUTER_ENV]
    }
  })

  test('uses Claude OAuth for Claude models when valid credentials are available', async () => {
    process.env[OAUTH_TOKEN_ENV] = 'test-oauth-token'

    const result = await getModelForRequest({
      apiKey: 'test-api-key',
      model: 'anthropic/claude-sonnet-5',
    })

    expect(result.isClaudeOAuth).toBe(true)
  })

  test('uses Codebuff backend for non-Claude models even with valid credentials', async () => {
    process.env[OAUTH_TOKEN_ENV] = 'test-oauth-token'

    const result = await getModelForRequest({
      apiKey: 'test-api-key',
      model: 'openai/gpt-4o',
    })

    expect(result.isClaudeOAuth).toBe(false)
  })

  test('uses Codebuff backend when skipClaudeOAuth is true even with valid credentials', async () => {
    process.env[OAUTH_TOKEN_ENV] = 'test-oauth-token'

    const result = await getModelForRequest({
      apiKey: 'test-api-key',
      model: 'anthropic/claude-sonnet-5',
      skipClaudeOAuth: true,
    })

    expect(result.isClaudeOAuth).toBe(false)
  })

  test('throws when rate limited and fallback disabled', async () => {
    markClaudeOAuthRateLimited()
    setClaudeOAuthFallbackEnabled(false)

    await expect(
      getModelForRequest({
        apiKey: 'test-api-key',
        model: 'anthropic/claude-sonnet-5',
      }),
    ).rejects.toThrow('rate limited')
  })

  test('uses BYOK OpenRouter directly without a Codebuff API key', async () => {
    process.env[BYOK_OPENROUTER_ENV] = 'test-openrouter-key'

    const result = await getModelForRequest({
      model: 'anthropic/claude-sonnet-5',
      skipClaudeOAuth: true,
    })

    expect(result.directProvider).toBe('openrouter')
    expect(result.isClaudeOAuth).toBe(false)
    expect(result.isChatGptOAuth).toBe(false)
    expect((result.model as { provider: string }).provider).toBe(
      'openrouter',
    )
  })

  test('falls back to BYOK OpenRouter when Claude OAuth is rate limited', async () => {
    process.env[BYOK_OPENROUTER_ENV] = 'test-openrouter-key'
    markClaudeOAuthRateLimited()
    setClaudeOAuthFallbackEnabled(false)

    const result = await getModelForRequest({
      model: 'anthropic/claude-sonnet-5',
    })

    expect(result.directProvider).toBe('openrouter')
  })
})
