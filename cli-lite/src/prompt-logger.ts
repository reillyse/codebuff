import fs from 'fs'
import path from 'path'

import type { AgentMode } from './hippo'

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB
const TRUNCATE_TO = 2.5 * 1024 * 1024 // Keep last ~2.5MB after truncation

export interface LogPromptParams {
  prompt: string
  enrichedPrompt: string
  sessionId: string
  agentMode: AgentMode
}

export interface LogResponseParams {
  prompt: string
  sessionId: string
  agentMode: AgentMode
  streamedText: string
  elapsedMs: number
  totalCost?: number
  outputType: string
  errorMessage?: string
}

/**
 * Resolve the log file path from the CODEBUFF_PROMPT_LOG env var.
 * Logging is OFF by default.
 *
 *  - unset / '0' / 'false' → null (disabled)
 *  - '1' / 'true'          → ./debug/prompt-log.txt (relative to cwd)
 *  - any other value        → treated as a custom file path
 */
export const getPromptLogPath = (): string | null => {
  const val = process.env.CODEBUFF_PROMPT_LOG
  if (!val || val === '0' || val === 'false') return null
  if (val === '1' || val === 'true') {
    return path.resolve(process.cwd(), 'debug', 'prompt-log.txt')
  }
  return path.resolve(val)
}

export const isPromptLoggingEnabled = (): boolean => getPromptLogPath() !== null

/**
 * Truncate the log file when it exceeds MAX_LOG_SIZE.
 * Keeps the last TRUNCATE_TO bytes, snapping to a newline boundary.
 */
const truncateIfNeeded = (filePath: string): void => {
  try {
    if (!fs.existsSync(filePath)) return
    const stat = fs.statSync(filePath)
    if (stat.size <= MAX_LOG_SIZE) return

    const content = fs.readFileSync(filePath)
    const truncated = content.slice(content.length - TRUNCATE_TO)
    const firstNewline = truncated.indexOf(10) // 0x0A = '\n'
    const clean = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated
    fs.writeFileSync(filePath, Buffer.concat([
      Buffer.from(`[truncated — kept last ~${Math.round(TRUNCATE_TO / 1024 / 1024 * 10) / 10}MB]\n\n`),
      clean,
    ]))
  } catch {
    // Best-effort truncation
  }
}

/**
 * Append an entry to the rolling log file.
 */
const appendToLog = (entry: string): void => {
  const filePath = getPromptLogPath()
  if (!filePath) return

  try {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    truncateIfNeeded(filePath)
    fs.appendFileSync(filePath, entry)
    truncateIfNeeded(filePath)
  } catch {
    // Best-effort logging — never crash on log failures
  }
}

/**
 * Append a complete prompt entry to the rolling log file.
 * Logs both the original user prompt and the enriched prompt
 * (which may include hippo context prepended).
 */
export const logPrompt = (params: LogPromptParams): void => {
  const filePath = getPromptLogPath()
  if (!filePath) return

  const timestamp = new Date().toISOString()
  const hasContext = params.enrichedPrompt !== params.prompt

  const lines = [
    '================================================================================',
    `[${timestamp}] PROMPT — session: ${params.sessionId} — mode: ${params.agentMode}`,
    '================================================================================',
    '',
  ]

  if (hasContext) {
    lines.push('--- Original Prompt ---')
    lines.push(params.prompt)
    lines.push('')
    lines.push('--- Enriched Prompt (with hippo context) ---')
    lines.push(params.enrichedPrompt)
  } else {
    lines.push(params.prompt)
  }

  lines.push('', '')

  appendToLog(lines.join('\n'))
}

/**
 * Append the agent's response/output to the rolling log file.
 * Logs the streamed text, output type, elapsed time, cost, and any error.
 */
export const logResponse = (params: LogResponseParams): void => {
  const filePath = getPromptLogPath()
  if (!filePath) return

  const timestamp = new Date().toISOString()
  const elapsedSeconds = (params.elapsedMs / 1000).toFixed(1)
  const costStr = params.totalCost != null && params.totalCost > 0
    ? `$${params.totalCost.toFixed(4)}`
    : 'n/a'

  const lines = [
    '--------------------------------------------------------------------------------',
    `[${timestamp}] RESPONSE — session: ${params.sessionId} — mode: ${params.agentMode}`,
    `  elapsed: ${elapsedSeconds}s — cost: ${costStr} — output: ${params.outputType}`,
    '--------------------------------------------------------------------------------',
    '',
  ]

  if (params.errorMessage) {
    lines.push(`--- Error ---`)
    lines.push(params.errorMessage)
    lines.push('')
  }

  if (params.streamedText) {
    lines.push('--- Agent Output ---')
    lines.push(params.streamedText)
  } else {
    lines.push('(no streamed output)')
  }

  lines.push('', '')

  appendToLog(lines.join('\n'))
}
