import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import { CLAUDE_OAUTH_ENABLED } from '@codebuff/common/constants/claude-oauth'
import {
  getChatGptOAuthCredentials,
  getClaudeOAuthCredentials,
  getValidChatGptOAuthCredentials,
  getValidClaudeOAuthCredentials,
  setChatGptOAuthFallbackEnabled,
  setClaudeOAuthFallbackEnabled,
  setNonOAuthModelsEnabled,
} from '@codebuff/sdk'
import { enableMapSet } from 'immer'

import { initializeThemeStore } from '../hooks/use-theme'
import { setProjectRoot } from '../project-files'
import { initTimestampFormatter } from '../utils/helpers'
import { enableManualThemeRefresh } from '../utils/theme-system'
import { initializeDirenv } from './init-direnv'

export async function initializeApp(params: { cwd?: string }): Promise<{ claudeOAuthExpired: boolean }> {
  if (params.cwd) {
    process.chdir(params.cwd)
  }
  const baseCwd = process.cwd()
  setProjectRoot(baseCwd)

  // Initialize direnv environment before anything else
  initializeDirenv()

  enableMapSet()
  initializeThemeStore()
  enableManualThemeRefresh()
  initTimestampFormatter()

  // Never fall back to Codebuff backend credits for Claude models
  setClaudeOAuthFallbackEnabled(false)

  // Only allow Claude and OpenAI models (both routed via OAuth subscriptions)
  setNonOAuthModelsEnabled(false)

  // ChatGPT OAuth: disable fallback if credentials are configured, so requests
  // never silently fall back to the server OPENAI_API_KEY when the user is set
  // up for OAuth.
  if (CHATGPT_OAUTH_ENABLED) {
    const chatGptCredentials = getChatGptOAuthCredentials()
    if (chatGptCredentials) {
      setChatGptOAuthFallbackEnabled(false)
      // Best-effort background token refresh.
      getValidChatGptOAuthCredentials().catch(() => {})
    }
  }

  // Validate Claude OAuth credentials on startup
  const claudeCredentials = getClaudeOAuthCredentials()
  if (!claudeCredentials) {
    return { claudeOAuthExpired: false }
  }
  try {
    const validCredentials = await Promise.race([
      getValidClaudeOAuthCredentials(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
    return { claudeOAuthExpired: !validCredentials }
  } catch (error) {
    console.debug('Failed to refresh Claude OAuth credentials:', error)
    return { claudeOAuthExpired: true }
  }
}
