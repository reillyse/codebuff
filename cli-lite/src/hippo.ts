import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import type { RunState } from '@codebuff/sdk'

import { writeErr } from './tty'

// ---------------------------------------------------------------------------
// Lightweight replacements for TUI-specific dependencies
// ---------------------------------------------------------------------------

export type AgentMode = 'DEFAULT' | 'FREE' | 'MAX' | 'PLAN'

const debug = (...args: unknown[]): void => {
  if (process.env.HIPPO_DEBUG) {
    writeErr(`[hippo] ${args.map(String).join(' ')}\n`)
  }
}

/**
 * Read hippoEnabled from ~/.config/manicode/settings.json without
 * importing the CLI's auth / settings modules.
 */
const loadHippoEnabled = (): boolean => {
  try {
    const env = process.env.NEXT_PUBLIC_CB_ENVIRONMENT ?? 'prod'
    const suffix = env !== 'prod' ? `-${env}` : ''
    const settingsPath = path.join(os.homedir(), '.config', `manicode${suffix}`, 'settings.json')
    if (!fs.existsSync(settingsPath)) return true // default: enabled
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return parsed.hippoEnabled !== false
  } catch {
    return true
  }
}

/**
 * Save hippoEnabled to ~/.config/manicode/settings.json.
 */
export const saveHippoEnabled = (enabled: boolean): void => {
  try {
    const env = process.env.NEXT_PUBLIC_CB_ENVIRONMENT ?? 'prod'
    const suffix = env !== 'prod' ? `-${env}` : ''
    const configDir = path.join(os.homedir(), '.config', `manicode${suffix}`)
    const settingsPath = path.join(configDir, 'settings.json')
    fs.mkdirSync(configDir, { recursive: true })
    let settings: Record<string, unknown> = {}
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      }
    } catch { /* ignore */ }
    settings.hippoEnabled = enabled
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Hippo binary resolution
// ---------------------------------------------------------------------------

export const resolveHippoBinary = (): string => {
  if (process.env.HIPPO_PATH) return process.env.HIPPO_PATH

  try {
    const result = execFileSync('which', ['hippo'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (result) return result
  } catch {
    // hippo not found in PATH
  }

  return path.join(os.homedir(), 'Programming/hippo/build/hippo')
}

export const HIPPO_BINARY = resolveHippoBinary()

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIPPO_SEARCH_TIMEOUT_MS = 5000
const HIPPO_CONTEXT_SEARCH_TIMEOUT_MS = 15000
const HIPPO_QUERY_MAX_LENGTH = 500

const FILE_WRITE_TOOLS = ['write_file', 'str_replace', 'propose_write_file', 'propose_str_replace']
const FILE_READ_TOOLS = ['read_files', 'read_subtree']
const COMMAND_TOOLS = ['run_terminal_command']

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

export const isHippoAvailable = (): boolean => {
  if (!loadHippoEnabled()) {
    debug('Hippo is disabled in settings')
    return false
  }
  if (!fs.existsSync(HIPPO_BINARY)) {
    debug('Hippo binary not found at', HIPPO_BINARY)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Async hippo CLI runner
// ---------------------------------------------------------------------------

type HippoRunResult = { stdout: string | null; error: string | null }

const runHippoAsync = (args: string[], timeoutMs = HIPPO_SEARCH_TIMEOUT_MS): Promise<HippoRunResult> => {
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
          debug('Hippo command timed out')
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
          debug('Hippo command failed with exit code', code)
          resolve({ stdout: null, error: `Command failed (exit ${code})` })
          return
        }
        resolve({ stdout: Buffer.concat(chunks).toString('utf-8').trim(), error: null })
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        debug('Failed to run hippo command:', error.message)
        resolve({ stdout: null, error: error.message })
      })
    } catch (error) {
      debug('Failed to spawn hippo command:', error instanceof Error ? error.message : String(error))
      resolve({ stdout: null, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

export const generateHippoSessionId = (agentMode: AgentMode): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `codebuff-lite-${agentMode.toLowerCase()}-${year}-${month}-${day}-${hours}${minutes}`
}

// ---------------------------------------------------------------------------
// Extract files from run history
// ---------------------------------------------------------------------------

const extractFilesFromHistory = (runState: RunState): {
  filesChanged: string[]
  filesRead: string[]
  commandsRun: string[]
} => {
  const filesChanged = new Set<string>()
  const filesRead = new Set<string>()
  const commandsRun: string[] = []

  const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []

  for (const message of messageHistory) {
    if (!message.content || !Array.isArray(message.content)) continue

    for (const block of message.content) {
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
    commandsRun: commandsRun.slice(0, 5),
  }
}

// ---------------------------------------------------------------------------
// Summary builders
// ---------------------------------------------------------------------------

const buildInputSummary = (prompt: string, agentMode: AgentMode): string => {
  const truncatedPrompt = prompt.length > 200
    ? prompt.substring(0, 200) + '...'
    : prompt
  return `[${agentMode}] ${truncatedPrompt}`
}

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
  if (latestTodosDescription) parts.push(latestTodosDescription)
  if (followupsDescription) parts.push(followupsDescription)
  if (parts.length === 0) return null

  const combined = parts.join(' | ').replace(/\n+/g, ' ').replace(/\s+/g, ' ')
  return combined.length > 1000 ? combined.substring(0, 1000) + '...' : combined
}

const buildOutputDescription = (
  runState: RunState,
  elapsedMs: number,
  filesChanged: string[],
): string => {
  if (runState.output?.type === 'error') {
    return `Error: ${runState.output.message ?? 'Unknown error'}`
  }

  const richSummary = buildRichRunSummary(runState)
  if (richSummary) return richSummary

  const parts: string[] = []
  if (filesChanged.length > 0) {
    const fileList = filesChanged.slice(0, 5).join(', ')
    const moreFiles = filesChanged.length > 5 ? ` +${filesChanged.length - 5} more` : ''
    parts.push(`Modified: ${fileList}${moreFiles}.`)
  }

  if (parts.length === 0) {
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const messageCount = runState.sessionState?.mainAgentState?.messageHistory?.length ?? 0
    parts.push(`Completed in ${elapsedSeconds}s with ${messageCount} messages.`)
  }

  return parts.join(' ')
}

const getOutcome = (
  runState: RunState,
  filesChanged: string[],
  filesRead: string[],
): 'success' | 'failure' | 'discovery' => {
  if (runState.output?.type === 'error') return 'failure'
  if (filesChanged.length === 0 && filesRead.length > 0) return 'discovery'
  return 'success'
}

// ---------------------------------------------------------------------------
// Conversation context builder
// ---------------------------------------------------------------------------

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
  if (recentPrompts.length > 0) parts.push(`Recently working on: ${recentPrompts.join('; ')}`)
  if (filesChanged.length > 0) parts.push(`Files modified: ${filesChanged.slice(0, 8).join(', ')}`)
  if (filesRead.length > 0) parts.push(`Files read: ${filesRead.slice(0, 8).join(', ')}`)
  return parts.join('. ') + '.'
}

// ---------------------------------------------------------------------------
// Retryable error check
// ---------------------------------------------------------------------------

const isRetryableHippoError = (error: string | null): boolean => {
  if (!error) return false
  return error.startsWith('Connection timed out') || error.startsWith('Command failed')
}

// ---------------------------------------------------------------------------
// getHippoContext
// ---------------------------------------------------------------------------

export type HippoContextResult = {
  context: string
  connectionOk: boolean | null
  lastError: string | null
}

export const getHippoContext = async (
  query: string,
  previousRunState: RunState | null,
  sessionId?: string,
): Promise<HippoContextResult> => {
  try {
    if (!isHippoAvailable()) return { context: '', connectionOk: null, lastError: null }

    const trimmedQuery = query.trim()
    if (!trimmedQuery) return { context: '', connectionOk: null, lastError: null }

    const truncatedQuery = trimmedQuery.length > HIPPO_QUERY_MAX_LENGTH
      ? trimmedQuery.substring(0, HIPPO_QUERY_MAX_LENGTH)
      : trimmedQuery

    debug('Fetching hippo context for query:', truncatedQuery.substring(0, 80))

    const args = ['context-search', truncatedQuery]

    const contextString = buildConversationContext(previousRunState)
    if (contextString) args.push('--context', contextString)
    if (sessionId) args.push('--session', sessionId)

    let { stdout, error: hippoError } = await runHippoAsync(args, HIPPO_CONTEXT_SEARCH_TIMEOUT_MS)

    // Auto-retry once on transient errors
    if (stdout === null && isRetryableHippoError(hippoError)) {
      debug('Hippo context-search failed, retrying once')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      const retry = await runHippoAsync(args, HIPPO_SEARCH_TIMEOUT_MS)
      stdout = retry.stdout
      hippoError = retry.error
    }

    if (stdout === null) {
      return { context: '', connectionOk: false, lastError: hippoError }
    }

    const trimmedResult = stdout.trim()

    if (!trimmedResult || trimmedResult.toUpperCase() === 'NONE' || trimmedResult.length < 20) {
      debug('Hippo context-search found nothing relevant')
      return { context: '', connectionOk: true, lastError: null }
    }

    debug('Hippo context extracted, length:', trimmedResult.length)
    return { context: trimmedResult, connectionOk: true, lastError: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    debug('Hippo context-search failed:', errorMessage)
    return { context: '', connectionOk: false, lastError: errorMessage }
  }
}

// ---------------------------------------------------------------------------
// checkHippoConnection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// storeRunToHippo
// ---------------------------------------------------------------------------

export type StoreRunToHippoParams = {
  runState: RunState
  prompt: string
  agentMode: AgentMode
  elapsedMs: number
  sessionId?: string
}

export const storeRunToHippo = (params: StoreRunToHippoParams): void => {
  if (!isHippoAvailable()) return

  const { runState, prompt, agentMode, elapsedMs } = params
  const { filesChanged, filesRead } = extractFilesFromHistory(runState)

  const sessionId = params.sessionId ?? generateHippoSessionId(agentMode)
  const inputSummary = buildInputSummary(prompt, agentMode)
  const outputDescription = buildOutputDescription(runState, elapsedMs, filesChanged)
  const outcome = getOutcome(runState, filesChanged, filesRead)

  const args = [
    'store',
    '--agent', 'codebuff-lite',
    '--session', sessionId,
    '--input', inputSummary,
    '--output', outputDescription,
    '--outcome', outcome,
  ]

  if (filesChanged.length > 0) {
    args.push('--files-changed', filesChanged.slice(0, 10).join(','))
  }

  debug('Storing run to hippo:', outcome)
  spawnHippoStore(args)
}

// ---------------------------------------------------------------------------
// storeErrorToHippo
// ---------------------------------------------------------------------------

const isErrorWorthStoring = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('out of credits') || lower.includes('payment') || lower.includes('insufficient credits')) return false
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout')) return false
  if (lower.includes('fetch failed') || lower.includes('network error')) return false
  if (lower.includes('timeout') && !lower.includes('context')) return false
  return true
}

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

  debug('Storing error to hippo')

  spawnHippoStore([
    'store',
    '--agent', 'codebuff-lite',
    '--session', sessionId,
    '--input', 'Error during run',
    '--output', outputLine,
    '--outcome', 'failure',
  ])
}

// ---------------------------------------------------------------------------
// Background hippo store spawner
// ---------------------------------------------------------------------------

const spawnHippoStore = (args: string[]): void => {
  try {
    const child = spawn(HIPPO_BINARY, args, {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    })
    child.unref()
  } catch (error) {
    debug('Failed to spawn hippo store:', error instanceof Error ? error.message : String(error))
  }
}
