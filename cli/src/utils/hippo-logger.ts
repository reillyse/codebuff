import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import path from 'path'

import { loadSettings } from './settings'
import { getProjectRoot } from '../project-files'

const MAX_LOG_SIZE = 20 * 1024 * 1024 // 20MB
const TRUNCATE_TO = 10 * 1024 * 1024 // Keep last 10MB after truncation

const INTERACTIONS_LOG = 'hippo-interactions.log'
const PROMPTS_LOG = 'hippo-prompts.log'

let cachedLoggingEnabled: boolean | null = null

export const isHippoLoggingEnabled = (): boolean => {
  if (cachedLoggingEnabled === null) {
    cachedLoggingEnabled = loadSettings().hippoLoggingEnabled === true
  }
  return cachedLoggingEnabled
}

export const resetHippoLoggingCache = (): void => {
  cachedLoggingEnabled = null
}

const getLogPath = (filename: string): string | null => {
  try {
    const projectRoot = getProjectRoot()
    const dir = path.join(projectRoot, 'debug')
    mkdirSync(dir, { recursive: true })
    return path.join(dir, filename)
  } catch {
    return null
  }
}

const truncateIfNeeded = (filePath: string): void => {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size <= MAX_LOG_SIZE) return

    const content = readFileSync(filePath)
    const truncated = content.slice(content.length - TRUNCATE_TO)
    const firstNewline = truncated.indexOf(10) // 0x0A = '\n'
    const clean = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated
    writeFileSync(filePath, Buffer.concat([
      Buffer.from(`[truncated — kept last ~${Math.round(TRUNCATE_TO / 1024 / 1024)}MB]\n\n`),
      clean,
    ]))
  } catch {
    // Best-effort truncation
  }
}

const appendToLog = (filename: string, entry: string): void => {
  if (!isHippoLoggingEnabled()) return
  const filePath = getLogPath(filename)
  if (!filePath) return

  try {
    truncateIfNeeded(filePath)
    appendFileSync(filePath, entry)
  } catch {
    // Best-effort logging
  }
}

/**
 * Log a raw hippo CLI interaction (args sent and response received).
 * Written to debug/hippo-interactions.log.
 */
export const logHippoInteraction = (
  args: string[],
  response: string | null,
  durationMs?: number,
): void => {
  const timestamp = new Date().toISOString()
  const lines = [
    '================================================================================',
    `[${timestamp}] HIPPO CLI CALL`,
    `Args: hippo ${args.join(' ')}`,
  ]
  if (durationMs != null) {
    lines.push(`Duration: ${durationMs}ms`)
  }
  lines.push('')
  if (response != null) {
    lines.push('--- Response ---')
    lines.push(response)
  } else {
    lines.push('--- No response ---')
  }
  lines.push('', '')

  appendToLog(INTERACTIONS_LOG, lines.join('\n'))
}

/**
 * Log a hippo prompt query, response, or store operation.
 * Written to debug/hippo-prompts.log.
 */
export const logHippoPrompt = (
  direction: 'query' | 'response' | 'store',
  content: string,
  metadata?: Record<string, unknown>,
): void => {
  const timestamp = new Date().toISOString()
  const arrow = direction === 'query' ? '→' : direction === 'response' ? '←' : '⇒'
  const label = direction === 'query' ? 'QUERY' : direction === 'response' ? 'RESPONSE' : 'STORE'

  const lines = [
    '================================================================================',
    `[${timestamp}] ${label} ${arrow} hippo`,
  ]

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value != null) {
        lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      }
    }
  }

  lines.push('')
  lines.push(content)
  lines.push('', '')

  appendToLog(PROMPTS_LOG, lines.join('\n'))
}
