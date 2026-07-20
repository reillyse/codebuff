/**
 * api-request-logger.ts
 *
 * Writes a rolling human-readable log of every LLM API request to
 * {projectRoot}/debug/api-request-log.txt.
 *
 * Enabled via:   CODEBUFF_API_REQUEST_LOG=1  (off by default)
 *
 * The log is capped at 5 MB; when it exceeds that, the oldest ~2.5 MB
 * is trimmed so the file stays bounded. Never throws — all I/O is best-effort.
 *
 * Use this to understand EXACTLY what is in the context window before each
 * LLM call, without needing to parse cli.jsonl with Python scripts.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import path from 'path'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolSet } from 'ai'

// Each full request dump can be 200-800 KB (full system+messages). Use a
// larger cap so at least a handful of recent requests are always readable.
const MAX_LOG_SIZE = 50 * 1024 * 1024 // 50 MB
const TRUNCATE_TO = 25 * 1024 * 1024 // Keep last ~25 MB after truncation

/** Estimate token count from a raw string (chars ÷ 4, a ~10% over-estimate). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Serialize a value to a JSON string without throwing. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Trim the log file to TRUNCATE_TO bytes, snapping to a newline boundary. */
function truncateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size <= MAX_LOG_SIZE) return

    const content = readFileSync(filePath)
    const kept = content.slice(content.length - TRUNCATE_TO)
    const firstNewline = kept.indexOf(10) // 0x0A = '\n'
    const clean = firstNewline >= 0 ? kept.slice(firstNewline + 1) : kept
    writeFileSync(
      filePath,
      Buffer.concat([
        Buffer.from(
          `[--- log truncated — keeping last ~${Math.round(TRUNCATE_TO / 1024 / 1024)}MB ---]\n\n`,
        ),
        clean,
      ]),
    )
  } catch {
    // Best-effort — never block the caller
  }
}

/** Append raw text to the log file. Creates the directory if needed. */
function appendToLog(filePath: string, text: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    truncateIfNeeded(filePath)
    appendFileSync(filePath, text)
  } catch {
    // Best-effort — never throw from logging
  }
}

/**
 * Extract a short human-readable label for a message, e.g. "user/STEP_PROMPT"
 * or "assistant" or "tool/read_files".
 */
function messageLabel(msg: Message): string {
  const role = msg.role
  if ('tags' in msg && Array.isArray((msg as any).tags) && (msg as any).tags.length > 0) {
    return `${role}/${(msg as any).tags.join(',')}`
  }
  if (role === 'tool' && 'toolName' in msg) {
    return `tool/${(msg as any).toolName}`
  }
  return role
}

/** Compute the serialized character length of a message. */
function messageChars(msg: Message): number {
  return safeStringify(msg).length
}

export interface LogApiRequestParams {
  /** Absolute path to the project root (used to resolve the log file path). */
  projectRoot: string | undefined
  /** Agent template ID, e.g. "base2". */
  agentType: string
  /** Step number within the current agent loop. */
  stepNumber: number
  /** LLM model identifier. */
  model: string
  /** System prompt string sent to the model. */
  system: string
  /** Message history (NOT including the system message). */
  messages: Message[]
  /** Tool set available to the model. */
  tools: ToolSet | undefined
  /** Context token count from the most recent estimate (may be undefined). */
  contextTokenCount: number | undefined
}

/**
 * Write one pre-LLM-call breakdown entry to
 * {projectRoot}/debug/api-request-log.txt.
 *
 * Does nothing when CODEBUFF_API_REQUEST_LOG is unset / '0' / 'false'.
 * Best-effort: never throws.
 */
export function logApiRequest(params: LogApiRequestParams): void {
  // Opt-out via CODEBUFF_API_REQUEST_LOG=0 or CODEBUFF_API_REQUEST_LOG=false
  // (on by default so debug/api-request-log.txt is always populated).
  const envVal = process.env.CODEBUFF_API_REQUEST_LOG
  if (envVal === '0' || envVal === 'false') return

  const { projectRoot, agentType, stepNumber, model, system, messages, tools, contextTokenCount } =
    params

  if (!projectRoot) return

  const logPath = path.join(projectRoot, 'debug', 'api-request-log.txt')
  const timestamp = new Date().toISOString()

  // ── System prompt ────────────────────────────────────────────────────────
  const systemChars = system.length
  const systemTokenEst = estimateTokens(systemChars)

  // ── Tools ────────────────────────────────────────────────────────────────
  const toolNames = tools ? Object.keys(tools) : []
  const toolCount = toolNames.length
  const toolsJson = tools ? safeStringify(tools) : ''
  const toolsChars = toolsJson.length
  const toolsTokenEst = estimateTokens(toolsChars)

  // ── Messages ─────────────────────────────────────────────────────────────
  const msgRows: { label: string; chars: number; tokenEst: number; preview: string }[] = []
  let totalMsgChars = 0
  for (const msg of messages) {
    const chars = messageChars(msg)
    totalMsgChars += chars
    const raw = safeStringify(msg)
    // Preview: first 120 chars of the serialized message content
    const preview = raw.slice(0, 120).replace(/\n/g, ' ')
    msgRows.push({ label: messageLabel(msg), chars, tokenEst: estimateTokens(chars), preview })
  }
  const totalMsgTokenEst = estimateTokens(totalMsgChars)

  // ── Grand total estimate ─────────────────────────────────────────────────
  const grandTotalEst = systemTokenEst + toolsTokenEst + totalMsgTokenEst

  // ── Format entry ─────────────────────────────────────────────────────────
  const sep = '='.repeat(80)
  const thin = '-'.repeat(80)

  const lines: string[] = [
    sep,
    `[${timestamp}] API REQUEST  agent=${agentType}  step=${stepNumber}  model=${model}`,
    sep,
    '',
    `SYSTEM PROMPT  ${systemChars.toLocaleString()} chars  (~${systemTokenEst.toLocaleString()} tokens)`,
    '',
    `TOOLS  ${toolCount} tools  ${toolsChars.toLocaleString()} chars  (~${toolsTokenEst.toLocaleString()} tokens)`,
  ]

  // List up to the first 60 tool names (enough to spot the sparrow__ flood)
  const toolNamesToShow = toolCount > 60 ? [...toolNames.slice(0, 60), `... +${toolCount - 60} more`] : toolNames
  for (const name of toolNamesToShow) {
    lines.push(`  • ${name}`)
  }

  lines.push('')
  lines.push(`MESSAGES  ${messages.length} messages  ${totalMsgChars.toLocaleString()} chars  (~${totalMsgTokenEst.toLocaleString()} tokens)`)

  msgRows.forEach((row, i) => {
    lines.push('')
    lines.push(
      `  #${i}  [${row.label}]  ${row.chars.toLocaleString()} chars (~${row.tokenEst.toLocaleString()} tokens)`,
    )
    lines.push('  ' + thin)
    lines.push(safeStringify(messages[i]))
    lines.push('  ' + thin)
  })

  lines.push('')
  lines.push('SYSTEM PROMPT (full)')
  lines.push(thin)
  lines.push(system)
  lines.push(thin)
  lines.push('')
  lines.push('TOOLS (full JSON)')
  lines.push(thin)
  lines.push(toolsJson)
  lines.push(thin)
  lines.push('')
  lines.push(thin)
  lines.push('TOTALS (estimated)')
  lines.push(`  system:    ${systemChars.toLocaleString()} chars  (~${systemTokenEst.toLocaleString()} tokens)`)
  lines.push(`  tools:     ${toolsChars.toLocaleString()} chars  (~${toolsTokenEst.toLocaleString()} tokens)`)
  lines.push(`  messages:  ${totalMsgChars.toLocaleString()} chars  (~${totalMsgTokenEst.toLocaleString()} tokens)`)
  lines.push(`  GRAND EST: ~${grandTotalEst.toLocaleString()} tokens`)
  if (contextTokenCount !== undefined) {
    lines.push(`  ACTUAL CTX: ${contextTokenCount.toLocaleString()} tokens  (from last token-count API call)`)
  }
  lines.push(thin)
  lines.push('', '')

  appendToLog(logPath, lines.join('\n'))
}

export interface LogRawApiRequestParams {
  /** Absolute path to the project root (used to resolve the log file path). */
  projectRoot: string | undefined
  /** Agent template ID, e.g. "base2". */
  agentType: string
  /** Step number within the current agent loop. */
  stepNumber: number
  /** LLM model identifier. */
  model: string
  /** Provider name that built the wire body, e.g. "anthropic". */
  provider: string
  /** The exact wire body sent to the provider (no reconstruction). */
  rawBody: unknown
}

/**
 * Write the EXACT raw wire body sent to the provider to
 * {projectRoot}/debug/api-request-log.txt.
 *
 * Unlike logApiRequest (which reconstructs an approximate breakdown from the
 * pre-call params), this logs the real payload captured at the point it was
 * built, so the log never drifts from what the model actually received.
 *
 * Does nothing when CODEBUFF_API_REQUEST_LOG is '0' / 'false'.
 * Best-effort: never throws.
 */
export function logRawApiRequest(params: LogRawApiRequestParams): void {
  const envVal = process.env.CODEBUFF_API_REQUEST_LOG
  if (envVal === '0' || envVal === 'false') return

  const { projectRoot, agentType, stepNumber, model, provider, rawBody } =
    params

  if (!projectRoot) return

  const logPath = path.join(projectRoot, 'debug', 'api-request-log.txt')
  const timestamp = new Date().toISOString()
  const sep = '='.repeat(80)

  const lines: string[] = [
    sep,
    `[${timestamp}] API REQUEST (raw wire body)  agent=${agentType}  step=${stepNumber}  model=${model}  provider=${provider}`,
    sep,
    '',
    safeStringify(rawBody),
    '',
    '',
  ]

  appendToLog(logPath, lines.join('\n'))
}
