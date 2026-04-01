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

export function printToolResult(toolName: string, success: boolean): void {
  const icon = success ? '[ok]' : '[fail]'
  const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  writeErr(`  ${icon} ${displayName} done\n`)
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

export function printSubagentStart(agentId: string, displayName: string, model?: string): void {
  const modelSuffix = model ? ` (${model})` : ''
  writeErr(`* Agent: ${displayName}${modelSuffix}\n`)
}

export function printSubagentEnd(agentId: string): void {
  writeErr(`* Agent finished\n`)
}

export function printDivider(): void {
  const width = Math.min(process.stdout.columns || 80, 80)
  writeErr(`${'-'.repeat(width)}\n`)
}

export function printFinish(totalCost: number): void {
  const costStr = totalCost > 0 ? ` (cost: $${totalCost.toFixed(4)})` : ''
  writeErr(`Done${costStr}\n`)
}

export function printBanner(): void {
  writeErr('\nCodebuff Lite (TUI-free mode)\n')
  writeErr('Type your prompt, then press Enter. Use Ctrl+C to exit.\n')
  writeErr('Use /help for commands.\n\n')
}
