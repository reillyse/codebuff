import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { logHippoInteraction, logHippoPrompt } from './hippo-logger'
import { logger } from './logger'
import { loadSettings } from './settings'

import type { RunState } from '@codebuff/sdk'
import type { AgentMode } from './constants'

// Resolve the hippo binary path: env override → PATH lookup → dev fallback
export const resolveHippoBinary = (): string => {
  if (process.env.HIPPO_PATH) return process.env.HIPPO_PATH

  try {
    const result = execFileSync('which', ['hippo'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (result) return result
  } catch {
    // hippo not found in PATH
  }

  return path.join(os.homedir(), 'Programming/hippo/build/hippo')
}

export const HIPPO_BINARY = resolveHippoBinary()
// Constants for hippo search
const HIPPO_SEARCH_TIMEOUT_MS = 5000 // 5 second timeout for search
const HIPPO_CONTEXT_SEARCH_TIMEOUT_MS = 15000 // 15 second timeout for hippo context-search
const HIPPO_QUERY_MAX_LENGTH = 500
// Hard cap on how many characters of hippo context are injected into the main
// agent prompt. Cross-session summaries can be arbitrarily large; 3000 chars
// (~750 tokens) gives enough signal without bloating the context window.
const HIPPO_CONTEXT_MAX_CHARS = 3000

// Track last stored pruning summary to avoid duplicate hippo stores
let lastStoredSummaryHash: string | null = null

/**
 * Reset module-level hippo state. Call when starting a new chat session.
 */
export const resetHippoSessionState = (): void => {
  lastStoredSummaryHash = null
  consecutiveSubagentHippoFailures = 0
  hippoSubagentCircuitOpenUntil = 0
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
  const truncatedPrompt = prompt.length > 200
    ? prompt.substring(0, 200) + '...'
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
  return combined.length > 1000 ? combined.substring(0, 1000) + '...' : combined
}

/**
 * Build a detailed output description for hippo's --output field.
 *
 * The narrative prose (what was discovered, what failed, why) is the valuable
 * signal for learning — file lists are noise here and are tracked separately
 * via the structured `--files-changed` flag. So we prefer the agent's own
 * summary and deliberately avoid padding the output with file names.
 */
const buildOutputDescription = (
  runState: RunState,
  elapsedMs: number,
): string => {
  if (runState.output?.type === 'error') {
    return `Error: ${runState.output.message ?? 'Unknown error'}`
  }

  // Prefer the agent's own prose summary (most informative for learning)
  const richSummary = buildRichRunSummary(runState)
  if (richSummary) {
    return richSummary
  }

  // Minimal fallback — no file lists (those live in --files-changed)
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  const messageCount = runState.sessionState?.mainAgentState?.messageHistory?.length ?? 0
  return `Completed in ${elapsedSeconds}s with ${messageCount} messages.`
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

let cachedHippoEnabled: boolean | null = null

/**
 * Reset the cached hippoEnabled value. Call after saveSettings({ hippoEnabled: ... }).
 */
export const resetHippoEnabledCache = (): void => {
  cachedHippoEnabled = null
}

// ---------------------------------------------------------------------------
// Subagent hippo circuit breaker
//
// When hippo is unresponsive, each subagent spawn triggers a 3-second timeout
// before falling through. After THRESHOLD consecutive failures we open the
// circuit for DURATION_MS so we stop hammering a down hippo and the agent
// receives an explicit "hippo unavailable" note (telling it to use direct APIs
// instead of retrying hippo commands in a loop).
// ---------------------------------------------------------------------------

let consecutiveSubagentHippoFailures = 0
const HIPPO_SUBAGENT_CIRCUIT_BREAK_THRESHOLD = 3
const HIPPO_SUBAGENT_CIRCUIT_BREAK_DURATION_MS = 2 * 60 * 1000 // 2 minutes
let hippoSubagentCircuitOpenUntil = 0

const isHippoSubagentCircuitOpen = (): boolean => Date.now() < hippoSubagentCircuitOpenUntil

const recordSubagentHippoFailure = (): void => {
  consecutiveSubagentHippoFailures++
  if (consecutiveSubagentHippoFailures >= HIPPO_SUBAGENT_CIRCUIT_BREAK_THRESHOLD) {
    hippoSubagentCircuitOpenUntil = Date.now() + HIPPO_SUBAGENT_CIRCUIT_BREAK_DURATION_MS
    logger.debug(
      { consecutiveSubagentHippoFailures },
      'Hippo subagent circuit breaker opened — skipping hippo for 2 min',
    )
  }
}

const recordSubagentHippoSuccess = (): void => {
  if (consecutiveSubagentHippoFailures > 0) {
    consecutiveSubagentHippoFailures = 0
    hippoSubagentCircuitOpenUntil = 0
  }
}

/**
 * Check if hippo is enabled and available
 */
const isHippoAvailable = (): boolean => {
  if (cachedHippoEnabled === null) {
    cachedHippoEnabled = loadSettings().hippoEnabled !== false
  }
  if (!cachedHippoEnabled) {
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
 * Run a hippo CLI command asynchronously with timeout. Returns stdout or null on failure.
 */
type HippoRunResult = { stdout: string | null; error: string | null }

const runHippoAsync = (args: string[], timeoutMs = HIPPO_SEARCH_TIMEOUT_MS): Promise<HippoRunResult> => {
  const startTime = Date.now()
  return new Promise<HippoRunResult>((resolve) => {
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
          resolve({ stdout: null, error: 'Connection timed out' })
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
          resolve({ stdout: null, error: `Command failed (exit ${code})` })
          return
        }
        resolve({ stdout: Buffer.concat(chunks).toString('utf-8').trim(), error: null })
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        logger.debug({ error: error.message }, 'Failed to run hippo command')
        resolve({ stdout: null, error: error.message })
      })
    } catch (error) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to spawn hippo command',
      )
      resolve({ stdout: null, error: error instanceof Error ? error.message : String(error) })
    }
  }).then((result) => {
    logHippoInteraction(args, result.stdout, Date.now() - startTime)
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

/** Check if a hippo error is transient and worth retrying (timeout, non-zero exit) */
const isRetryableHippoError = (error: string | null): boolean => {
  if (!error) return false
  return error.startsWith('Connection timed out') || error.startsWith('Command failed')
}

/**
 * Low-signal phrases that carry no real semantic content for hippo search.
 * When the user types one of these as their entire prompt (e.g. after typing
 * "continue" on a new session), hippo would fall back to a cross-session
 * similarity search using the --context string, injecting large blobs of past
 * session summaries that bloat the context and trigger the read-loop.
 *
 * Phrases are stored normalised (lowercase, single-spaced, trimmed).
 */
const LOW_SIGNAL_QUERIES = new Set([
  'continue', 'continue please', 'please continue',
  'yes', 'yep', 'yeah', 'y',
  'no', 'n', 'nope',
  'ok', 'okay', 'k',
  'sure', 'alright', 'sounds good',
  'go', 'go ahead', 'proceed',
  'next', 'done', 'finish', 'resume', 'carry on',
  'do it', 'keep going',
])

/**
 * Returns true when the query is so short / generic that hippo context-search
 * would produce no useful signal — only cross-session noise. Skipping the call
 * in these cases prevents the "continue" context-bloat loop.
 */
const isSemanticallySparseQuery = (query: string): boolean => {
  const normalised = query.toLowerCase().replace(/\s+/g, ' ').trim()
  return LOW_SIGNAL_QUERIES.has(normalised)
}

export type HippoContextResult = {
  context: string
  /** null = didn't attempt, true = CLI responded, false = CLI failed/timed out */
  connectionOk: boolean | null
  /** Human-readable error message when connectionOk is false */
  lastError: string | null
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
    if (!isHippoAvailable()) return { context: '', connectionOk: null, lastError: null }

    const trimmedQuery = query.trim()
    if (!trimmedQuery) return { context: '', connectionOk: null, lastError: null }

    // Skip hippo for semantically empty prompts (e.g. "continue", "yes", "ok").
    // These produce no useful search signal and cause cross-session context bloat.
    if (isSemanticallySparseQuery(trimmedQuery)) {
      logger.debug({ query: trimmedQuery }, 'Skipping hippo context-search for low-signal query')
      return { context: '', connectionOk: null, lastError: null }
    }

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

    let { stdout, error: hippoError } = await runHippoAsync(args, HIPPO_CONTEXT_SEARCH_TIMEOUT_MS)

    // Auto-retry once on transient errors (timeout, non-zero exit)
    if (stdout === null && isRetryableHippoError(hippoError)) {
      logger.debug({ error: hippoError }, 'Hippo context-search failed, retrying once')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      const retry = await runHippoAsync(args, HIPPO_SEARCH_TIMEOUT_MS)
      stdout = retry.stdout
      hippoError = retry.error
    }

    if (stdout === null) {
      logHippoPrompt('response', '(command failed)')
      return { context: '', connectionOk: false, lastError: hippoError }
    }

    const trimmedResult = stdout.trim()

    if (!trimmedResult || trimmedResult.toUpperCase() === 'NONE' || trimmedResult.length < 20 || trimmedResult.toLowerCase().startsWith('no relevant context')) {
      logger.debug({}, 'Hippo context-search found nothing relevant')
      return { context: '', connectionOk: true, lastError: null }
    }

    const cappedResult = trimmedResult.length > HIPPO_CONTEXT_MAX_CHARS
      ? trimmedResult.substring(0, HIPPO_CONTEXT_MAX_CHARS) + '...'
      : trimmedResult
    logger.debug({ contextLength: cappedResult.length }, 'Hippo context extracted via context-search')
    logHippoPrompt('response', cappedResult, { 'Content length': cappedResult.length })
    return { context: cappedResult, connectionOk: true, lastError: null }
  } catch (error) {
    try {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Hippo context-search failed',
      )
    } catch {
      // Safety net: logger itself can throw (e.g. analytics not initialized)
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { context: '', connectionOk: false, lastError: errorMessage }
  }
}


/**
 * Lightweight health check for hippo CLI connectivity.
 * Runs a quick context-search to verify the full stack (binary + Neo4j) is reachable.
 */
export const checkHippoConnection = async (): Promise<{ connectionOk: boolean; lastError: string | null }> => {
  if (!isHippoAvailable()) {
    return { connectionOk: false, lastError: 'Hippo not available' }
  }

  const { stdout, error } = await runHippoAsync(['snapshot', '--json'], 3000)
  if (stdout === null) {
    return { connectionOk: false, lastError: error }
  }
  return { connectionOk: true, lastError: null }
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

    const { stdout } = await runHippoAsync(
      ['snapshot', '--session', sessionId, '--json'],
      HIPPO_SEARCH_TIMEOUT_MS,
    )
    if (!stdout) return null

    const runs: unknown[] = JSON.parse(stdout)
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
  const { filesChanged, filesRead } = extractFilesFromHistory(runState)

  const sessionId = params.sessionId ?? generateHippoSessionId(agentMode)
  const inputSummary = buildInputSummary(prompt, agentMode)
  const outputDescription = buildOutputDescription(runState, elapsedMs)
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

  logger.debug(
    { hippoArgs: args, filesChanged },
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
 * Extract brief topic keywords from a pruning summary for hippo searchability.
 * Pulls meaningful text fragments (skipping markers) up to ~200 chars.
 */
export const extractBriefTopics = (summary: string): string => {
  const lines = summary.split('\n')
  const meaningful: string[] = []
  let totalLength = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---') continue
    // Skip structural markers but keep their content
    const cleaned = trimmed
      .replace(/^\[(USER|ASSISTANT|TOOL ERROR[^\]]*|COMMAND FAILED|EDIT RESULT|WRITE RESULT|AGENT RESULTS|USER ANSWERED|USER SKIPPED QUESTION)\]\s*/i, '')
      .replace(/^\[PREVIOUS SUMMARY\]\s*/i, '')
      .replace(/^\[CONVERSATION TRUNCATED[^\]]*\]\s*/i, '')
      .trim()
    if (!cleaned) continue

    if (totalLength + cleaned.length > 200) {
      const remaining = 200 - totalLength
      if (remaining > 20) meaningful.push(cleaned.substring(0, remaining) + '...')
      break
    }
    meaningful.push(cleaned)
    totalLength += cleaned.length
  }

  return meaningful.join('; ') || 'general conversation'
}

/**
 * Store a lightweight pruning event to hippo after context pruning.
 * Instead of storing the full summary (which bloats hippo), stores a brief
 * record noting that pruning happened with instructions on how to retrieve
 * the earlier context via hippo context-search with the session ID.
 */
export const storePruningSummaryToHippo = (params: {
  runState: RunState
  sessionId: string
}): void => {
  try {
    const { runState, sessionId } = params
    const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []

    // The context-pruner places the summary in the first user message of the pruned
    // history, so we only need to check the first few messages — not the entire array.
    // This makes the common case (no pruning) O(1) instead of O(n).
    const SUMMARY_SEARCH_LIMIT = 5
    let summaryMessageIndex = -1
    for (let i = 0; i < Math.min(messageHistory.length, SUMMARY_SEARCH_LIMIT); i++) {
      const m = messageHistory[i]
      if (
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'text' && typeof b.text === 'string' && (b.text as string).includes('<conversation_summary>'))
      ) {
        summaryMessageIndex = i
        break
      }
    }
    if (summaryMessageIndex === -1) return

    // Only check hippo availability after confirming pruning happened
    if (!isHippoAvailable()) return

    const message = messageHistory[summaryMessageIndex]

    for (const block of message.content as Array<{ type: string; text?: unknown }>) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue

      const match = (block.text as string).match(
        /<conversation_summary>([\s\S]*?)<\/conversation_summary>/,
      )
      if (!match) continue

      const summary = match[1].trim()

      // Deduplicate: skip if we already stored this exact summary
      const prefix = summary.substring(0, 100)
      const suffix = summary.substring(Math.max(0, summary.length - 100))
      const fingerprint = `${summary.length}:${prefix}:${suffix}`
      if (fingerprint === lastStoredSummaryHash) {
        logger.debug({ sessionId }, 'Pruning event already stored, skipping')
        return
      }
      lastStoredSummaryHash = fingerprint

      const topics = extractBriefTopics(summary)
      const outputNote = `Context was pruned during this session. Topics discussed before pruning: ${topics}`

      logger.debug(
        { sessionId, topicsLength: topics.length },
        'Storing pruning event to hippo',
      )

      logHippoPrompt('store', outputNote, { 'Session': sessionId, 'Type': 'pruning-event' })

      spawnHippoStore([
        'store',
        '--agent', 'codebuff',
        '--session', sessionId,
        '--input', `Context pruned - session ${sessionId}`,
        '--output', outputNote,
        '--outcome', 'discovery',
      ])
      return
    }
  } catch {
    logger.error({ sessionId: params.sessionId }, 'Failed to store pruning event to hippo')
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
  elapsedMs?: number
}): void => {
  if (!isHippoAvailable()) return

  const { error, sessionId, elapsedMs } = params
  if (!isErrorWorthStoring(error)) return

  const errorMessage = error instanceof Error ? error.message : String(error)
  const truncated = errorMessage.length > 500 ? errorMessage.substring(0, 500) + '...' : errorMessage

  const elapsedSeconds = elapsedMs != null ? Math.floor(elapsedMs / 1000) : null
  const elapsedSuffix = elapsedSeconds != null ? ` (${elapsedSeconds}s)` : ''
  const outputLine = `Error${elapsedSuffix}: ${truncated}`

  logger.debug({ sessionId, errorLength: errorMessage.length, elapsedMs }, 'Storing error to hippo memory')

  logHippoPrompt('store', outputLine, {
    'Session': sessionId,
    'Type': 'error',
    ...(elapsedSeconds != null && { 'Elapsed': `${elapsedSeconds}s` }),
  })

  spawnHippoStore([
    'store',
    '--agent', 'codebuff',
    '--session', sessionId,
    '--input', 'Error during run',
    '--output', outputLine,
    '--outcome', 'failure',
  ])
}

// ---------------------------------------------------------------------------
// Subagent hippo helpers
// ---------------------------------------------------------------------------

const HIPPO_SUBAGENT_TIMEOUT_MS = 8000
const HIPPO_SUBAGENT_CONTEXT_MAX_CHARS = 1500

const HIPPO_ENRICHED_AGENTS = ['commander', 'commander-lite', 'file-picker', 'file-picker-max', 'opus-agent', 'gpt-5-agent']

/**
 * Extract the short agent ID from a potentially fully-qualified ID
 * (e.g. 'codebuff/commander@latest' → 'commander').
 */
const getShortAgentId = (agentType: string): string => {
  const withoutVersion = agentType.split('@')[0]
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1]
}

/**
 * Fetch hippo context for a subagent call. Lighter version of getHippoContext
 * with shorter timeout and no retry (subagents are time-sensitive).
 */
export const getSubagentHippoContext = async (
  agentType: string,
  prompt: string,
  sessionId: string,
): Promise<HippoContextResult> => {
  try {
    if (!isHippoAvailable()) return { context: '', connectionOk: null, lastError: null }

    const trimmedQuery = prompt.trim()
    if (!trimmedQuery) return { context: '', connectionOk: null, lastError: null }

    const truncatedQuery = trimmedQuery.length > HIPPO_QUERY_MAX_LENGTH
      ? trimmedQuery.substring(0, HIPPO_QUERY_MAX_LENGTH)
      : trimmedQuery

    logger.debug({ agentType, query: truncatedQuery.substring(0, 80) }, 'Fetching hippo context for subagent')

    const args = ['context-search', truncatedQuery, '--session', sessionId]

    logHippoPrompt('query', truncatedQuery, {
      'Type': `subagent:${agentType}`,
      'Session': sessionId,
    })

    const { stdout, error } = await runHippoAsync(args, HIPPO_SUBAGENT_TIMEOUT_MS)

    if (stdout === null) {
      logHippoPrompt('response', '(subagent command failed)', { 'Error': error ?? 'Unknown error' })
      recordSubagentHippoFailure()
      return { context: '', connectionOk: false, lastError: error ?? 'Unknown error' }
    }

    const trimmedResult = stdout.trim()
    if (!trimmedResult || trimmedResult.toUpperCase() === 'NONE' || trimmedResult.length < 20 || trimmedResult.toLowerCase().startsWith('no relevant context')) {
      logger.debug({ agentType }, 'Hippo subagent context-search found nothing relevant')
      recordSubagentHippoSuccess()
      return { context: '', connectionOk: true, lastError: null }
    }

    const cappedResult = trimmedResult.length > HIPPO_SUBAGENT_CONTEXT_MAX_CHARS
      ? trimmedResult.substring(0, HIPPO_SUBAGENT_CONTEXT_MAX_CHARS) + '...'
      : trimmedResult

    logger.debug({ agentType, contextLength: cappedResult.length }, 'Hippo subagent context extracted')
    logHippoPrompt('response', cappedResult, {
      'Type': `subagent:${agentType}`,
      'Content length': cappedResult.length,
    })
    recordSubagentHippoSuccess()
    return { context: cappedResult, connectionOk: true, lastError: null }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error), agentType },
      'Hippo subagent context-search failed',
    )
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { context: '', connectionOk: false, lastError: errorMessage }
  }
}

export type StoreSubagentResultParams = {
  agentType: string
  prompt: string
  output: unknown
  elapsedMs: number
  sessionId: string
}

const SUBAGENT_OUTPUT_MAX_CHARS = 500

/**
 * Narrative-bearing keys a subagent's output object actually carries via set_output.
 * Codebuff's enriched subagents emit:
 *   - `output`  → commander / commander-lite (e.g. { output: '...' })
 *   - `message` → the documented set_output convention (opus-agent / gpt-5-agent)
 * We intentionally avoid speculative keys to keep extraction predictable.
 */
const SUBAGENT_NARRATIVE_KEYS = ['output', 'message']

const truncateNarrative = (text: string): string =>
  text.length > SUBAGENT_OUTPUT_MAX_CHARS
    ? text.substring(0, SUBAGENT_OUTPUT_MAX_CHARS) + '...'
    : text

/**
 * Build a prose output description for a subagent result.
 *
 * Like the top-level path, we prefer narrative (what the subagent discovered /
 * concluded) over a bare 'Completed (Ns)'. Subagents report via set_output, so we
 * mine the narrative fields they actually emit — 'output' (commander / commander-lite)
 * and 'message' (opus-agent / gpt-5-agent) — falling back to the duration only when
 * there's genuinely no prose to keep.
 */
export const buildSubagentOutputDescription = (output: unknown, elapsedMs: number): string => {
  const completedFallback = `Completed (${Math.floor(elapsedMs / 1000)}s).`

  // Plain string output → use directly
  if (typeof output === 'string') {
    const trimmed = output.trim()
    return trimmed ? truncateNarrative(trimmed) : completedFallback
  }

  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>

    // Errors: keep the error message (that's the most valuable signal)
    if (obj.type === 'error') {
      const msg = typeof obj.message === 'string' ? obj.message : 'Unknown error'
      return `Error: ${truncateNarrative(msg)}`
    }

    // Cancelled: surface the cancel reason if present (outcome is 'failure',
    // so a bare 'Completed (Ns)' here would be misleading).
    if (obj.type === 'cancelled') {
      const msg = typeof obj.message === 'string' ? obj.message.trim() : ''
      return msg ? truncateNarrative(msg) : 'Cancelled'
    }

    // Prefer the first narrative-bearing field present
    for (const key of SUBAGENT_NARRATIVE_KEYS) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) {
        return truncateNarrative(value.trim())
      }
    }
  }

  return completedFallback
}

/**
 * Store a subagent result to hippo memory (fire-and-forget).
 * Uses a distinct agent name (e.g. 'codebuff-commander') so hippo can
 * differentiate subagent runs from top-level runs.
 */
export const storeSubagentResultToHippo = (params: StoreSubagentResultParams): void => {
  if (!isHippoAvailable()) return

  const { agentType, prompt, output, elapsedMs, sessionId } = params

  const truncatedPrompt = prompt.length > 200
    ? prompt.substring(0, 200) + '...'
    : prompt
  const inputSummary = `[subagent:${agentType}] ${truncatedPrompt}`

  const outputDescription = buildSubagentOutputDescription(output, elapsedMs)

  const outType = output && typeof output === 'object' && 'type' in output
    ? (output as { type: string }).type
    : 'success'
  const outcome: 'success' | 'failure' = outType === 'error' || outType === 'cancelled' ? 'failure' : 'success'

  const args = [
    'store',
    '--agent', `codebuff-${agentType}`,
    '--session', sessionId,
    '--input', inputSummary,
    '--output', outputDescription,
    '--outcome', outcome,
  ]

  logger.debug({ agentType, outcome }, 'Storing subagent result to hippo')

  logHippoPrompt('store', `Input: ${inputSummary}\nOutput: ${outputDescription}`, {
    'Session': sessionId,
    'Type': `subagent:${agentType}`,
    'Outcome': outcome,
  })

  spawnHippoStore(args)
}

/**
 * Build subagent lifecycle hooks for hippo context injection.
 * Pass the returned object spread into the CodebuffClient constructor.
 */
export const buildHippoSubagentHooks = (getSessionId: () => string) => {
  return {
    onBeforeSubagentPrompt: async ({ agentType, prompt }: { agentType: string; prompt: string }) => {
      const shortId = getShortAgentId(agentType)
      if (!HIPPO_ENRICHED_AGENTS.includes(shortId)) return undefined
      // Circuit open: inject an explicit "unavailable" note so the agent stops
      // retrying hippo commands and falls back to direct APIs instead.
      if (isHippoSubagentCircuitOpen()) {
        return {
          enrichedPrompt: `> **Note:** hippo memory is temporarily unavailable — use direct APIs or tools instead of retrying hippo commands.\n\n${prompt}`,
        }
      }
      if (!isHippoAvailable()) return undefined
      const result = await getSubagentHippoContext(shortId, prompt, getSessionId())
      if (!result.context) return undefined
      const runRetrievalNote = [
        '> If this context references past runs (e.g. `run_abc123`), retrieve a specific',
        '> run\'s output with: `hippo run get <run_id>`',
        '> Only do this if the run appears directly relevant to your current task.',
      ].join('\n')
      return { enrichedPrompt: `## Relevant Context from Past Sessions\n${runRetrievalNote}\n\n${result.context}\n\n${prompt}` }
    },
    onAfterSubagentComplete: async ({ agentType, prompt, output, elapsedMs }: { agentType: string; prompt: string; output: unknown; elapsedMs: number }) => {
      const shortId = getShortAgentId(agentType)
      if (!HIPPO_ENRICHED_AGENTS.includes(shortId)) return
      storeSubagentResultToHippo({ agentType: shortId, prompt, output, elapsedMs, sessionId: getSessionId() })
    },
  }
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
