import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import { CLAUDE_OAUTH_ENABLED } from '@codebuff/common/constants/claude-oauth'
import {
  clearMCPClient,
  getMCPClient,
  isMCPClientConnected,
} from '@codebuff/common/mcp/client'
import { loadMCPConfig, loadMCPConfigSync } from '@codebuff/sdk'
import { clearMcpOAuthCredentials, getMcpOAuthStatus, McpOAuthProvider } from '@codebuff/sdk/mcp/oauth-provider'
import open from 'open'

import { handleAdsEnable, handleAdsDisable } from './ads'
import { handleHippoEnable, handleHippoDisable, handleHippoStatus, handleHippoRetry, handleHippoLogEnable, handleHippoLogDisable, handleHippoLogToggle } from './hippo'
import { buildInterviewPrompt, buildPlanPrompt, buildReviewPromptFromArgs } from './prompt-builders'
// SPARROW: /telemetry command — inspect/mutate sparrow-config.json telemetry section
import { handleTelemetry } from './telemetry'
import { useThemeStore } from '../hooks/use-theme'
import { handleHelpCommand } from './help'
import { handleImageCommand } from './image'
import { handleInitializationFlowLocally } from './init'
import { handleReferralCode } from './referral'
import { runBashCommand } from './router'
import { normalizeReferralCode } from './router-utils'
import { handleUsageCommand } from './usage'
import { WEBSITE_URL } from '../login/constants'
import { useChatStore } from '../state/chat-store'
import { useFeedbackStore } from '../state/feedback-store'
import { useLoginStore } from '../state/login-store'
import { getChatGptOAuthStatus } from '../utils/chatgpt-oauth'
import { AGENT_MODES, IS_FREEBUFF } from '../utils/constants'
import { getSystemMessage, getUserMessage } from '../utils/message-history'
import { capturePendingAttachments } from '../utils/pending-attachments'
import { getSkillByName } from '../utils/skill-registry'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { InputValue, PendingAttachment } from '../types/store'
import type { ChatMessage } from '../types/chat'
import type { SendMessageFn } from '../types/contracts/send-message'
import type { User } from '../utils/auth'
import type { AgentMode } from '../utils/constants'
import type { UseMutationResult } from '@tanstack/react-query'

export type RouterParams = {
  abortControllerRef: React.MutableRefObject<AbortController | null>
  agentMode: AgentMode
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  inputValue: string
  isChainInProgressRef: React.MutableRefObject<boolean>
  isStreaming: boolean
  logoutMutation: UseMutationResult<boolean, Error, void, unknown>
  streamMessageIdRef: React.MutableRefObject<string | null>
  addToQueue: (message: string, attachments?: PendingAttachment[]) => void
  clearMessages: () => void
  saveToHistory: (message: string) => void
  scrollToLatest: () => void
  sendMessage: SendMessageFn
  setCanProcessQueue: (value: React.SetStateAction<boolean>) => void
  setInputFocused: (focused: boolean) => void
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  setIsAuthenticated: (value: React.SetStateAction<boolean | null>) => void
  setMessages: (
    value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void
  setUser: (value: React.SetStateAction<User | null>) => void
  stopStreaming: () => void
}

export type CommandResult = {
  openFeedbackMode?: boolean
  openPublishMode?: boolean
  openChatHistory?: boolean
  openReviewScreen?: boolean
  preSelectAgents?: string[]
} | void

export type CommandHandler = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

export type CommandDefinition = {
  name: string
  aliases: string[]
  handler: CommandHandler
  /** Whether this command accepts arguments. Set automatically by the factory functions. */
  acceptsArgs: boolean
}

/**
 * Handler type for commands that don't accept arguments.
 */
type CommandHandlerNoArgs = (
  params: RouterParams,
) => Promise<CommandResult> | CommandResult

/**
 * Handler type for commands that accept arguments.
 */
type CommandHandlerWithArgs = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

/**
 * Configuration for defining a command that does NOT accept arguments.
 */
type CommandConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerNoArgs
}

/**
 * Configuration for defining a command that accepts arguments.
 */
type CommandWithArgsConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerWithArgs
}

/**
 * Factory for commands that do NOT accept arguments.
 * Any args passed are gracefully ignored.
 *
 * @example
 * defineCommand({
 *   name: 'new',
 *   aliases: ['n', 'clear'],
 *   handler: (params) => {
 *     params.setMessages(() => [])
 *   },
 * })
 */
export function defineCommand(config: CommandConfig): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: false,
    handler: (params) => {
      // Args are gracefully ignored for commands that don't accept them
      return config.handler(params)
    },
  }
}

/**
 * Factory for commands that accept arguments.
 * The handler receives both params and args.
 *
 * @example
 * defineCommandWithArgs({
 *   name: 'bash',
 *   aliases: ['!'],
 *   handler: (params, args) => {
 *     if (args.trim()) {
 *       runBashCommand(args.trim())
 *     }
 *   },
 * })
 */
export function defineCommandWithArgs(
  config: CommandWithArgsConfig,
): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: true,
    handler: config.handler,
  }
}

const clearInput = (params: RouterParams) => {
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

const FREEBUFF_REMOVED_COMMANDS = new Set([
  'ads:enable',
  'ads:disable',
  'refer-friends',
  'usage',
  'subscribe',
  'image',
  'publish',
  'gpt-5-agent',
  'connect:claude',
])

// Commands that should ONLY be available in Freebuff mode (excluded from regular mode).
// `plan` is gated to Freebuff because it requires a connected ChatGPT subscription.
const FREEBUFF_ONLY_COMMANDS = new Set<string>(['plan'])

const ALL_COMMANDS: CommandDefinition[] = [
  defineCommand({
    name: 'ads:enable',
    handler: (params) => {
      const { postUserMessage } = handleAdsEnable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:disable',
    handler: (params) => {
      const { postUserMessage } = handleAdsDisable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:enable',
    handler: (params) => {
      const { postUserMessage } = handleHippoEnable()
      useChatStore.getState().setHippoEnabled(true)
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:disable',
    handler: (params) => {
      const { postUserMessage } = handleHippoDisable()
      useChatStore.getState().setHippoEnabled(false)
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:toggle',
    aliases: ['hippo'],
    handler: (params) => {
      const currentEnabled = useChatStore.getState().hippoEnabled
      const { postUserMessage } = currentEnabled ? handleHippoDisable() : handleHippoEnable()
      useChatStore.getState().setHippoEnabled(!currentEnabled)
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:status',
    handler: (params) => {
      const { postUserMessage } = handleHippoStatus()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:retry',
    handler: async (params) => {
      const { postUserMessage } = await handleHippoRetry()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:log:enable',
    handler: (params) => {
      const { postUserMessage } = handleHippoLogEnable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:log:disable',
    handler: (params) => {
      const { postUserMessage } = handleHippoLogDisable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'hippo:log',
    handler: (params) => {
      const { postUserMessage } = handleHippoLogToggle()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'help',
    aliases: ['h', '?'],
    handler: async (params) => {
      const { postUserMessage } = await handleHelpCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'feedback',
    aliases: ['bug', 'report'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided feedback text directly, pre-populate the form
      if (trimmedArgs) {
        useFeedbackStore.getState().setFeedbackText(trimmedArgs)
        useFeedbackStore.getState().setFeedbackCursor(trimmedArgs.length)
      }

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openFeedbackMode: true }
    },
  }),
  defineCommandWithArgs({
    name: 'bash',
    aliases: ['!'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a command directly, execute it immediately
      if (trimmedArgs) {
        const commandWithBang = '!' + trimmedArgs
        params.saveToHistory(commandWithBang)
        clearInput(params)
        runBashCommand(trimmedArgs)
        return
      }

      // Otherwise enter bash mode
      useChatStore.getState().setInputMode('bash')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'refer-friends',
    aliases: ['referral', 'redeem'],
    handler: async (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a code directly, redeem it immediately
      if (trimmedArgs) {
        const code = normalizeReferralCode(trimmedArgs)
        try {
          const { postUserMessage } = await handleReferralCode(code)
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            ...postUserMessage([]),
          ])
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(`Error redeeming referral code: ${errorMessage}`),
          ])
        }
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        return
      }

      // Otherwise enter referral mode
      useChatStore.getState().setInputMode('referral')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'login',
    aliases: ['signin'],
    handler: (params) => {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          "You're already in the app. Use /logout to switch accounts.",
        ),
      ])
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'logout',
    aliases: ['signout'],
    handler: (params) => {
      params.abortControllerRef.current?.abort()
      params.stopStreaming()
      params.setCanProcessQueue(false)

      const { resetLoginState } = useLoginStore.getState()
      params.logoutMutation.mutate(undefined, {
        onSettled: () => {
          resetLoginState()
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage('Logged out.'),
          ])
          clearInput(params)
          setTimeout(() => {
            params.setUser(null)
            params.setIsAuthenticated(false)
          }, 300)
        },
      })
    },
  }),
  defineCommand({
    name: 'exit',
    aliases: ['quit', 'q'],
    handler: () => {
      process.kill(process.pid, 'SIGINT')
    },
  }),
  defineCommandWithArgs({
    name: 'new',
    aliases: ['n', 'clear', 'c', 'reset'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // Clear the conversation
      params.setMessages(() => [])
      params.clearMessages()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      params.stopStreaming()

      // If user provided a message, send it as the first message in the new chat
      if (trimmedArgs) {
        // Re-enable queue processing so the message can be sent
        params.setCanProcessQueue(true)
        params.sendMessage({
          content: trimmedArgs,
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
      } else {
        // Only disable queue if we're not sending a message
        params.setCanProcessQueue(false)
      }
    },
  }),
  defineCommand({
    name: 'init',
    handler: async (params) => {
      const { postUserMessage } = handleInitializationFlowLocally()
      const trimmed = params.inputValue.trim()

      params.saveToHistory(trimmed)
      clearInput(params)

      // Check streaming/queue state
      if (
        params.isStreaming ||
        params.streamMessageIdRef.current ||
        params.isChainInProgressRef.current
      ) {
        const pendingAttachments = capturePendingAttachments()
        params.addToQueue(trimmed, pendingAttachments)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      params.sendMessage({
        content: trimmed,
        agentMode: params.agentMode,
        postUserMessage,
      })
      setTimeout(() => {
        params.scrollToLatest()
      }, 0)
    },
  }),
  defineCommand({
    name: 'usage',
    aliases: ['credits'],
    handler: async (params) => {
      const { postUserMessage } = await handleUsageCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'subscribe',
    aliases: ['strong', 'sub', 'buy-credits'],
    handler: (params) => {
      open(WEBSITE_URL + '/subscribe')
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'image',
    aliases: ['img', 'attach'],
    handler: async (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a path directly, process it immediately
      if (trimmedArgs) {
        await handleImageCommand(trimmedArgs)
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        return
      }

      // Otherwise enter image mode
      useChatStore.getState().setInputMode('image')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  // Mode commands generated from AGENT_MODES (excluded in Freebuff)
  ...(IS_FREEBUFF ? [] : AGENT_MODES).map((mode) =>
    defineCommandWithArgs({
      name: `mode:${mode.toLowerCase()}`,
      handler: (params, args) => {
        const trimmedArgs = args.trim()

        useChatStore.getState().setAgentMode(mode)
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Switched to ${mode} mode.`),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)

        // If user provided a message, send it in the new mode
        if (trimmedArgs) {
          params.setCanProcessQueue(true)
          params.sendMessage({
            content: trimmedArgs,
            agentMode: mode,
          })
          setTimeout(() => {
            params.scrollToLatest()
          }, 0)
        }
      },
    }),
  ),
  defineCommandWithArgs({
    name: 'publish',
    handler: (params, args) => {
      const trimmedArgs = args.trim()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided agent ids directly, skip to confirmation step
      if (trimmedArgs) {
        const agentIds = trimmedArgs.split(/\s+/).filter(Boolean)
        return { openPublishMode: true, preSelectAgents: agentIds }
      }

      // Otherwise open selection UI
      return { openPublishMode: true }
    },
  }),
  defineCommand({
    name: 'gpt-5-agent',
    handler: (params) => {
      // Insert @ GPT-5 Agent into the input field (UI shortcut, not a real command)
      params.setInputValue({
        text: '@GPT-5 Agent ',
        cursorPosition: '@GPT-5 Agent '.length,
        lastEditDueToNav: false,
      })
      params.inputRef.current?.focus()
      // Don't save to history - this is just a UI shortcut
    },
  }),
  defineCommand({
    name: 'connect:claude',
    handler: (params) => {
      if (!CLAUDE_OAUTH_ENABLED) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            'Claude OAuth connection has been disabled. Use /subscribe for usage across all models.',
          ),
        ])
        clearInput(params)
        return
      }
      // Enter connect:claude mode to show the OAuth banner
      useChatStore.getState().setInputMode('connect:claude')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  ...(CHATGPT_OAUTH_ENABLED
    ? [
        defineCommand({
          name: 'connect:chatgpt',
          handler: (params) => {
            useChatStore.getState().setInputMode('connect:chatgpt')
            params.saveToHistory(params.inputValue.trim())
            clearInput(params)
          },
        }),
      ]
    : []),
  defineCommandWithArgs({
    name: 'connect:mcp',
    handler: async (params, args) => {
      const serverName = args.trim()
      const inputText = params.inputValue.trim()
      params.saveToHistory(inputText)
      clearInput(params)

      if (!serverName) {
        // No args: show status of all OAuth-configured servers
        const connections = getMcpOAuthStatus()
        if (connections.length === 0) {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(inputText),
            getSystemMessage(
              'No MCP OAuth connections found. Add `"oauth": true` to a remote MCP server in your mcp.json, then run `/connect:mcp <name>` to authenticate.',
            ),
          ])
          return
        }
        const lines = [
          'MCP OAuth connections:',
          '',
          ...connections.map((c) => {
            const status = c.hasTokens ? '✓ authenticated' : '○ not authenticated'
            return `  ${status}  ${c.serverUrl}`
          }),
          '',
          'Use `/connect:mcp <name>` to authenticate a server, or `/disconnect:mcp <url>` to clear credentials.',
        ]
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(lines.join('\n')),
        ])
        return
      }

      // Proactive auth flow for a named server
      const mcpConfig = await loadMCPConfig({ verbose: false })
      const serverConfig = mcpConfig.mcpServers[serverName]

      if (!serverConfig) {
        const available = Object.keys(mcpConfig.mcpServers)
        const hint =
          available.length > 0
            ? `\n\nAvailable servers: ${available.join(', ')}`
            : '\n\nNo MCP servers configured. Add servers to ~/.agents/mcp.json.'
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(`MCP server "${serverName}" not found in mcp.json.${hint}`),
        ])
        return
      }

      if (serverConfig.type === 'stdio') {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(
            `"${serverName}" is a stdio MCP server and does not use OAuth authentication.`,
          ),
        ])
        return
      }

      if (!serverConfig.oauth) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(
            `"${serverName}" does not have OAuth enabled. Add \`"oauth": true\` to its entry in mcp.json to enable OAuth authentication.`,
          ),
        ])
        return
      }

      // Already connected — but only short-circuit if the cached client is
      // actually authenticated. The agent-runtime tool path connects
      // non-interactively, and servers like Sparrow accept the MCP initialize
      // handshake without auth, leaving a "zombie" client cached with no tokens.
      // That zombie would make this command report success while tool listing
      // silently fails (for the parent AND subagents that share the cache).
      // When there are no tokens, clear the zombie and fall through to the real
      // OAuth flow so we end up with a fully-authenticated shared client.
      if (isMCPClientConnected(serverConfig)) {
        const oauthStatus = getMcpOAuthStatus()
        const serverStatus = oauthStatus.find(
          (s) => s.serverUrl === serverConfig.url,
        )
        if (serverStatus?.hasTokens) {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(inputText),
            getSystemMessage(
              `✓ Already connected to ${serverName} (${serverConfig.url}).\nOAuth tokens are valid.\n\nUse /disconnect:mcp ${serverName} to clear credentials and reconnect.`,
            ),
          ])
          return
        }
        // Zombie client with no tokens — drop it and re-authenticate below.
        clearMCPClient(serverConfig)
      }

      // Show connecting message before opening browser
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(inputText),
        getSystemMessage(
          `Connecting to ${serverName} (${serverConfig.url})...\n\nIf authorization is needed, your browser will open. The authorization URL will also appear in your terminal — if you see a login loop, paste that URL into the browser where you're logged in.`,
        ),
      ])

      try {
        const authProvider = new McpOAuthProvider(serverConfig.url, {
          onAuthorizationUrl: (url) => {
            params.setMessages((prev) => [
              ...prev,
              getSystemMessage(
                `Authorization URL (paste into your logged-in browser if needed):\n${url}`,
              ),
            ])
          },
        })
        await getMCPClient(serverConfig, { authProvider })
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            `✓ Connected to ${serverName}. MCP tools from this server are now available.`,
          ),
        ])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(`Failed to connect to ${serverName}: ${message}`),
        ])
      }
    },
  }),
  defineCommandWithArgs({
    name: 'disconnect:mcp',
    handler: (params, args) => {
      const serverNameOrUrl = args.trim()
      const inputText = params.inputValue.trim()
      params.saveToHistory(inputText)
      clearInput(params)

      if (serverNameOrUrl) {
        // Accept either a server name (from mcp.json) or a direct URL.
        // Also resolve the full MCPConfig so we can clear the in-memory client.
        let serverUrl = serverNameOrUrl
        let resolvedConfig: ReturnType<typeof loadMCPConfigSync>['mcpServers'][string] | undefined
        if (!serverNameOrUrl.startsWith('http')) {
          const mcpConfig = loadMCPConfigSync({ verbose: false })
          const config = mcpConfig.mcpServers[serverNameOrUrl]
          if (config && config.type !== 'stdio') {
            serverUrl = config.url
            resolvedConfig = config
          }
        } else {
          // When a bare URL is passed, find the matching config by URL so we
          // can also clear the in-memory cached client (not just on-disk creds).
          const mcpConfig = loadMCPConfigSync({ verbose: false })
          resolvedConfig = Object.values(mcpConfig.mcpServers).find(
            (config) => config.type !== 'stdio' && config.url === serverNameOrUrl,
          )
        }

        const connections = getMcpOAuthStatus()
        const match = connections.find((c) => c.serverUrl === serverUrl)
        if (!match) {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(inputText),
            getSystemMessage(
              `No MCP OAuth credentials found for: ${serverNameOrUrl}`,
            ),
          ])
          return
        }
        // Clear on-disk OAuth credentials AND the in-memory cached client so
        // the next connection attempt starts completely fresh (no zombie client).
        clearMcpOAuthCredentials(serverUrl)
        if (resolvedConfig) {
          clearMCPClient(resolvedConfig)
        }
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(
            `Cleared MCP OAuth credentials for ${serverNameOrUrl}. You will be prompted to re-authenticate next time this server is used.`,
          ),
        ])
      } else {
        const connections = getMcpOAuthStatus()
        if (connections.length === 0) {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(inputText),
            getSystemMessage('No MCP OAuth credentials to clear.'),
          ])
          return
        }
        // Clear all on-disk credentials and all in-memory clients.
        clearMcpOAuthCredentials()
        const mcpConfig = loadMCPConfigSync({ verbose: false })
        for (const config of Object.values(mcpConfig.mcpServers)) {
          if (config.type !== 'stdio') {
            clearMCPClient(config)
          }
        }
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(inputText),
          getSystemMessage(
            `Cleared OAuth credentials for ${connections.length} MCP server${connections.length === 1 ? '' : 's'}. You will be prompted to re-authenticate next time these servers are used.`,
          ),
        ])
      }
    },
  }),
  defineCommand({
    name: 'history',
    aliases: ['chats'],
    handler: (params) => {
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openChatHistory: true }
    },
  }),
  defineCommandWithArgs({
    name: 'interview',
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildInterviewPrompt(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter interview mode
      useChatStore.getState().setInputMode('interview')
    },
  }),
  defineCommandWithArgs({
    name: 'plan',
    handler: (params, args) => {
      // In freebuff mode, require ChatGPT connection
      if (IS_FREEBUFF && !getChatGptOAuthStatus().connected) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            'Connect your ChatGPT account to use /plan. Use /connect:chatgpt to get started.',
          ),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        useChatStore.getState().setInputMode('connect:chatgpt')
        return
      }

      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided plan text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildPlanPrompt(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter plan mode
      useChatStore.getState().setInputMode('plan')
    },
  }),
  defineCommandWithArgs({
    name: 'review',
    handler: (params, args) => {
      // In freebuff mode, require ChatGPT connection
      if (IS_FREEBUFF && !getChatGptOAuthStatus().connected) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            'Connect your ChatGPT account to use /review. Use /connect:chatgpt to get started.',
          ),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        useChatStore.getState().setInputMode('connect:chatgpt')
        return
      }

      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided review text directly, send it immediately without showing the screen
      if (trimmedArgs) {
        params.sendMessage({
          content: buildReviewPromptFromArgs(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise open the selection UI
      return { openReviewScreen: true }
    },
  }),
  // SPARROW: /telemetry status|enable|disable|dataset|capture-prompts|debug|help
  defineCommandWithArgs({
    name: 'telemetry',
    handler: async (params, args) => {
      // Redact sensitive args + clear input synchronously so the user gets
      // immediate feedback; the async config mutation + reinit resolves after.
      const trimmed = params.inputValue.trim()
      const shouldRedact = /^\/telemetry\s+(enable|on|dataset)\s+\S/i.test(
        trimmed,
      )
      params.saveToHistory(shouldRedact ? '/telemetry status' : trimmed)
      clearInput(params)

      const { postUserMessage } = await handleTelemetry(args)
      params.setMessages((prev) => postUserMessage(prev))
    },
  }),
  defineCommand({
    name: 'theme:toggle',
    handler: (params) => {
      const { theme, setThemeName } = useThemeStore.getState()
      const newTheme = theme.name === 'dark' ? 'light' : 'dark'
      setThemeName(newTheme)
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(`Switched to ${newTheme} theme.`),
      ])
      clearInput(params)
    },
  }),
]

export const COMMAND_REGISTRY: CommandDefinition[] = IS_FREEBUFF
  ? ALL_COMMANDS.filter((cmd) => !FREEBUFF_REMOVED_COMMANDS.has(cmd.name))
  : ALL_COMMANDS.filter((cmd) => !FREEBUFF_ONLY_COMMANDS.has(cmd.name))

export function findCommand(cmd: string): CommandDefinition | undefined {
  const lowerCmd = cmd.toLowerCase()

  // First check the static command registry
  const staticCommand = COMMAND_REGISTRY.find(
    (def) => def.name === lowerCmd || def.aliases.includes(lowerCmd),
  )
  if (staticCommand) {
    return staticCommand
  }

  // Check if this is a skill command (prefixed with "skill:")
  if (lowerCmd.startsWith('skill:')) {
    const skillName = lowerCmd.slice('skill:'.length)
    const skill = getSkillByName(skillName)
    if (skill) {
      return createSkillCommand(skill.name)
    }
  }

  return undefined
}


/**
 * Creates a dynamic command definition for a skill.
 * When invoked, the skill's content is sent to the agent.
 */
function createSkillCommand(skillName: string): CommandDefinition {
  return defineCommandWithArgs({
    name: skillName,
    handler: (params, args) => {
      const skill = getSkillByName(skillName)
      if (!skill) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Skill not found: ${skillName}`),
        ])
        params.saveToHistory(params.inputValue.trim())
        params.setInputValue({
          text: '',
          cursorPosition: 0,
          lastEditDueToNav: false,
        })
        return
      }

      const trimmed = params.inputValue.trim()
      params.saveToHistory(trimmed)
      params.setInputValue({
        text: '',
        cursorPosition: 0,
        lastEditDueToNav: false,
      })

      // Build the message content with skill context and optional user args
      const skillContext = `<skill name="${skill.name}">
${skill.content}
</skill>`

      const userPrompt =
        `I invoke the following skill:\n\n${skillContext}\n\n` +
        (args.trim() ? `User request: ${args.trim()}` : '')

      // Check streaming/queue state
      if (
        params.isStreaming ||
        params.streamMessageIdRef.current ||
        params.isChainInProgressRef.current
      ) {
        const pendingAttachments = capturePendingAttachments()
        params.addToQueue(userPrompt, pendingAttachments)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      params.sendMessage({
        content: userPrompt,
        agentMode: params.agentMode,
      })
      setTimeout(() => {
        params.scrollToLatest()
      }, 0)
    },
  })
}
