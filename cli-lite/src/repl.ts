import { createInterface } from 'readline'

import { CodebuffClient } from '@codebuff/sdk'

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

import type { AgentMode } from './hippo'
import type { PrintModeEvent, RunState } from '@codebuff/sdk'

interface ReplOptions {
  apiKey: string
  agent: string
  cwd: string
  verbose: boolean
}

const DEFAULT_AGENT_MODE: AgentMode = 'DEFAULT'

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

  process.stderr.write(dim('Searching memory...'))

  const hippoResult = await getHippoContext(
    prompt,
    previousRun ?? null,
    sessionId,
  )

  // Clear the "Searching memory..." line
  process.stderr.write('\r\x1b[K')

  if (hippoResult.context) {
    process.stderr.write(dim('Found relevant context from past sessions.') + '\n')
    return `## Relevant Context from Past Sessions\n${hippoResult.context}\n\n${prompt}`
  }

  return prompt
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { apiKey, agent, cwd, verbose } = options

  const client = new CodebuffClient({ apiKey, cwd })

  printBanner()

  if (isHippoAvailable()) {
    process.stderr.write(dim('Hippo memory: enabled') + '\n')
  }

  if (isPromptLoggingEnabled()) {
    process.stderr.write(dim(`Prompt logging: ${getPromptLogPath()}`) + '\n')
  }

  process.stderr.write('\n')

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${cyan(bold('> '))}`,
    terminal: process.stdin.isTTY ?? false,
  })

  let previousRun: RunState | undefined
  let running = false
  let abortController: AbortController | undefined
  let sessionId = generateHippoSessionId(DEFAULT_AGENT_MODE)

  const runPrompt = async (prompt: string): Promise<void> => {
    if (!prompt.trim()) return

    running = true
    abortController = new AbortController()
    printDivider()
    process.stdout.write('\n')

    const startTime = Date.now()
    let lastTotalCost = 0
    const streamedChunks: string[] = []

    try {
      // Enrich prompt with hippo context
      const enrichedPrompt = await enrichPromptWithHippo(prompt, previousRun, sessionId)

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
        previousRun,
        signal: abortController.signal,
        handleEvent: (event) => {
          if (event.type === 'finish') {
            lastTotalCost = event.totalCost
          }
          handleEvent(event, verbose)
        },
        handleStreamChunk: (chunk) => {
          if (typeof chunk === 'string') {
            streamedChunks.push(chunk)
            process.stdout.write(chunk)
          } else if (chunk.type === 'subagent_chunk') {
            if (verbose) {
              process.stderr.write(dim(chunk.chunk))
            }
          }
        },
      })

      previousRun = result

      process.stdout.write('\n\n')

      const elapsedMs = Date.now() - startTime

      if (result.output.type === 'error') {
        printError(result.output.message)
      }

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

      // Store successful run to hippo (background, non-blocking)
      storeRunToHippo({
        runState: result,
        prompt,
        agentMode: DEFAULT_AGENT_MODE,
        elapsedMs,
        sessionId,
      })
    } catch (error) {
      const elapsedMs = Date.now() - startTime

      if (error instanceof Error && error.name === 'AbortError') {
        process.stderr.write('\n')

        logResponse({
          prompt,
          sessionId,
          agentMode: DEFAULT_AGENT_MODE,
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
          agentMode: DEFAULT_AGENT_MODE,
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
      sessionId = generateHippoSessionId(DEFAULT_AGENT_MODE)
      process.stderr.write(`${green('Conversation cleared.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/help') {
      printHelp()
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
      process.stderr.write(`${green('Hippo memory enabled.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:off') {
      saveHippoEnabled(false)
      process.stderr.write(`${yellow('Hippo memory disabled.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/hippo:retry') {
      const result = await checkHippoConnection()
      if (result.connectionOk) {
        process.stderr.write(`${green('Hippo connection OK.')}\n\n`)
      } else {
        process.stderr.write(`${yellow(`Hippo connection failed: ${result.lastError ?? 'unknown'}`)}\n\n`)
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

  rl.on('close', () => {
    process.stderr.write('\nGoodbye!\n')
    process.exit(0)
  })

  rl.on('SIGINT', () => {
    if (running && abortController) {
      abortController.abort()
      process.stderr.write('\n(Cancelled)\n')
    } else {
      rl.close()
    }
  })
}

export async function runOnce(options: ReplOptions & { prompt: string }): Promise<void> {
  const { apiKey, agent, cwd, verbose, prompt } = options

  const client = new CodebuffClient({ apiKey, cwd })
  const abortController = new AbortController()
  const sessionId = generateHippoSessionId(DEFAULT_AGENT_MODE)
  const startTime = Date.now()
  let lastTotalCost = 0
  const streamedChunks: string[] = []

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
      handleEvent: (event) => {
        if (event.type === 'finish') {
          lastTotalCost = event.totalCost
        }
        handleEvent(event, verbose)
      },
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          streamedChunks.push(chunk)
          process.stdout.write(chunk)
        }
      },
    })

    process.stdout.write('\n')

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
    const elapsedMs = Date.now() - startTime

    if (error instanceof Error && error.name === 'AbortError') {
      process.stderr.write('\nCancelled.\n')

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

  process.stderr.write(lines.join('\n') + '\n\n')
}

function printHelp(): void {
  process.stderr.write(`
${bold('Commands')}
  /new, /clear       Clear conversation and start fresh
  /help              Show this help message
  /exit, /quit       Exit the CLI

${bold('Hippo Memory')}
  /hippo:status      Show hippo memory status
  /hippo:on          Enable hippo memory
  /hippo:off         Disable hippo memory
  /hippo:retry       Test hippo connection

${bold('Environment Variables')}
  CODEBUFF_PROMPT_LOG   Log prompts and responses to a file (rolling, 5MB limit)
                        Set to '1' for ./debug/prompt-log.txt, or a custom path

${bold('Usage')}
  Type your prompt and press Enter to send.
  The agent will stream its response to stdout.
  Tool calls and status are shown on stderr (use -v flag).

`)
}
