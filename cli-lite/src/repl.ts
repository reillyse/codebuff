import { createInterface } from 'readline'

import { CodebuffClient, getClaudeOAuthCredentials, getValidClaudeOAuthCredentials, setClaudeOAuthFallbackEnabled } from '@codebuff/sdk'

import {
  getHippoContext,
  storeRunToHippo,
  storeErrorToHippo,
  generateHippoSessionId,
  isHippoAvailable,
  checkHippoConnection,
  saveHippoEnabled,
  HIPPO_BINARY,
} from './hippo'
import {
  printBanner,
  printDivider,
  printError,
  printFinish,
  printToolCall,
  printToolResult,
  printSubagentStart,
  printSubagentEnd,
} from './output'
import { logPrompt, logResponse, isPromptLoggingEnabled, getPromptLogPath } from './prompt-logger'
import { initializeAgentRegistry, getAgentDefinitions, getAgentSummary, getAgentList, getAgentById, getAgentSource } from './agent-registry'
import { createMarkdownStream } from './markdown'
import { writeOut, writeErr } from './tty'

import type { AgentMode } from './hippo'
import type { PrintModeEvent, RunState } from '@codebuff/sdk'

interface ReplOptions {
  apiKey: string
  agent: string
  cwd: string
  verbose: boolean
}

function getTerminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }
}

function getDefaultMode(): AgentMode {
  const envMode = process.env.CODEBUFF_DEFAULT_MODE?.toUpperCase()
  if (envMode === 'DEFAULT' || envMode === 'MAX' || envMode === 'PLAN') return envMode
  if (process.env.CODEBUFF_DEFAULT_MODE) {
    writeErr(`Warning: Unknown CODEBUFF_DEFAULT_MODE '${process.env.CODEBUFF_DEFAULT_MODE}'. Using MAX. Valid: default, max, plan\n`)
  }
  return 'MAX'
}

export const DEFAULT_AGENT_MODE: AgentMode = getDefaultMode()

const AGENT_MODE_TO_ID: Partial<Record<AgentMode, string>> & Record<'DEFAULT' | 'MAX' | 'PLAN', string> = {
  DEFAULT: 'codebuff/base2@latest',
  MAX: 'codebuff/base2-max@latest',
  PLAN: 'codebuff/base2-plan@latest',
}

const WEBSITE_URL = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ?? 'https://www.codebuff.com'

export function getAgentForMode(mode: AgentMode): string {
  return AGENT_MODE_TO_ID[mode] ?? AGENT_MODE_TO_ID.DEFAULT
}

function getModePrompt(mode: AgentMode): string {
  if (mode === 'DEFAULT') return '> '
  return `[${mode}] > `
}

function createSpinner() {
  return {
    start(message = 'Thinking...') {
      writeErr(message + '\n')
    },
    stop() {},
  }
}

async function checkClaudeSubscription(): Promise<{ configured: boolean; valid: boolean }> {
  const credentials = getClaudeOAuthCredentials()
  if (!credentials) return { configured: false, valid: true }

  const valid = await getValidClaudeOAuthCredentials()
  if (valid) return { configured: true, valid: true }

  printError(
    'Claude subscription credentials expired.\n' +
    'Reconnect your Claude account using /connect:claude in the main Codebuff CLI.',
  )
  return { configured: true, valid: false }
}

/**
 * Fetch hippo context for a prompt and return the enriched prompt.
 * Shows a "Searching memory..." indicator on stderr while fetching.
 */
async function enrichPromptWithHippo(
  prompt: string,
  previousRun: RunState | undefined,
  sessionId: string,
): Promise<string> {
  if (!isHippoAvailable()) return prompt

  writeErr('Searching memory...\n')

  const hippoResult = await getHippoContext(
    prompt,
    previousRun ?? null,
    sessionId,
  )

  if (hippoResult.context) {
    writeErr('Found relevant context from past sessions.\n')
    return `## Relevant Context from Past Sessions\n${hippoResult.context}\n\n${prompt}`
  }

  return prompt
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { apiKey, cwd, verbose } = options

  // Initialize agent registry (loads bundled + user agents, MCP, skills)
  await initializeAgentRegistry()
  const agentDefinitions = getAgentDefinitions()

  const termSize = getTerminalSize()
  const client = new CodebuffClient({ apiKey, cwd, agentDefinitions, terminalColumns: termSize.columns, terminalRows: termSize.rows })

  let currentMode: AgentMode = DEFAULT_AGENT_MODE

  printBanner()

  const agentSummary = getAgentSummary()
  if (agentSummary) {
    writeErr(agentSummary + '\n')
  }

  writeErr(`Mode: ${currentMode}\n`)
  writeErr(`Terminal: ${termSize.columns}x${termSize.rows}\n`)

  if (isHippoAvailable()) {
    writeErr('Hippo memory: enabled\n')
  }

  if (isPromptLoggingEnabled()) {
    writeErr(`Prompt logging: ${getPromptLogPath()}\n`)
  }

  const claude = await checkClaudeSubscription()
  if (!claude.valid) process.exit(1)
  if (claude.configured) {
    setClaudeOAuthFallbackEnabled(false)
    writeErr('Claude subscription: connected\n')
  }

  writeErr('\n')

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: getModePrompt(currentMode),
    terminal: process.stdin.isTTY ?? false,
  })

  let previousRun: RunState | undefined
  let running = false
  let abortController: AbortController | undefined
  let sessionId = generateHippoSessionId(currentMode)

  const runPrompt = async (prompt: string): Promise<void> => {
    if (!prompt.trim()) return

    running = true

    // Per-prompt credential check: validate Claude OAuth before each prompt
    const claudeCheck = await checkClaudeSubscription()
    if (!claudeCheck.valid) {
      running = false
      return
    }
    abortController = new AbortController()
    printDivider()
    writeOut('\n')

    const startTime = Date.now()
    let lastTotalCost = 0
    const streamedChunks: string[] = []

    const spinner = createSpinner()
    spinner.start()
    const md = createMarkdownStream()

    try {
      // Enrich prompt with hippo context
      const enrichedPrompt = await enrichPromptWithHippo(prompt, previousRun, sessionId)

      // Log the complete prompt to file if enabled
      logPrompt({
        prompt,
        enrichedPrompt,
        sessionId,
        agentMode: currentMode,
      })

      const { columns, rows } = getTerminalSize()
      const result = await client.run({
        agent: getAgentForMode(currentMode),
        prompt: enrichedPrompt,
        previousRun,
        signal: abortController.signal,
        terminalColumns: columns,
        terminalRows: rows,
        handleEvent: (event) => {
          if (event.type === 'finish') {
            lastTotalCost = event.totalCost
          }
          spinner.stop()
          handleEvent(event, verbose)
          if (event.type === 'subagent_start') {
            const modelSuffix = event.model ? ` (${event.model})` : ''
            spinner.start(`Agent: ${event.displayName}${modelSuffix}...`)
          } else if (event.type === 'tool_call') {
            spinner.start(`Tool: ${event.toolName}...`)
          }
        },
        handleStreamChunk: (chunk) => {
          if (typeof chunk === 'string') {
            spinner.stop()
            streamedChunks.push(chunk)
            const formatted = md.write(chunk)
            if (formatted) writeOut(formatted)
          } else if (chunk.type === 'subagent_chunk') {
            if (verbose) {
              spinner.stop()
              writeErr(chunk.chunk)
            }
          }
        },
      })

      spinner.stop()
      const remaining = md.flush()
      if (remaining) writeOut(remaining)
      previousRun = result

      writeOut('\n\n')

      const elapsedMs = Date.now() - startTime

      if (result.output.type === 'error') {
        printError(result.output.message)
      }

      // Log the response to file if enabled
      logResponse({
        prompt,
        sessionId,
        agentMode: currentMode,
        streamedText: streamedChunks.join(''),
        elapsedMs,
        totalCost: lastTotalCost,
        outputType: result.output.type,
        errorMessage: result.output.type === 'error' ? result.output.message : undefined,
      })

      // Store successful run to hippo (background, non-blocking)
      storeRunToHippo({
        runState: result,
        prompt,
        agentMode: currentMode,
        elapsedMs,
        sessionId,
      })
    } catch (error) {
      spinner.stop()
      const elapsedMs = Date.now() - startTime

      if (error instanceof Error && error.name === 'AbortError') {
        writeErr('\n')

        logResponse({
          prompt,
          sessionId,
          agentMode: currentMode,
          streamedText: streamedChunks.join(''),
          elapsedMs,
          outputType: 'cancelled',
        })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        printError(message)

        // Log the error response
        logResponse({
          prompt,
          sessionId,
          agentMode: currentMode,
          streamedText: streamedChunks.join(''),
          elapsedMs,
          outputType: 'error',
          errorMessage: message,
        })

        // Store error to hippo (background, non-blocking)
        storeErrorToHippo({
          error,
          sessionId,
          elapsedMs,
        })
      }
    } finally {
      spinner.stop()
      running = false
      abortController = undefined
    }
  }

  // Debounce input lines so pasted multiline text is treated as a single prompt
  // instead of firing separate agent invocations per line.
  const PASTE_DEBOUNCE_MS = 200
  let lineBuffer: string[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const handleSingleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim()

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
      rl.close()
      return
    }

    if (trimmed === '/new' || trimmed === '/clear') {
      previousRun = undefined
      currentMode = DEFAULT_AGENT_MODE
      sessionId = generateHippoSessionId(currentMode)
      rl.setPrompt(getModePrompt(currentMode))
      writeErr('Conversation cleared.\n\n')
      rl.prompt()
      return
    }

    if (trimmed === '/help') {
      printHelp()
      rl.prompt()
      return
    }

    if (trimmed === '/agents') {
      printAgents()
      rl.prompt()
      return
    }

    if (trimmed.startsWith('/agent:')) {
      const agentId = trimmed.slice('/agent:'.length).trim()
      printAgentDetail(agentId)
      rl.prompt()
      return
    }

    // Mode commands
    if (trimmed === '/mode') {
      writeErr(`Current mode: ${currentMode}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed.startsWith('/mode:')) {
      const modeArg = trimmed.slice('/mode:'.length).toUpperCase()
      if (modeArg !== 'DEFAULT' && modeArg !== 'MAX' && modeArg !== 'PLAN') {
        writeErr(`Unknown mode: ${modeArg}. Available: default, max, plan\n\n`)
        rl.prompt()
        return
      }
      currentMode = modeArg
      sessionId = generateHippoSessionId(currentMode)
      rl.setPrompt(getModePrompt(currentMode))
      writeErr(`Mode set to ${currentMode}.\n\n`)
      rl.prompt()
      return
    }

    // Usage command
    if (trimmed === '/usage') {
      await handleUsageCommand(apiKey)
      rl.prompt()
      return
    }

    // Review command
    if (trimmed === '/review' || trimmed.startsWith('/review ')) {
      const reviewArgs = trimmed.slice('/review'.length).trim()
      const reviewPrompt = reviewArgs
        ? `@GPT-5 Agent Please review: ${reviewArgs}`
        : '@GPT-5 Agent Please review: uncommitted changes'
      await runPrompt(reviewPrompt)
      rl.prompt()
      return
    }

    // Hippo commands
    if (trimmed === '/hippo:status') {
      await handleHippoStatus()
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:on') {
      saveHippoEnabled(true)
      writeErr('Hippo memory enabled.\n\n')
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:off') {
      saveHippoEnabled(false)
      writeErr('Hippo memory disabled.\n\n')
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:retry') {
      const result = await checkHippoConnection()
      if (result.connectionOk) {
        writeErr('Hippo connection OK.\n\n')
      } else {
        writeErr(`Hippo connection failed: ${result.lastError ?? 'unknown'}\n\n`)
      }
      rl.prompt()
      return
    }

    if (trimmed === '') {
      rl.prompt()
      return
    }

    await runPrompt(trimmed)
    rl.prompt()
  }

  rl.prompt()

  rl.on('line', (line: string) => {
    if (running) return

    lineBuffer.push(line)

    if (debounceTimer !== undefined) clearTimeout(debounceTimer)

    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined
      const lines = lineBuffer
      lineBuffer = []

      if (running) return

      if (lines.length === 1) {
        await handleSingleLine(lines[0])
        return
      }

      // Multiline paste: combine all lines into a single prompt
      const combined = lines.join('\n').trim()
      if (!combined) {
        rl.prompt()
        return
      }

      await runPrompt(combined)
      rl.prompt()
    }, PASTE_DEBOUNCE_MS)
  })

  process.stdout.on('resize', () => {
    const { columns, rows } = getTerminalSize()
    if (verbose) {
      writeErr(`Terminal resized: ${columns}x${rows}\n`)
    }
  })

  rl.on('close', () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    writeErr('\nGoodbye!\n')
    process.exit(0)
  })

  rl.on('SIGINT', () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    lineBuffer = []
    if (running && abortController) {
      abortController.abort()
      writeErr('\n(Cancelled)\n')
    } else {
      rl.close()
    }
  })
}

export async function runOnce(options: ReplOptions & { prompt: string }): Promise<void> {
  const { apiKey, agent, cwd, verbose, prompt } = options

  await initializeAgentRegistry()
  const agentDefinitions = getAgentDefinitions()

  const claude = await checkClaudeSubscription()
  if (!claude.valid) process.exit(1)
  if (claude.configured) {
    setClaudeOAuthFallbackEnabled(false)
  }

  const { columns, rows } = getTerminalSize()
  const client = new CodebuffClient({ apiKey, cwd, agentDefinitions, terminalColumns: columns, terminalRows: rows })
  const abortController = new AbortController()
  const sessionId = generateHippoSessionId(DEFAULT_AGENT_MODE)
  const startTime = Date.now()
  let lastTotalCost = 0
  const streamedChunks: string[] = []

  const spinner = createSpinner()
  spinner.start()
  const md = createMarkdownStream()

  const onSigint = () => {
    abortController.abort()
  }
  process.on('SIGINT', onSigint)

  try {
    // Enrich prompt with hippo context
    const enrichedPrompt = await enrichPromptWithHippo(prompt, undefined, sessionId)

    // Log the complete prompt to file if enabled
    logPrompt({
      prompt,
      enrichedPrompt,
      sessionId,
      agentMode: DEFAULT_AGENT_MODE,
    })

    const result = await client.run({
      agent,
      prompt: enrichedPrompt,
      signal: abortController.signal,
      terminalColumns: columns,
      terminalRows: rows,
      handleEvent: (event) => {
        if (event.type === 'finish') {
          lastTotalCost = event.totalCost
        }
        spinner.stop()
        handleEvent(event, verbose)
        if (event.type === 'subagent_start') {
          const modelSuffix = event.model ? ` (${event.model})` : ''
          spinner.start(`Agent: ${event.displayName}${modelSuffix}...`)
        } else if (event.type === 'tool_call') {
          spinner.start(`Tool: ${event.toolName}...`)
        }
      },
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          spinner.stop()
          streamedChunks.push(chunk)
          const formatted = md.write(chunk)
          if (formatted) writeOut(formatted)
        }
      },
    })

    spinner.stop()
    const remaining = md.flush()
    if (remaining) writeOut(remaining)
    writeOut('\n')

    const elapsedMs = Date.now() - startTime

    // Log the response to file if enabled
    logResponse({
      prompt,
      sessionId,
      agentMode: DEFAULT_AGENT_MODE,
      streamedText: streamedChunks.join(''),
      elapsedMs,
      totalCost: lastTotalCost,
      outputType: result.output.type,
      errorMessage: result.output.type === 'error' ? result.output.message : undefined,
    })

    // Store run to hippo (background, non-blocking)
    storeRunToHippo({
      runState: result,
      prompt,
      agentMode: DEFAULT_AGENT_MODE,
      elapsedMs,
      sessionId,
    })

    if (result.output.type === 'error') {
      printError(result.output.message)
      process.exit(1)
    }
  } catch (error) {
    spinner.stop()
    const elapsedMs = Date.now() - startTime

    if (error instanceof Error && error.name === 'AbortError') {
      writeErr('\nCancelled.\n')

      logResponse({
        prompt,
        sessionId,
        agentMode: DEFAULT_AGENT_MODE,
        streamedText: streamedChunks.join(''),
        elapsedMs,
        outputType: 'cancelled',
      })

      process.exit(130)
    }

    const message = error instanceof Error ? error.message : String(error)
    printError(message)

    logResponse({
      prompt,
      sessionId,
      agentMode: DEFAULT_AGENT_MODE,
      streamedText: streamedChunks.join(''),
      elapsedMs,
      outputType: 'error',
      errorMessage: message,
    })

    // Store error to hippo
    storeErrorToHippo({
      error,
      sessionId,
      elapsedMs,
    })

    process.exit(1)
  } finally {
    spinner.stop()
    process.off('SIGINT', onSigint)
  }
}

function handleEvent(event: PrintModeEvent, verbose: boolean): void {
  if (event.type === 'error') {
    printError(event.message)
    return
  }
  if (!verbose) return

  switch (event.type) {
    case 'tool_call':
      printToolCall(event.toolName, event.input)
      break
    case 'tool_result': {
      const hasError = event.output.some(
        (o) => o.type === 'json' && o.value && typeof o.value === 'object' && 'errorMessage' in o.value,
      )
      printToolResult(event.toolName, !hasError)
      break
    }
    case 'subagent_start':
      printSubagentStart(event.agentId, event.displayName, event.model)
      break
    case 'subagent_finish':
      printSubagentEnd(event.agentId)
      break
    case 'finish':
      printFinish(event.totalCost)
      break
    default:
      break
  }
}

async function handleHippoStatus(): Promise<void> {
  const available = isHippoAvailable()
  const { connectionOk, lastError } = available
    ? await checkHippoConnection()
    : { connectionOk: false, lastError: 'Hippo not available' }

  const lines = [
    `Hippo memory: ${available ? 'enabled' : 'disabled'}`,
    `Binary: ${HIPPO_BINARY}`,
    `Connection: ${connectionOk ? 'connected' : (lastError ?? 'disconnected')}`,
  ]

  writeErr(lines.join('\n') + '\n\n')
}

function printAgents(): void {
  const agents = getAgentList()

  if (agents.length === 0) {
    writeErr('No agents loaded.\n\n')
    return
  }

  const bundled = agents.filter((a) => a.source === 'bundled')
  const user = agents.filter((a) => a.source === 'user')

  writeErr('\n')

  if (bundled.length > 0) {
    writeErr(`Bundled Agents (${bundled.length})\n`)
    for (const agent of bundled) {
      writeErr(`  ${agent.displayName} (${agent.id})\n`)
    }
    writeErr('\n')
  }

  if (user.length > 0) {
    writeErr(`User Agents (${user.length})\n`)
    for (const agent of user) {
      writeErr(`  ${agent.displayName} (${agent.id})\n`)
    }
    writeErr('\n')
  }
}

function printAgentDetail(id: string): void {
  const agent = getAgentById(id)
  if (!agent) {
    writeErr(`Agent not found: ${id}\n`)
    writeErr('Use /agents to see all available agents.\n\n')
    return
  }

  const source = getAgentSource(id)
  const sourceLabel = source === 'user' ? 'user' : 'bundled'

  writeErr('\n')
  writeErr(`${agent.displayName ?? id} (${id})\n`)
  writeErr(`${'-'.repeat(40)}\n`)

  writeErr(`  Source:        ${sourceLabel}\n`)
  writeErr(`  Model:         ${String(agent.model ?? 'default')}\n`)
  writeErr(`  Output mode:   ${agent.outputMode ?? 'last_message'}\n`)

  // Tools
  const tools = agent.toolNames ?? []
  writeErr(`  Tools:         ${tools.length > 0 ? tools.join(', ') : 'none'}\n`)

  // Spawnable agents
  const spawnable = agent.spawnableAgents ?? []
  if (spawnable.length > 0) {
    writeErr(`  Spawnable:     ${spawnable.join(', ')}\n`)
  } else {
    writeErr(`  Spawnable:     none\n`)
  }

  // MCP servers
  const mcpKeys = Object.keys(agent.mcpServers ?? {})
  if (mcpKeys.length > 0) {
    writeErr(`  MCP servers:   ${mcpKeys.join(', ')}\n`)
  }

  // Flags
  const flags: string[] = []
  if (agent.includeMessageHistory) flags.push('includeMessageHistory')
  if (agent.inheritParentSystemPrompt) flags.push('inheritParentSystemPrompt')
  if (flags.length > 0) {
    writeErr(`  Flags:         ${flags.join(', ')}\n`)
  }

  // Spawner prompt (description)
  if (agent.spawnerPrompt) {
    const desc = agent.spawnerPrompt.length > 200
      ? agent.spawnerPrompt.slice(0, 200) + '...'
      : agent.spawnerPrompt
    writeErr('\n')
    writeErr('  Description:\n')
    writeErr(`  ${desc}\n`)
  }

  writeErr('\n')
}

async function handleUsageCommand(apiKey: string): Promise<void> {
  writeErr('Fetching usage...\n')

  try {
    const res = await fetch(`${WEBSITE_URL}/api/v1/usage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      writeErr(`Failed to fetch usage (HTTP ${res.status})\n\n`)
      return
    }

    const data = (await res.json()) as {
      usage?: number
      remainingBalance?: number | null
      balanceBreakdown?: Record<string, number>
      next_quota_reset?: string | null
    }

    writeErr('\n')
    writeErr('Credit Usage\n')
    writeErr(`${'-'.repeat(40)}\n`)

    if (typeof data.usage === 'number') {
      writeErr(`  Session credits used:  ${data.usage.toLocaleString()}\n`)
    }

    if (data.remainingBalance != null) {
      writeErr(`  Remaining balance:    ${data.remainingBalance.toLocaleString()}\n`)
    }

    if (data.balanceBreakdown && Object.keys(data.balanceBreakdown).length > 0) {
      writeErr('\n  Balance breakdown:\n')
      for (const [source, amount] of Object.entries(data.balanceBreakdown)) {
        writeErr(`    ${source}:  ${amount.toLocaleString()}\n`)
      }
    }

    if (data.next_quota_reset) {
      const resetDate = new Date(data.next_quota_reset)
      writeErr(`\n  Next reset:           ${resetDate.toLocaleDateString()}\n`)
    }

    writeErr('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`Failed to fetch usage: ${message}\n\n`)
  }
}

function printHelp(): void {
  writeErr(`
Commands
  /new, /clear       Clear conversation and start fresh
  /mode              Show current agent mode
  /mode:default      Switch to DEFAULT mode
  /mode:max          Switch to MAX mode (more powerful, costs more)
  /mode:plan         Switch to PLAN mode
  /usage             Show credit usage and remaining balance
  /review [text]     Review code (defaults to uncommitted changes)
  /agents            List all loaded agents
  /agent:<id>        Show detailed info about an agent
  /help              Show this help message
  /exit, /quit       Exit the CLI

Hippo Memory
  /hippo:status      Show hippo memory status
  /hippo:on          Enable hippo memory
  /hippo:off         Disable hippo memory
  /hippo:retry       Test hippo connection

Environment Variables
  CODEBUFF_DEFAULT_MODE Set default agent mode (default, max, plan). Default: max
  CODEBUFF_VERBOSE      Verbose output (default: enabled, set to '0' to disable)
  CODEBUFF_PROMPT_LOG   Log prompts and responses to a file (rolling, 5MB limit)
                        Set to '1' for ./debug/prompt-log.txt, or a custom path

Usage
  Type your prompt and press Enter to send.
  The agent will stream its response to stdout.
  Tool calls and status are shown on stderr (use -v flag or CODEBUFF_VERBOSE env var).

`)
}
