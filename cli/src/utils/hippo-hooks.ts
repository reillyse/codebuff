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
 * Extract concepts from file paths for hippo tagging
 */
const extractConceptsFromFiles = (files: string[]): string[] => {
  const concepts = new Set<string>()
  
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const basename = path.basename(file).toLowerCase()
    
    // Language/framework concepts
    if (ext === '.ts' || ext === '.tsx') concepts.add('typescript')
    if (ext === '.tsx' || file.includes('/components/') || file.includes('/hooks/')) concepts.add('react')
    if (ext === '.py') concepts.add('python')
    if (ext === '.go') concepts.add('go')
    if (ext === '.rs') concepts.add('rust')
    if (ext === '.js' || ext === '.jsx') concepts.add('javascript')
    if (ext === '.css' || ext === '.scss') concepts.add('styling')
    if (ext === '.json') concepts.add('config')
    if (ext === '.md' || ext === '.mdx') concepts.add('documentation')
    
    // File type concepts
    if (basename.includes('.test.') || basename.includes('.spec.') || file.includes('__tests__')) {
      concepts.add('tests')
    }
    if (file.includes('/api/') || file.includes('routes')) concepts.add('api')
    if (file.includes('/hooks/')) concepts.add('hooks')
    if (file.includes('/utils/') || file.includes('/helpers/')) concepts.add('utilities')
  }
  
  return Array.from(concepts)
}

/**
 * Extract concepts from run output for hippo tagging
 */
const extractConcepts = (runState: RunState, filesChanged: string[], filesRead: string[]): string[] => {
  const concepts: string[] = ['codebuff']
  
  if (runState.output?.type === 'error') {
    concepts.push('error')
  } else {
    concepts.push('success')
  }
  
  // Add concepts from files touched
  const allFiles = [...filesChanged, ...filesRead]
  const fileConcepts = extractConceptsFromFiles(allFiles)
  concepts.push(...fileConcepts)
  
  // Add concept if files were actually changed
  if (filesChanged.length > 0) {
    concepts.push('code-changes')
  }
  
  return [...new Set(concepts)] // Deduplicate
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
 * Build a detailed output description for hippo's --output field
 */
const buildOutputDescription = (
  runState: RunState, 
  elapsedMs: number,
  filesChanged: string[],
  filesRead: string[],
  commandsRun: string[]
): string => {
  const parts: string[] = []
  
  // Handle errors first
  if (runState.output?.type === 'error') {
    parts.push(`Error: ${runState.output.message ?? 'Unknown error'}`)
    return parts.join(' ')
  }
  
  // Describe what was done based on tool usage
  if (filesChanged.length > 0) {
    const fileList = filesChanged.slice(0, 5).map(f => path.basename(f)).join(', ')
    const moreFiles = filesChanged.length > 5 ? ` +${filesChanged.length - 5} more` : ''
    parts.push(`Modified: ${fileList}${moreFiles}.`)
  }
  
  if (filesRead.length > 0 && filesChanged.length === 0) {
    // Only mention reads if nothing was changed (analysis/exploration run)
    parts.push(`Analyzed ${filesRead.length} files.`)
  }
  
  if (commandsRun.length > 0) {
    parts.push(`Ran ${commandsRun.length} command(s).`)
  }
  
  // If no significant activity, fall back to basic description
  if (parts.length === 0) {
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const messageCount = runState.sessionState?.mainAgentState?.messageHistory?.length ?? 0
    parts.push(`Completed in ${elapsedSeconds}s with ${messageCount} messages.`)
  }
  
  return parts.join(' ')
}

/**
 * Determine outcome type for hippo based on run result
 */
const getOutcome = (runState: RunState): 'success' | 'failure' => {
  if (runState.output?.type === 'error') {
    return 'failure'
  }
  // structuredOutput, lastMessage, allMessages all indicate success
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
 * Get recent snapshot from hippo (last N runs)
 */
const getRecentSnapshot = (limit: number = 5): string => {
  const args = [
    'snapshot',
    '--limit', String(limit),
    '--short',
  ]
  
  try {
    const result = spawnSync(HIPPO_BINARY, args, {
      encoding: 'utf-8',
      timeout: HIPPO_SEARCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })
    
    if (result.signal || result.error || result.status !== 0) {
      logger.debug(
        { signal: result.signal, error: result.error?.message, status: result.status },
        'Hippo snapshot failed'
      )
      return ''
    }
    
    return result.stdout?.trim() ?? ''
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to get hippo snapshot'
    )
    return ''
  }
}

/**
 * Get semantic context from hippo for the query
 */
const getSemanticContext = (query: string, maxTokens: number): string => {
  const args = [
    'context',
    query,
    '--max-tokens', String(maxTokens),
  ]
  
  try {
    const result = spawnSync(HIPPO_BINARY, args, {
      encoding: 'utf-8',
      timeout: HIPPO_SEARCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })
    
    if (result.signal || result.error || result.status !== 0) {
      logger.debug(
        { signal: result.signal, error: result.error?.message, status: result.status },
        'Hippo semantic context failed'
      )
      return ''
    }
    
    const context = result.stdout?.trim() ?? ''
    
    // Filter out empty results
    if (!context || context.includes('Found 0 results')) {
      return ''
    }
    
    return context
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to get hippo semantic context'
    )
    return ''
  }
}

/**
 * Search hippo for prior context related to the query.
 * Combines recent snapshot with semantic search for comprehensive context.
 * Returns empty string if hippo is disabled, not installed, or search fails.
 */
export const searchHippoContext = (query: string, maxTokens: number = 4000): string => {
  if (!isHippoAvailable()) {
    return ''
  }
  
  // Return early if query is empty
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return ''
  }
  
  // Truncate query if too long for command line
  const truncatedQuery = trimmedQuery.length > HIPPO_QUERY_MAX_LENGTH 
    ? trimmedQuery.substring(0, HIPPO_QUERY_MAX_LENGTH) 
    : trimmedQuery
  
  logger.debug(
    { query: truncatedQuery },
    'Searching hippo for prior context'
  )
  
  // Get both recent snapshot and semantic context
  const recentSnapshot = getRecentSnapshot(5)
  const semanticTokenBudget = recentSnapshot ? Math.floor(maxTokens * 0.7) : maxTokens
  const semanticContext = getSemanticContext(truncatedQuery, semanticTokenBudget)
  
  // Combine results with section headers for clarity
  const parts: string[] = []
  
  if (recentSnapshot) {
    parts.push(`### Recent Activity:\n${recentSnapshot}`)
  }
  
  if (semanticContext) {
    // Only add semantic context if it's different from recent snapshot
    if (!recentSnapshot || !recentSnapshot.includes(semanticContext.substring(0, 100))) {
      parts.push(`### Related Context:\n${semanticContext}`)
    }
  }
  
  if (parts.length === 0) {
    return ''
  }
  
  const combined = parts.join('\n\n')
  
  logger.debug(
    { contextLength: combined.length, hasSnapshot: !!recentSnapshot, hasSemantic: !!semanticContext },
    'Retrieved combined context from hippo'
  )
  
  return combined
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
  const concepts = extractConcepts(runState, filesChanged, filesRead)
  const outcome = getOutcome(runState)
  
  const args = [
    'store',
    '--agent', 'codebuff',
    '--session', sessionId,
    '--input', inputSummary,
    '--output', outputDescription,
    '--concepts', concepts.join(','),
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
    
    const concepts = ['codebuff', 'error', agentMode.toLowerCase()]
    
    const args = [
      'store',
      '--agent', 'codebuff',
      '--session', sessionId,
      '--input', inputSummary,
      '--output', outputDescription,
      '--concepts', concepts.join(','),
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
