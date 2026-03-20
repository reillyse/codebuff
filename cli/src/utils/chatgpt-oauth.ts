/**
 * ChatGPT OAuth status utility.
 * This feature is disabled in this fork — always returns disconnected.
 */

export function getChatGptOAuthStatus(): { connected: boolean } {
  return { connected: false }
}
