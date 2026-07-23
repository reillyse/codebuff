export type * from '@codebuff/common/types/json'
export type * from '@codebuff/common/types/messages/codebuff-message'
export type * from '@codebuff/common/types/messages/data-content'
export type * from '@codebuff/common/types/print-mode'
export type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'
export { run } from './run'
export { getFiles } from './tools/read-files'
export type { FileFilter, FileFilterResult } from './tools/read-files'
export type {
  CodebuffClientOptions,
  RunOptions,
  MessageContent,
  TextContent,
  ImageContent,
} from './run'
export { buildUserMessageContent } from '@codebuff/agent-runtime/util/messages'
// Agent type exports
export type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
export type { ToolName } from '@codebuff/common/tools/constants'

export type {
  ClientToolCall,
  ClientToolName,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
export * from './client'
export * from './custom-tool'
export * from './native/ripgrep'
export * from './run-state'
export { ToolHelpers } from './tools'
export * from './constants'

export { getUserInfoFromApiKey } from './impl/database'
export * from './credentials'
export { loadLocalAgents } from './agents/load-agents'
export { loadMCPConfig, loadMCPConfigSync } from './agents/load-mcp-config'

// NOTE: MCP helpers are deliberately NOT re-exported from this public barrel.
// Both the MCP *client* helpers (getMCPClient, etc.) and the *OAuth provider*
// (McpOAuthProvider, getMcpOAuthStatus, clearMcpOAuthCredentials) have type
// signatures that reference `@modelcontextprotocol/sdk` types (`Client`,
// `OAuthClientMetadata`, `OAuthTokens`, ...). Those declarations contain an
// unresolvable zod `objectOutputType<...>` symbol that breaks
// `dts-bundle-generator` when it tries to inline them into the public bundle.
// The CLI imports the client helpers from `@codebuff/common/mcp/client` and the
// OAuth provider from `@codebuff/common/mcp/oauth-provider` instead.
export type { MCPConfig } from '@codebuff/common/types/mcp'
export { loadSkills } from './skills/load-skills'
export { formatAvailableSkillsXml } from '@codebuff/common/util/skills'
export type { LoadSkillsOptions } from './skills/load-skills'
export type { SkillDefinition, SkillsMap } from '@codebuff/common/types/skill'
export type {
  LoadedAgents,
  LoadedAgentDefinition,
  LoadLocalAgentsResult,
  AgentValidationError,
  AgentLoadError,
} from './agents/load-agents'
export type {
  MCPFileConfig,
  LoadedMCPConfig,
} from './agents/load-mcp-config'

export { validateAgents } from './validate-agents'
export type { ValidationResult, ValidateAgentsOptions } from './validate-agents'

// Error utilities
export {
  isRetryableStatusCode,
  getErrorStatusCode,
  sanitizeErrorMessage,
  RETRYABLE_STATUS_CODES,
  createHttpError,
  createAuthError,
  createForbiddenError,
  createPaymentRequiredError,
  createServerError,
  createNetworkError,
} from './error-utils'
export type { HttpError } from './error-utils'

// Retry configuration constants
export {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
  RECONNECTION_MESSAGE_DURATION_MS,
  RECONNECTION_RETRY_DELAY_MS,
} from './retry-config'

export type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

// Tree-sitter / code-map exports
export { getFileTokenScores, setWasmDir } from '@codebuff/code-map'
export type { FileTokenData, TokenCallerMap } from '@codebuff/code-map'

export { runTerminalCommand } from './tools/run-terminal-command'
export {
  promptAiSdk,
  promptAiSdkStream,
  promptAiSdkStructured,
} from './impl/llm'
export {
  resetChatGptOAuthRateLimit,
  resetClaudeOAuthRateLimit,
  setClaudeOAuthFallbackEnabled,
  setChatGptOAuthFallbackEnabled,
  isChatGptOAuthFallbackEnabled,
  setNonOAuthModelsEnabled,
  isNonOAuthModelsEnabled,
} from './impl/model-provider'
