import { createInterface } from 'readline'

import { CodebuffClient } from '@codebuff/sdk'

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
  cyan,
  bold,
} from './output'

import type { PrintModeEvent, RunState } from '@codebuff/sdk'

interface ReplOptions {
  apiKey: string
  agent: string
  cwd: string
  verbose: boolean
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { apiKey, agent, cwd, verbose } = options

  const client = new CodebuffClient({ apiKey, cwd })

  printBanner()

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${cyan(bold('> '))}`,
    terminal: process.stdin.isTTY ?? false,
  })

  let previousRun: RunState | undefined
  let running = false
  let abortController: AbortController | undefined

  const runPrompt = async (prompt: string): Promise<void> => {
    if (!prompt.trim()) return

    running = true
    abortController = new AbortController()
    printDivider()
    process.stdout.write('\n')

    try {
      const result = await client.run({
        agent,
        prompt,
        previousRun,
        signal: abortController.signal,
        handleEvent: (event) => handleEvent(event, verbose),
        handleStreamChunk: (chunk) => {
          if (typeof chunk === 'string') {
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

      if (result.output.type === 'error') {
        printError(result.output.message)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        process.stderr.write('\n')
      } else {
        const message = error instanceof Error ? error.message : String(error)
        printError(message)
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
      process.stderr.write(`${green('Conversation cleared.')}\n\n`)
      rl.prompt()
      return
    }

    if (trimmed === '/help') {
      printHelp()
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

  const onSigint = () => {
    abortController.abort()
  }
  process.on('SIGINT', onSigint)

  try {
    const result = await client.run({
      agent,
      prompt,
      signal: abortController.signal,
      handleEvent: (event) => handleEvent(event, verbose),
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          process.stdout.write(chunk)
        }
      },
    })

    process.stdout.write('\n')

    if (result.output.type === 'error') {
      printError(result.output.message)
      process.exit(1)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      process.stderr.write('\nCancelled.\n')
      process.exit(130)
    }
    const message = error instanceof Error ? error.message : String(error)
    printError(message)
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

function printHelp(): void {
  process.stderr.write(`
${bold('Commands')}
  /new, /clear    Clear conversation and start fresh
  /help           Show this help message
  /exit, /quit    Exit the CLI

${bold('Usage')}
  Type your prompt and press Enter to send.
  The agent will stream its response to stdout.
  Tool calls and status are shown on stderr (use -v flag).

`)
}
