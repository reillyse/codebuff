import {
  getClaudeOAuthCredentials,
  getValidClaudeOAuthCredentials,
  setClaudeOAuthFallbackEnabled,
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

  // Validate Claude OAuth credentials on startup
  const claudeCredentials = getClaudeOAuthCredentials()
  if (!claudeCredentials) {
    return { claudeOAuthExpired: false }
  }

  // Disable fallback to Codebuff backend when Claude OAuth fails,
  // so we don't silently burn Codebuff credits
  setClaudeOAuthFallbackEnabled(false)
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
