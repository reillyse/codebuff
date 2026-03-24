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
  dim,
  green,
  yellow,
  cyan,
  bold,
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
    writeErr(`\x1b[33mWarning: Unknown CODEBUFF_DEFAULT_MODE '${process.env.CODEBUFF_DEFAULT_MODE}'. Using MAX. Valid: default, max, plan\x1b[0m\n`)
  }
  return 'MAX'
}

export const DEFAULT_AGENT_MODE: AgentMode = getDefaultMode()

const AGENT_MODE_TO_ID: Partial<Record<AgentMode, string>> & Record<'DEFAULT' | 'MAX' | 'PLAN', string> = {
  DEFAULT: 'codebuff/base2@latest',
  MAX: 'codebuff/base2-max@latest',
  PLAN: 'codebuff/base2-plan@latest',
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const WEBSITE_URL = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ?? 'https://www.codebuff.com'

export function getAgentForMode(mode: AgentMode): string {
  return AGENT_MODE_TO_ID[mode] ?? AGENT_MODE_TO_ID.DEFAULT
}

function getModePrompt(mode: AgentMode): string {
  if (mode === 'DEFAULT') return `${cyan(bold('> '))}`
  return `${dim(`[${mode}]`)} ${cyan(bold('> '))}`
}

function createSpinner() {
  let timer: NodeJS.Timeout | null = null
  return {
    start(message = 'Thinking...') {
      if (timer) clearInterval(timer)
      let i = 0
      timer = setInterval(() => {
        const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length]
        writeErr(`\r\x1b[2m${frame} ${message}\x1b[0m\x1b[K`)
        i++
      }, 80)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        writeErr('\r\x1b[K')
      }
    },
  }
}

async function checkClaudeSubscription(): Promise<{ configured: boolean; valid: boolean }> {
  const credentials = getClaudeOAuthCredentials()
  if (!credentials) return { configured: false, valid: true }

  const valid = await getValidClaudeOAuthCredentials()
  if (valid) return { configured: true, valid: true }

  printError(
    'Claude subscription credentials are expired and could not be refreshed.\n' +
    'To fix this, reconnect your Claude account using /connect:claude in the main Codebuff CLI,\n' +
    'or remove your Claude OAuth credentials to use Codebuff credits instead.',
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

  writeErr(dim('Searching memory...'))

  const hippoResult = await getHippoContext(
    prompt,
    previousRun ?? null,
    sessionId,
  )

  // Clear the "Searching memory..." line (cursor control only, no newlines)
  writeErr('\r\x1b[K')

  if (hippoResult.context) {
    writeErr(dim('Found relevant context from past sessions.') + '\n')
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
    writeErr(dim(agentSummary) + '\n')
  }

  writeErr(dim(`Mode: ${currentMode}`) + '\n')
  writeErr(dim(`Terminal: ${termSize.columns}×${termSize.rows}`) + '\n')

  if (isHippoAvailable()) {
    writeErr(dim('Hippo memory: enabled') + '\n')
  }

  if (isPromptLoggingEnabled()) {
    writeErr(dim(`Prompt logging: ${getPromptLogPath()}`) + '\n')
  }

  const claude = await checkClaudeSubscription()
  if (!claude.valid) process.exit(1)
  if (claude.configured) {
    setClaudeOAuthFallbackEnabled(false)
    writeErr(dim('Claude subscription: connected') + '\n')
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

    // Per-prompt credential check: validate Claude OAuth before each prompt
    const claudeCheck = await checkClaudeSubscription()
    if (!claudeCheck.valid) return

    running = true
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
            spinner.start('Agent thinking...')
          } else if (event.type === 'tool_call') {
            spinner.start('Running tool...')
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
              writeErr(dim(chunk.chunk))
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

  rl.prompt()

  rl.on('line', async (line: string) => {
    if (running) return

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
      writeErr(`${green('Conversation cleared.')}\n\n`)
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
      writeErr(`Current mode: ${bold(currentMode)}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed.startsWith('/mode:')) {
      const modeArg = trimmed.slice('/mode:'.length).toUpperCase()
      if (modeArg !== 'DEFAULT' && modeArg !== 'MAX' && modeArg !== 'PLAN') {
        writeErr(yellow(`Unknown mode: ${modeArg}. Available: default, max, plan`) + '\n\n')
        rl.prompt()
        return
      }
      currentMode = modeArg
      sessionId = generateHippoSessionId(currentMode)
      rl.setPrompt(getModePrompt(currentMode))
      writeErr(`${green(`Mode set to ${currentMode}.`)}\n\n`)
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
      writeErr(`${green('Hippo memory enabled.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:off') {
      saveHippoEnabled(false)
      writeErr(`${yellow('Hippo memory disabled.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:retry') {
      const result = await checkHippoConnection()
      if (result.connectionOk) {
        writeErr(`${green('Hippo connection OK.')}\n\n`)
      } else {
        writeErr(`${yellow(`Hippo connection failed: ${result.lastError ?? 'unknown'}`)}\n\n`)
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
  })

  process.stdout.on('resize', () => {
    const { columns, rows } = getTerminalSize()
    if (verbose) {
      writeErr(dim(`Terminal resized: ${columns}×${rows}`) + '\n')
    }
  })

  rl.on('close', () => {
    writeErr('\nGoodbye!\n')
    process.exit(0)
  })

  rl.on('SIGINT', () => {
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
          spinner.start('Agent thinking...')
        } else if (event.type === 'tool_call') {
          spinner.start('Running tool...')
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
      printSubagentStart(event.agentId, event.agentType)
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
    `Connection: ${connectionOk ? green('connected') : yellow(lastError ?? 'disconnected')}`,
  ]

  writeErr(lines.join('\n') + '\n\n')
}

function printAgents(): void {
  const agents = getAgentList()

  if (agents.length === 0) {
    writeErr(dim('No agents loaded.') + '\n\n')
    return
  }

  const bundled = agents.filter((a) => a.source === 'bundled')
  const user = agents.filter((a) => a.source === 'user')

  writeErr('\n')

  if (bundled.length > 0) {
    writeErr(bold('Bundled Agents') + dim(` (${bundled.length})`) + '\n')
    for (const agent of bundled) {
      const name = cyan(agent.displayName)
      const id = dim(` (${agent.id})`)
      writeErr(`  ${name}${id}\n`)
    }
    writeErr('\n')
  }

  if (user.length > 0) {
    writeErr(bold('User Agents') + dim(` (${user.length})`) + '\n')
    for (const agent of user) {
      const name = green(agent.displayName)
      const id = dim(` (${agent.id})`)
      writeErr(`  ${name}${id}\n`)
    }
    writeErr('\n')
  }
}

function printAgentDetail(id: string): void {
  const agent = getAgentById(id)
  if (!agent) {
    writeErr(yellow(`Agent not found: ${id}`) + '\n')
    writeErr(dim('Use /agents to see all available agents.') + '\n\n')
    return
  }

  const source = getAgentSource(id)
  const sourceLabel = source === 'user' ? green('user') : cyan('bundled')

  writeErr('\n')
  writeErr(bold(agent.displayName ?? id) + dim(` (${id})`) + '\n')
  writeErr(dim('─'.repeat(40)) + '\n')

  writeErr(`  ${dim('Source:')}        ${sourceLabel}\n`)
  writeErr(`  ${dim('Model:')}         ${String(agent.model ?? 'default')}\n`)
  writeErr(`  ${dim('Output mode:')}   ${agent.outputMode ?? 'last_message'}\n`)

  // Tools
  const tools = agent.toolNames ?? []
  writeErr(`  ${dim('Tools:')}         ${tools.length > 0 ? tools.join(', ') : dim('none')}\n`)

  // Spawnable agents
  const spawnable = agent.spawnableAgents ?? []
  if (spawnable.length > 0) {
    writeErr(`  ${dim('Spawnable:')}     ${spawnable.join(', ')}\n`)
  } else {
    writeErr(`  ${dim('Spawnable:')}     ${dim('none')}\n`)
  }

  // MCP servers
  const mcpKeys = Object.keys(agent.mcpServers ?? {})
  if (mcpKeys.length > 0) {
    writeErr(`  ${dim('MCP servers:')}   ${mcpKeys.join(', ')}\n`)
  }

  // Flags
  const flags: string[] = []
  if (agent.includeMessageHistory) flags.push('includeMessageHistory')
  if (agent.inheritParentSystemPrompt) flags.push('inheritParentSystemPrompt')
  if (flags.length > 0) {
    writeErr(`  ${dim('Flags:')}         ${flags.join(', ')}\n`)
  }

  // Spawner prompt (description)
  if (agent.spawnerPrompt) {
    const desc = agent.spawnerPrompt.length > 200
      ? agent.spawnerPrompt.slice(0, 200) + '...'
      : agent.spawnerPrompt
    writeErr('\n')
    writeErr(`  ${dim('Description:')}\n`)
    writeErr(`  ${desc}\n`)
  }

  writeErr('\n')
}

async function handleUsageCommand(apiKey: string): Promise<void> {
  writeErr(dim('Fetching usage...') + '\n')

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
      writeErr(yellow(`Failed to fetch usage (HTTP ${res.status})`) + '\n\n')
      return
    }

    const data = (await res.json()) as {
      usage?: number
      remainingBalance?: number | null
      balanceBreakdown?: Record<string, number>
      next_quota_reset?: string | null
    }

    writeErr('\n')
    writeErr(bold('Credit Usage') + '\n')
    writeErr(dim('─'.repeat(40)) + '\n')

    if (typeof data.usage === 'number') {
      writeErr(`  ${dim('Session credits used:')}  ${data.usage.toLocaleString()}\n`)
    }

    if (data.remainingBalance != null) {
      writeErr(`  ${dim('Remaining balance:')}    ${data.remainingBalance.toLocaleString()}\n`)
    }

    if (data.balanceBreakdown && Object.keys(data.balanceBreakdown).length > 0) {
      writeErr('\n' + dim('  Balance breakdown:') + '\n')
      for (const [source, amount] of Object.entries(data.balanceBreakdown)) {
        writeErr(`    ${dim(source + ':')}  ${amount.toLocaleString()}\n`)
      }
    }

    if (data.next_quota_reset) {
      const resetDate = new Date(data.next_quota_reset)
      writeErr(`\n  ${dim('Next reset:')}           ${resetDate.toLocaleDateString()}\n`)
    }

    writeErr('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(yellow(`Failed to fetch usage: ${message}`) + '\n\n')
  }
}

function printHelp(): void {
  writeErr(`
${bold('Commands')}
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

${bold('Hippo Memory')}
  /hippo:status      Show hippo memory status
  /hippo:on          Enable hippo memory
  /hippo:off         Disable hippo memory
  /hippo:retry       Test hippo connection

${bold('Environment Variables')}
  CODEBUFF_DEFAULT_MODE Set default agent mode (default, max, plan). Default: max
  CODEBUFF_VERBOSE      Enable verbose output (equivalent to -v flag)
  CODEBUFF_PROMPT_LOG   Log prompts and responses to a file (rolling, 5MB limit)
                        Set to '1' for ./debug/prompt-log.txt, or a custom path

${bold('Usage')}
  Type your prompt and press Enter to send.
  The agent will stream its response to stdout.
  Tool calls and status are shown on stderr (use -v flag or CODEBUFF_VERBOSE env var).

`)
}
