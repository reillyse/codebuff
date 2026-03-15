import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { logger } from './logger'
import { loadSettings } from './settings'

import type { RunState } from '@codebuff/sdk'
import type { AgentMode } from './constants'

// Path to hippo binary - can be overridden via HIPPO_PATH env var
const HIPPO_BINARY = process.env.HIPPO_PATH ?? path.join(os.homedir(), 'Programming/hippo/build/hippo')
// Tilde path for hints that the agent can run via terminal
const HIPPO_HINT_CMD = process.env.HIPPO_PATH ?? '~/Programming/hippo/build/hippo'

// Constants for hippo search
const HIPPO_SEARCH_TIMEOUT_MS = 5000 // 5 second timeout for search
const HIPPO_QUERY_MAX_LENGTH = 500

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
  const truncatedPrompt = prompt.length > 100 
    ? prompt.substring(0, 100) + '...' 
    : prompt
  return `[${agentMode}] ${truncatedPrompt}`
}

/**
 * Extract the agent's own summary from the last assistant text block.
 * This is far more informative than file lists for future recall.
 */
const extractAgentSummary = (runState: RunState): string | null => {
  const messageHistory = runState.sessionState?.mainAgentState?.messageHistory ?? []
  
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const message = messageHistory[i]
    if (message.role !== 'assistant') continue
    if (!message.content || !Array.isArray(message.content)) continue
    
    let lastText = ''
    for (const block of message.content) {
      if (block.type === 'text') {
        const rawText = ('text' in block ? String(block.text) : '').trim()
        // Skip <think> blocks — internal reasoning, not useful for recall
        if (rawText && !rawText.startsWith('<think>')) {
          lastText = rawText
        }
      }
    }
    
    if (lastText) {
      // Sanitize for CLI argument safety: collapse newlines, limit length
      const sanitized = lastText.replace(/\n+/g, ' ').replace(/\s+/g, ' ')
      return sanitized.length > 300 ? sanitized.substring(0, 300) + '...' : sanitized
    }
  }
  
  return null
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
  
  // Try to extract the agent's own summary (most informative)
  const agentSummary = extractAgentSummary(runState)
  if (agentSummary) {
    return agentSummary
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
const runHippoSync = (args: string[]): string | null => {
  try {
    const result = spawnSync(HIPPO_BINARY, args, {
      encoding: 'utf-8',
      timeout: HIPPO_SEARCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })
    
    if (result.signal || result.error || result.status !== 0) {
      logger.debug(
        { signal: result.signal, error: result.error?.message, status: result.status, args: args.slice(0, 2) },
        'Hippo command failed'
      )
      return null
    }
    
    return result.stdout?.trim() ?? null
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to run hippo command'
    )
    return null
  }
}

const parseResultCount = (output: string): number => {
  // hippo context outputs "Retrieved X runs"
  const contextMatch = output.match(/Retrieved (\d+) runs?/)
  if (contextMatch) return parseInt(contextMatch[1], 10)
  // hippo search outputs "Found X results"
  const searchMatch = output.match(/Found (\d+) results?/)
  if (searchMatch) return parseInt(searchMatch[1], 10)
  return 0
}

/**
 * Generate lightweight hints about what Hippo knows relevant to this query.
 * Instead of dumping thousands of tokens of context, returns brief pointers
 * that tell the agent what's available and how to query for details.
 * Returns empty string if nothing relevant is found or hippo is unavailable.
 */
export const getHippoHints = (query: string): string => {
  if (!isHippoAvailable()) return ''
  
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return ''
  
  const truncatedQuery = trimmedQuery.length > HIPPO_QUERY_MAX_LENGTH
    ? trimmedQuery.substring(0, HIPPO_QUERY_MAX_LENGTH)
    : trimmedQuery
  
  logger.debug({ query: truncatedQuery }, 'Generating hippo hints')
  
  const hints: string[] = []
  
  // Quick relevance probe — use hippo context (hybrid keyword+vector+graph search)
  const contextOutput = runHippoSync(['context', truncatedQuery, '--max-tokens', '100'])
  if (contextOutput) {
    const resultCount = parseResultCount(contextOutput)
    if (resultCount > 0) {
      const shortQuery = truncatedQuery.substring(0, 60).replace(/'/g, '')
      hints.push(`- 🧠 ${resultCount} related memories found. Run: \`${HIPPO_HINT_CMD} recall '${shortQuery}' --max-tokens 2000\``)
    }
  }
  
  // Skill matching — use hippo's semantic skill search
  const skillsOutput = runHippoSync(['search-skills', truncatedQuery])
  if (skillsOutput) {
    hints.push(`- 🔧 ${skillsOutput}`)
  }
  
  // Only inject hints when something relevant was found
  if (hints.length === 0) return ''
  
  hints.push('')
  hints.push('General memory commands (via terminal):')
  hints.push(`- \`${HIPPO_HINT_CMD} search '<query>' --limit 5\` — search all memories`)
  hints.push(`- \`${HIPPO_HINT_CMD} recall '<topic>' --max-tokens 2000\` — full recall across memory tiers`)
  hints.push(`- \`${HIPPO_HINT_CMD} skills\` — learned procedures from past work`)
  hints.push(`- \`${HIPPO_HINT_CMD} concepts\` — knowledge graph of all topics`)
  
  const result = hints.join('\n')
  logger.debug({ hintLength: result.length }, 'Generated hippo hints')
  return result
}

export type StoreRunToHippoParams = {
  runState: RunState
  prompt: string
  agentMode: AgentMode
  elapsedMs: number
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
  
  const sessionId = generateHippoSessionId(agentMode)
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
  
  spawnHippoStore(args)
}

export type StoreErrorToHippoParams = {
  error: unknown
  prompt: string
  agentMode: AgentMode
  elapsedMs: number
}

/**
 * Store an error to hippo memory so we learn from failures.
 * Runs in a detached background process so it doesn't block the CLI.
 * Silently fails if hippo is not available - this is best-effort logging.
 */
export const storeErrorToHippo = (params: StoreErrorToHippoParams): void => {
  // Wrap everything in try-catch since this is best-effort and should never break the main flow
  try {
    if (!isHippoAvailable()) {
      return
    }
    
    const { error, prompt, agentMode, elapsedMs } = params
    
    const sessionId = generateHippoSessionId(agentMode)
    const inputSummary = buildInputSummary(prompt, agentMode)
    
    // Build error description
    const errorMessage = error instanceof Error ? error.message : String(error)
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const outputDescription = `Error after ${elapsedSeconds}s: ${errorMessage.substring(0, 200)}`
    
    const args = [
      'store',
      '--agent', 'codebuff',
      '--session', sessionId,
      '--input', inputSummary,
      '--output', outputDescription,
      '--outcome', 'failure',
    ]
    
    spawnHippoStore(args)
  } catch {
    // Silently ignore any errors - hippo storage should never break the error handling flow
  }
}

/**
 * Helper to spawn hippo store process in background
 */
const spawnHippoStore = (args: string[]): void => {
  try {
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
