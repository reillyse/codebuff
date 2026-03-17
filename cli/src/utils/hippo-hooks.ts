import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { logHippoInteraction, logHippoPrompt } from './hippo-logger'
import { logger } from './logger'
import { loadSettings } from './settings'

import type { RunState } from '@codebuff/sdk'
import type { AgentMode } from './constants'

// Path to hippo binary - can be overridden via HIPPO_PATH env var
export const HIPPO_BINARY = process.env.HIPPO_PATH ?? path.join(os.homedir(), 'Programming/hippo/build/hippo')
// Constants for hippo search
const HIPPO_SEARCH_TIMEOUT_MS = 5000 // 5 second timeout for search
const HIPPO_CONTEXT_SEARCH_TIMEOUT_MS = 15000 // 15 second timeout for hippo context-search
const HIPPO_QUERY_MAX_LENGTH = 500

// Track last stored pruning summary to avoid duplicate hippo stores
let lastStoredSummaryHash: string | null = null

/**
 * Reset module-level hippo state. Call when starting a new chat session.
 */
export const resetHippoSessionState = (): void => {
  lastStoredSummaryHash = null
}

// Tool names that indicate file changes
const FILE_WRITE_TOOLS = ['write_file', 'str_replace', 'propose_write_file', 'propose_str_replace']
const FILE_READ_TOOLS = ['read_files', 'read_subtree']
const COMMAND_TOOLS = ['run_terminal_command']

/**
 * Generate a session ID for hippo based on current timestamp and mode
 * Format: codebuff-{mode}-{YYYY-MM-DD-HHmm}
 */
export const generateHippoSessionId = (agentMode: AgentMode): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')

  return `codebuff-${agentMode.toLowerCase()}-${year}-${month}-${day}-${hours}${minutes}`
}

/**
 * Extract file paths from tool calls in message history
 */
const extractFilesFromHistory = (runState: RunState): { filesChanged: string[], filesRead: string[], commandsRun: string[] } => {
  const filesChanged = new Set<string>()
  const filesRead = new Set<string>()
  const commandsRun: string[] = []

  const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []

  for (const message of messageHistory) {
    if (!message.content || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      // Handle tool-call blocks from the SDK
      if (block.type === 'tool-call') {
        const toolName = block.toolName
        const input = block.input ?? {}

        if (toolName && FILE_WRITE_TOOLS.includes(toolName)) {
          const filePath = input.path as string | undefined
          if (filePath) filesChanged.add(filePath)
        } else if (toolName && FILE_READ_TOOLS.includes(toolName)) {
          const paths = input.paths
          if (Array.isArray(paths)) paths.forEach((p: string) => filesRead.add(p))
        } else if (toolName && COMMAND_TOOLS.includes(toolName)) {
          const command = input.command
          if (typeof command === 'string') commandsRun.push(command.substring(0, 50))
        }
      }
    }
  }

  return {
    filesChanged: Array.from(filesChanged),
    filesRead: Array.from(filesRead),
    commandsRun: commandsRun.slice(0, 5), // Limit to 5 commands
  }
}

/**
 * Build a summary of the run for hippo's --input field
 */
const buildInputSummary = (prompt: string, agentMode: AgentMode): string => {
  const truncatedPrompt = prompt.length > 500
    ? prompt.substring(0, 500) + '...'
    : prompt
  return `[${agentMode}] ${truncatedPrompt}`
}

/**
 * Build a rich run summary by extracting the agent's text, todo plan state,
 * and suggested followups from the full message history.
 */
const buildRichRunSummary = (runState: RunState): string | null => {
  const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []

  let lastSummaryText: string | null = null
  let latestTodosDescription: string | null = null
  let followupsDescription: string | null = null

  for (const message of messageHistory) {
    if (message.role !== 'assistant') continue
    if (!message.content || !Array.isArray(message.content)) continue

    let messageLastText = ''

    for (const block of message.content) {
      if (block.type === 'text') {
        const rawText = ('text' in block ? String(block.text) : '').trim()
        if (rawText && !rawText.startsWith('<think>')) {
          messageLastText = rawText
        }
      }

      if (block.type === 'tool-call') {
        const input = block.input ?? {}

        if (block.toolName === 'write_todos' && Array.isArray(input.todos)) {
          const todos = (input.todos as unknown[]).filter(
            (t): t is Record<string, unknown> => typeof t === 'object' && t !== null,
          )
          if (todos.length > 0) {
            const completed = todos.filter((t) => t.completed === true).length
            const incomplete = todos.filter((t) => t.completed !== true)
            if (incomplete.length === 0) {
              latestTodosDescription = `Plan: ${completed}/${todos.length} complete (all done!)`
            } else {
              const remaining = incomplete
                .map((t) => (typeof t.task === 'string' ? t.task : ''))
                .filter(Boolean)
                .slice(0, 5)
                .join(', ')
              latestTodosDescription = `Plan: ${completed}/${todos.length} complete. Remaining: ${remaining}`
            }
          }
        }

        if (block.toolName === 'suggest_followups' && Array.isArray(input.followups)) {
          const followups = (input.followups as unknown[]).filter(
            (f): f is Record<string, unknown> => typeof f === 'object' && f !== null,
          )
          const labels = followups
            .map((f) => (typeof f.label === 'string' ? f.label : typeof f.prompt === 'string' ? f.prompt : ''))
            .filter(Boolean)
            .slice(0, 5)
          if (labels.length > 0) {
            followupsDescription = `Next steps: ${labels.join(', ')}`
          }
        }
      }
    }

    if (messageLastText) {
      lastSummaryText = messageLastText
    }
  }

  const parts: string[] = []

  if (lastSummaryText) {
    parts.push(lastSummaryText.length > 500 ? lastSummaryText.substring(0, 500) + '...' : lastSummaryText)
  }

  if (latestTodosDescription) {
    parts.push(latestTodosDescription)
  }

  if (followupsDescription) {
    parts.push(followupsDescription)
  }

  if (parts.length === 0) return null

  const combined = parts.join(' | ').replace(/\n+/g, ' ').replace(/\s+/g, ' ')
  return combined.length > 1200 ? combined.substring(0, 1200) + '...' : combined
}

/**
 * Build a detailed output description for hippo's --output field.
 * Prefers the agent's own summary, falls back to file-based description.
 */
const buildOutputDescription = (
  runState: RunState,
  elapsedMs: number,
  filesChanged: string[],
  filesRead: string[],
  commandsRun: string[]
): string => {
  if (runState.output?.type === 'error') {
    return `Error: ${runState.output.message ?? 'Unknown error'}`
  }

  // Try to build a rich summary from text + tool calls (most informative)
  const richSummary = buildRichRunSummary(runState)
  if (richSummary) {
    return richSummary
  }

  // Fall back to file-based description with relative paths
  const parts: string[] = []

  if (filesChanged.length > 0) {
    const fileList = filesChanged.slice(0, 5).join(', ')
    const moreFiles = filesChanged.length > 5 ? ` +${filesChanged.length - 5} more` : ''
    parts.push(`Modified: ${fileList}${moreFiles}.`)
  }

  if (filesRead.length > 0 && filesChanged.length === 0) {
    parts.push(`Analyzed ${filesRead.length} files.`)
  }

  if (commandsRun.length > 0) {
    parts.push(`Ran ${commandsRun.length} command(s).`)
  }

  if (parts.length === 0) {
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const messageCount = runState.sessionState?.mainAgentState?.messageHistory?.length ?? 0
    parts.push(`Completed in ${elapsedSeconds}s with ${messageCount} messages.`)
  }

  return parts.join(' ')
}

/**
 * Determine outcome type for hippo based on run result and what was done.
 * Uses richer outcome types so hippo's dream phase can classify runs better.
 */
const getOutcome = (runState: RunState, filesChanged: string[], filesRead: string[]): 'success' | 'failure' | 'discovery' => {
  if (runState.output?.type === 'error') {
    return 'failure'
  }
  // Read-only runs (analysis, review, exploration) are discoveries
  if (filesChanged.length === 0 && filesRead.length > 0) {
    return 'discovery'
  }
  return 'success'
}

/**
 * Check if hippo is enabled and available
 */
const isHippoAvailable = (): boolean => {
  const settings = loadSettings()
  if (settings.hippoEnabled === false) {
    logger.debug({}, 'Hippo is disabled in settings')
    return false
  }

  if (!fs.existsSync(HIPPO_BINARY)) {
    logger.debug(
      { path: HIPPO_BINARY },
      'Hippo binary not found'
    )
    return false
  }

  return true
}

/**
 * Run a hippo CLI command synchronously with timeout. Returns stdout or null on failure.
 */
const runHippoSync = (args: string[], timeoutMs = HIPPO_SEARCH_TIMEOUT_MS): string | null => {
  const startTime = Date.now()
  try {
    const result = spawnSync(HIPPO_BINARY, [...args, '--quiet'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })

    if (result.signal || result.error || result.status !== 0) {
      logger.debug(
        { signal: result.signal, error: result.error?.message, status: result.status, args: args.slice(0, 2) },
        'Hippo command failed'
      )
      logHippoInteraction(args, null, Date.now() - startTime)
      return null
    }

    const output = result.stdout?.trim() ?? null
    logHippoInteraction(args, output, Date.now() - startTime)
    return output
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to run hippo command'
    )
    logHippoInteraction(args, null, Date.now() - startTime)
    return null
  }
}

/**
 * Run a hippo CLI command asynchronously with timeout. Returns stdout or null on failure.
 * Unlike runHippoSync, this doesn't block the event loop — the UI stays responsive.
 */
const runHippoAsync = (args: string[], timeoutMs = HIPPO_SEARCH_TIMEOUT_MS): Promise<string | null> => {
  const startTime = Date.now()
  return new Promise<string | null>((resolve) => {
    try {
      const child = spawn(HIPPO_BINARY, [...args, '--quiet'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: process.cwd(),
      })

      const chunks: Buffer[] = []
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGTERM')
          logger.debug({ args: args.slice(0, 2) }, 'Hippo command timed out')
          resolve(null)
        }
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        if (code !== 0) {
          logger.debug({ code, args: args.slice(0, 2) }, 'Hippo command failed')
          resolve(null)
          return
        }
        resolve(Buffer.concat(chunks).toString('utf-8').trim() || null)
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        logger.debug({ error: error.message }, 'Failed to run hippo command')
        resolve(null)
      })
    } catch (error) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to spawn hippo command',
      )
      resolve(null)
    }
  }).then((result) => {
    logHippoInteraction(args, result, Date.now() - startTime)
    return result
  })
}

/**
 * Build a plain-text conversation context string for the hippo context-search --context flag.
 * Extracts recent user prompts and files touched from the previous run state.
 */
const buildConversationContext = (previousRunState: RunState | null): string | null => {
  if (!previousRunState) return null

  const messageHistory = previousRunState.sessionState?.mainAgentState?.messageHistory ?? []

  const recentPrompts: string[] = []
  for (let i = messageHistory.length - 1; i >= 0 && recentPrompts.length < 3; i--) {
    const message = messageHistory[i]
    if (message.role !== 'user') continue
    if (!message.content || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type === 'text' && 'text' in block) {
        const text = String(block.text).trim()
        if (text) {
          recentPrompts.push(text.length > 200 ? text.substring(0, 200) + '...' : text)
          break
        }
      }
    }
  }

  const { filesChanged, filesRead } = extractFilesFromHistory(previousRunState)

  if (recentPrompts.length === 0 && filesChanged.length === 0 && filesRead.length === 0) {
    return null
  }

  const parts: string[] = []
  if (recentPrompts.length > 0) {
    parts.push(`Recently working on: ${recentPrompts.join('; ')}`)
  }
  if (filesChanged.length > 0) {
    parts.push(`Files modified: ${filesChanged.slice(0, 8).join(', ')}`)
  }
  if (filesRead.length > 0) {
    parts.push(`Files read: ${filesRead.slice(0, 8).join(', ')}`)
  }
  return parts.join('. ') + '.'
}

export type HippoContextResult = {
  context: string
  /** null = didn't attempt, true = CLI responded, false = CLI failed/timed out */
  connectionOk: boolean | null
}

/**
 * Fetch relevant context from Hippo memory by calling `hippo context-search` locally.
 * This runs entirely on the local machine with no server dependency.
 *
 * Flow:
 * 1. Build conversation context JSON from previous run state
 * 2. Call `hippo context-search '<query>' --context '<text>'`
 * 3. Return the output (or empty string if nothing relevant)
 */
export const getHippoContext = async (
  query: string,
  previousRunState: RunState | null,
  sessionId?: string,
): Promise<HippoContextResult> => {
  try {
    if (!isHippoAvailable()) return { context: '', connectionOk: null }

    const trimmedQuery = query.trim()
    if (!trimmedQuery) return { context: '', connectionOk: null }

    const truncatedQuery = trimmedQuery.length > HIPPO_QUERY_MAX_LENGTH
      ? trimmedQuery.substring(0, HIPPO_QUERY_MAX_LENGTH)
      : trimmedQuery

    logger.debug({ query: truncatedQuery }, 'Fetching hippo context via context-search')

    const args = ['context-search', truncatedQuery]

    const contextString = buildConversationContext(previousRunState)

    logHippoPrompt('query', truncatedQuery, {
      'Context': contextString ?? '(none)',
      'Session': sessionId,
    })

    if (contextString) {
      args.push('--context', contextString)
    }

    if (sessionId) {
      args.push('--session', sessionId)
    }

    const result = await runHippoAsync(args, HIPPO_CONTEXT_SEARCH_TIMEOUT_MS)
    if (!result) {
      logHippoPrompt('response', '(no results)')
      return { context: '', connectionOk: false }
    }

    const trimmedResult = result.trim()

    if (!trimmedResult || trimmedResult.toUpperCase() === 'NONE' || trimmedResult.length < 20) {
      logger.debug({}, 'Hippo context-search found nothing relevant')
      return { context: '', connectionOk: true }
    }

    logger.debug({ contextLength: trimmedResult.length }, 'Hippo context extracted via context-search')
    logHippoPrompt('response', trimmedResult, { 'Content length': trimmedResult.length })
    return { context: trimmedResult, connectionOk: true }
  } catch (error) {
    try {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Hippo context-search failed',
      )
    } catch {
      // Safety net: logger itself can throw (e.g. analytics not initialized)
    }
    return { context: '', connectionOk: false }
  }
}


export type HippoSessionStats = {
  runs: number
}

/**
 * Fetch session-specific stats by calling `hippo snapshot --session <id> --json`.
 * Returns run count and unique file counts for the given session, or null if unavailable.
 */
export const getHippoSessionStats = async (sessionId: string): Promise<HippoSessionStats | null> => {
  try {
    if (!isHippoAvailable()) return null

    const result = await runHippoAsync(
      ['snapshot', '--session', sessionId, '--json'],
      HIPPO_SEARCH_TIMEOUT_MS,
    )
    if (!result) return null

    const runs: unknown[] = JSON.parse(result)
    if (!Array.isArray(runs)) return null

    return {
      runs: runs.length,
    }
  } catch {
    return null
  }
}

export type StoreRunToHippoParams = {
  runState: RunState
  prompt: string
  agentMode: AgentMode
  elapsedMs: number
  sessionId?: string
}

/**
 * Store a completed run to hippo memory.
 * Runs in a detached background process so it doesn't block the CLI.
 */
export const storeRunToHippo = (params: StoreRunToHippoParams): void => {
  if (!isHippoAvailable()) {
    return
  }

  const { runState, prompt, agentMode, elapsedMs } = params

  // Extract meaningful data from the run
  const { filesChanged, filesRead, commandsRun } = extractFilesFromHistory(runState)

  const sessionId = params.sessionId ?? generateHippoSessionId(agentMode)
  const inputSummary = buildInputSummary(prompt, agentMode)
  const outputDescription = buildOutputDescription(runState, elapsedMs, filesChanged, filesRead, commandsRun)
  const outcome = getOutcome(runState, filesChanged, filesRead)

  const args = [
    'store',
    '--agent', 'codebuff',
    '--session', sessionId,
    '--input', inputSummary,
    '--output', outputDescription,
    '--outcome', outcome,
  ]

  // Add files-changed if any
  if (filesChanged.length > 0) {
    args.push('--files-changed', filesChanged.slice(0, 10).join(','))
  }

  // Add files-read if any (limit to avoid overly long args)
  if (filesRead.length > 0) {
    args.push('--files-read', filesRead.slice(0, 10).join(','))
  }

  // Add commands-run if any
  if (commandsRun.length > 0) {
    args.push('--commands-run', commandsRun.join(','))
  }

  logger.debug(
    { hippoArgs: args, filesChanged, filesRead },
    'Storing run to hippo memory'
  )

  logHippoPrompt('store', `Input: ${inputSummary}\nOutput: ${outputDescription}`, {
    'Session': sessionId,
    'Outcome': outcome,
    'Files changed': filesChanged.length > 0 ? filesChanged.join(', ') : '(none)',
  })

  spawnHippoStore(args)
}

/**
 * Extract and store the conversation summary to hippo after context pruning.
 * This preserves pruned context so hippo can surface it in future queries.
 */
export const storePruningSummaryToHippo = (params: {
  runState: RunState
  sessionId: string
}): void => {
  try {
    if (!isHippoAvailable()) return

    const { runState, sessionId } = params
    const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []

    // Quick check: skip full scan if no message contains a conversation summary
    const hasSummary = messageHistory.some((m) =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'text' && typeof b.text === 'string' && (b.text as string).includes('<conversation_summary>')),
    )
    if (!hasSummary) return

    for (const message of messageHistory) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue

      for (const block of message.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue

        const match = (block.text as string).match(
          /<conversation_summary>([\s\S]*?)<\/conversation_summary>/,
        )
        if (!match) continue

        let summary = match[1].trim()
        if (summary.length > 2000) {
          summary = summary.substring(0, 2000) + '...'
        }

        // Deduplicate: skip if we already stored this exact summary
        const prefix = summary.substring(0, 100)
        const suffix = summary.substring(Math.max(0, summary.length - 100))
        const fingerprint = `${summary.length}:${prefix}:${suffix}`
        if (fingerprint === lastStoredSummaryHash) {
          logger.debug({ sessionId }, 'Pruning summary already stored, skipping')
          return
        }
        lastStoredSummaryHash = fingerprint

        logger.debug(
          { sessionId, summaryLength: summary.length },
          'Storing pruning summary to hippo',
        )

        logHippoPrompt('store', summary, { 'Session': sessionId, 'Type': 'pruning-summary' })

        spawnHippoStore([
          'store',
          '--agent', 'codebuff',
          '--session', sessionId,
          '--input', 'Context pruning summary',
          '--output', summary,
          '--outcome', 'discovery',
        ])
        return
      }
    }
  } catch {

    logger.error({ sessionId: params.sessionId }, 'Failed to store pruning summary to hippo')
  }
}

/**
 * Check if an error is worth storing to hippo memory.
 * Skip transient/expected errors; keep actionable ones.
 */
const isErrorWorthStoring = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  // Skip: out of credits / payment errors (user already knows)
  if (lower.includes('out of credits') || lower.includes('payment') || lower.includes('insufficient credits') || lower.includes('insufficient funds')) return false

  // Skip: transient network errors
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout')) return false
  if (lower.includes('fetch failed') || lower.includes('network error')) return false
  if (lower.includes('timeout') && !lower.includes('context')) return false

  return true
}

/**
 * Store a meaningful error to hippo memory.
 * Filters out transient/expected errors (network timeouts, out-of-credits).
 * Keeps actionable errors (context length exceeded, server 500s).
 */
export const storeErrorToHippo = (params: {
  error: unknown
  sessionId: string
}): void => {
  if (!isHippoAvailable()) return

  const { error, sessionId } = params
  if (!isErrorWorthStoring(error)) return

  const errorMessage = error instanceof Error ? error.message : String(error)
  const truncated = errorMessage.length > 500 ? errorMessage.substring(0, 500) + '...' : errorMessage

  logger.debug({ sessionId, errorLength: errorMessage.length }, 'Storing error to hippo memory')

  logHippoPrompt('store', `Error: ${truncated}`, {
    'Session': sessionId,
    'Type': 'error',
  })

  spawnHippoStore([
    'store',
    '--agent', 'codebuff',
    '--session', sessionId,
    '--input', 'Error during run',
    '--output', `Error: ${truncated}`,
    '--outcome', 'failure',
  ])
}

/**
 * Helper to spawn hippo store process in background
 */
const spawnHippoStore = (args: string[]): void => {
  try {
    logHippoInteraction(args, '(fire-and-forget)')

    // Spawn detached process so it doesn't block CLI
    const child = spawn(HIPPO_BINARY, args, {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(), // Run from project root so hippo auto-detects .hippo/project.yaml
    })

    // Unref to allow parent process to exit independently
    child.unref()
  } catch (error) {
    // Log but don't throw - hippo storage is best-effort
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to spawn hippo store process'
    )
  }
}
