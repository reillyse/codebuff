/**
 * Output formatting utilities for TUI-free CLI.
 * Handles ANSI colors, streaming text, tool call display, etc.
 */

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'
const BLUE = '\x1b[34m'
const GRAY = '\x1b[90m'

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`
}

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`
}

export function red(text: string): string {
  return `${RED}${text}${RESET}`
}

export function magenta(text: string): string {
  return `${MAGENTA}${text}${RESET}`
}

export function blue(text: string): string {
  return `${BLUE}${text}${RESET}`
}

export function gray(text: string): string {
  return `${GRAY}${text}${RESET}`
}

export function printToolCall(toolName: string, input?: unknown): void {
  const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  process.stderr.write(`${DIM}${CYAN}⚡ ${displayName}${RESET}`)
  if (input && typeof input === 'object') {
    const summary = getToolInputSummary(toolName, input as Record<string, unknown>)
    if (summary) {
      process.stderr.write(`${DIM} ${summary}${RESET}`)
    }
  }
  process.stderr.write('\n')
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
  const icon = success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  process.stderr.write(`${DIM}  ${icon} ${displayName} done${RESET}\n`)
}

export function printError(message: string): void {
  process.stderr.write(`${RED}${BOLD}Error:${RESET} ${RED}${message}${RESET}\n`)
}

export function printWarning(message: string): void {
  process.stderr.write(`${YELLOW}${BOLD}Warning:${RESET} ${YELLOW}${message}${RESET}\n`)
}

export function printInfo(message: string): void {
  process.stderr.write(`${BLUE}${message}${RESET}\n`)
}

export function printSubagentStart(agentId: string, agentType: string): void {
  process.stderr.write(`${DIM}${MAGENTA}◆ Agent: ${agentType}${RESET}\n`)
}

export function printSubagentEnd(agentId: string): void {
  process.stderr.write(`${DIM}${MAGENTA}◆ Agent finished${RESET}\n`)
}

export function printDivider(): void {
  const width = Math.min(process.stdout.columns || 80, 80)
  process.stderr.write(`${DIM}${'─'.repeat(width)}${RESET}\n`)
}

export function printFinish(totalCost: number): void {
  const costStr = totalCost > 0 ? ` (cost: $${totalCost.toFixed(4)})` : ''
  process.stderr.write(`${DIM}${GREEN}✓ Done${costStr}${RESET}\n`)
}

export function printBanner(): void {
  process.stderr.write(`\n${BOLD}${CYAN}Codebuff Lite${RESET} ${DIM}(TUI-free mode)${RESET}\n`)
  process.stderr.write(`${DIM}Type your prompt, then press Enter. Use Ctrl+C to exit.${RESET}\n`)
  process.stderr.write(`${DIM}Use /help for commands.${RESET}\n\n`)
}
