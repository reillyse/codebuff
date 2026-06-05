/**
 * Output formatting utilities for TUI-free CLI.
 * Plain text only — no ANSI escape codes, suitable for piping.
 */

import { writeErr } from './tty'

export function bold(text: string): string {
  return text
}

export function dim(text: string): string {
  return text
}

export function cyan(text: string): string {
  return text
}

export function green(text: string): string {
  return text
}

export function yellow(text: string): string {
  return text
}

export function red(text: string): string {
  return text
}

export function magenta(text: string): string {
  return text
}

export function blue(text: string): string {
  return text
}

export function gray(text: string): string {
  return text
}

const DEFAULT_TRUNCATE_LIMIT = 500

/**
 * Resolve the debug truncation limit from the CODEBUFF_DEBUG_TRUNCATE env var.
 * Defaults to 500. A value of 0 (or negative) disables truncation entirely.
 * Invalid values fall back to the default.
 */
function getTruncateLimit(): number {
  const raw = process.env.CODEBUFF_DEBUG_TRUNCATE
  if (raw === undefined || raw === '') return DEFAULT_TRUNCATE_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_TRUNCATE_LIMIT
  return Math.max(0, Math.floor(parsed))
}

/**
 * Stringify an arbitrary value and truncate it to the configured limit,
 * collapsing internal newlines so it stays on a single logical block.
 */
export function truncateForDebug(value: unknown): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  // Collapse internal whitespace/newlines so the output stays on one line
  // and doesn't break the `    request:`/`    response:` indentation.
  text = text.replace(/\s*\n\s*/g, ' ')
  const limit = getTruncateLimit()
  if (limit === 0 || text.length <= limit) return text
  return text.slice(0, limit) + `... [+${text.length - limit} chars]`
}

export function printToolCall(toolName: string, input?: unknown): void {
  const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  let line = `> ${displayName}`
  if (input && typeof input === 'object') {
    const summary = getToolInputSummary(toolName, input as Record<string, unknown>)
    if (summary) {
      line += ` ${summary}`
    }
  }
  writeErr(line + '\n')
  if (input !== undefined && input !== null) {
    writeErr(`    request: ${truncateForDebug(input)}\n`)
  }
}

function getToolInputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_files':
      if (Array.isArray(input.paths)) {
        return `(${input.paths.length} file${input.paths.length === 1 ? '' : 's'})`
      }
      return ''
    case 'write_file':
    case 'str_replace':
    case 'apply_patch':
      if (typeof input.path === 'string') {
        return input.path
      }
      return ''
    case 'run_terminal_command':
      if (typeof input.command === 'string') {
        const cmd = input.command.length > 60
          ? input.command.slice(0, 57) + '...'
          : input.command
        return `$ ${cmd}`
      }
      return ''
    case 'code_search':
      if (typeof input.pattern === 'string') {
        return `"${input.pattern}"`
      }
      return ''
    case 'list_directory':
      if (typeof input.path === 'string') {
        return input.path
      }
      return ''
    case 'glob':
      if (typeof input.pattern === 'string') {
        return input.pattern
      }
      return ''
    default:
      return ''
  }
}

export function printToolResult(toolName: string, success: boolean, output?: unknown): void {
  const icon = success ? '[ok]' : '[fail]'
  const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  writeErr(`  ${icon} ${displayName} done\n`)
  if (output !== undefined && output !== null) {
    writeErr(`    response: ${truncateForDebug(output)}\n`)
  }
}

export function printError(message: string): void {
  writeErr(`Error: ${message}\n`)
}

export function printWarning(message: string): void {
  writeErr(`Warning: ${message}\n`)
}

export function printInfo(message: string): void {
  writeErr(`${message}\n`)
}

/** Print a truncated prompt and params block (used by subagent start/finish). */
function printPromptAndParams(prompt?: string, params?: unknown): void {
  if (prompt) {
    writeErr(`    prompt: ${truncateForDebug(prompt)}\n`)
  }
  if (params && typeof params === 'object' && Object.keys(params).length > 0) {
    writeErr(`    params: ${truncateForDebug(params)}\n`)
  }
}

export function printSubagentStart(
  agentId: string,
  displayName: string,
  model?: string,
  prompt?: string,
  params?: unknown,
): void {
  const modelSuffix = model ? ` (${model})` : ''
  writeErr(`* Agent: ${displayName}${modelSuffix}\n`)
  printPromptAndParams(prompt, params)
}

export function printSubagentEnd(
  agentId: string,
  displayName?: string,
  model?: string,
  prompt?: string,
  params?: unknown,
): void {
  if (displayName) {
    const modelSuffix = model ? ` (${model})` : ''
    writeErr(`* Agent finished: ${displayName}${modelSuffix}\n`)
  } else {
    writeErr(`* Agent finished\n`)
  }
  printPromptAndParams(prompt, params)
}

export function printDivider(): void {
  const width = Math.min(process.stdout.columns || 80, 80)
  writeErr(`${'-'.repeat(width)}\n`)
}

// The `finish` event's totalCost is reported in credits, where 1 credit = $0.01.
export const CREDITS_PER_DOLLAR = 100

export function formatCredits(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR
  return `${credits.toLocaleString()} credits ($${dollars.toFixed(2)})`
}

export function printFinish(totalCreditsUsed: number): void {
  const costStr = totalCreditsUsed > 0 ? ` (cost: ${formatCredits(totalCreditsUsed)})` : ''
  writeErr(`Done${costStr}\n`)
}

export function printBanner(): void {
  writeErr('\nCodebuff Lite (TUI-free mode)\n')
  writeErr('Type your prompt, then press Enter. Use Ctrl+C to exit.\n')
  writeErr('Use /help for commands.\n\n')
}
