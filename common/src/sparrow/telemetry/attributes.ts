// SPARROW: Typed attribute keys + span names for OpenTelemetry instrumentation.
// Keeping these as exported constants prevents typos across call sites.

export const SpanNames = {
  PROMPT: 'prompt',
  AGENT_RUN: 'agent.run',
  AGENT_STEP: 'agent.step',
  GEN_AI_CHAT: 'gen_ai.chat',
  TOOL_CALL: 'tool.call',
} as const

export const Attr = {
  // Resource-ish (still set as span attrs; we deliberately avoid Resource so cwd/branch changes are per-prompt)
  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',
  HOST_NAME: 'host.name',
  OS_TYPE: 'os.type',
  PROCESS_PID: 'process.pid',
  USER_EMAIL: 'user.email',
  USER_NAME: 'user.name',

  // Project / git (on prompt root)
  CWD: 'cwd',
  GIT_REPO: 'git.repo',
  GIT_BRANCH: 'git.branch',
  GIT_COMMIT: 'git.commit',
  GIT_WORKTREE: 'git.worktree',
  GIT_DIRTY: 'git.dirty',
  LINEAR_ISSUE: 'linear.issue',
  SESSION_ID: 'session.id',

  // Agents
  AGENT_ID: 'codebuff.agent_id',
  AGENT_DISPLAY_ID: 'codebuff.agent_display_id',
  PARENT_AGENT_ID: 'codebuff.parent_agent_id',
  STEP_NUMBER: 'codebuff.step_number',

  // LLM
  GEN_AI_SYSTEM: 'gen_ai.system',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  GEN_AI_REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  GEN_AI_RESPONSE_FINISH_REASON: 'gen_ai.response.finish_reason',
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  GEN_AI_USAGE_CACHE_READ_TOKENS: 'gen_ai.usage.cache_read_tokens',
  GEN_AI_USAGE_CACHE_CREATION_TOKENS: 'gen_ai.usage.cache_creation_tokens',

  // Codebuff-specific LLM
  ROUTE: 'codebuff.route',
  ROUTE_ATTEMPT: 'codebuff.route_attempt',
  // SPARROW (telemetry): stable per-OAuth-account identifier (truncated
  // SHA-256 hash of the OAuth refresh token, or access token in env-var
  // setups; see deriveOAuthAccountId in sdk/src/impl/model-provider.ts).
  // Lets us distinguish two Claude or ChatGPT OAuth subscriptions on the
  // same machine. Only set when the call uses claude_oauth or chatgpt_oauth
  // route. The hash is one-way; no token material is recoverable from the
  // logged value.
  OAUTH_ACCOUNT_ID: 'codebuff.oauth_account_id',
  COST_CREDITS: 'codebuff.cost.credits',
  COST_USD: 'codebuff.cost.usd',
  TOOL_CALLS_EMITTED: 'codebuff.tool_calls_emitted',

  // Rollup counters (same names; ancestors accumulate)
  ROLLUP_INPUT_TOKENS: 'codebuff.tokens.input',
  ROLLUP_OUTPUT_TOKENS: 'codebuff.tokens.output',
  ROLLUP_CACHE_READ_TOKENS: 'codebuff.tokens.cache_read',
  ROLLUP_CACHE_CREATION_TOKENS: 'codebuff.tokens.cache_creation',
  LLM_CALL_COUNT: 'codebuff.llm_call_count',

  // Tools
  TOOL_NAME: 'tool.name',
  TOOL_SUCCESS: 'tool.success',
  TOOL_DURATION_MS: 'tool.duration_ms',
  TOOL_BYTES_IN: 'tool.bytes_in',
  TOOL_BYTES_OUT: 'tool.bytes_out',
  CHILD_AGENT_ID: 'child.agent_id',

  // Opt-in content capture
  PROMPT_MESSAGES: 'prompt.messages',
} as const

export type RouteValue =
  | 'claude_oauth'
  | 'chatgpt_oauth'
  | 'codebuff_backend'
  | `direct_${string}`

export const Events = {
  ROUTE_ATTEMPT_FAILED: 'route_attempt_failed',
  ROUTE_ATTEMPT_SUCCEEDED: 'route_attempt_succeeded',
  PROMPT_MESSAGES: 'prompt.messages',
} as const
