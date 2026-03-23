/**
 * TTY-aware output helpers for cli-lite.
 *
 * When Node.js readline is active with `terminal: true`, it sets raw mode on
 * stdin. Raw mode disables OPOST (output post-processing), so bare `\n` won't
 * return the cursor to column 0, producing "staircase" text. These helpers
 * normalise `\n` → `\r\n` when raw mode is active.
 */

function isRawMode(): boolean {
  return (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw === true
}

export function ttyNormalize(text: string): string {
  if (!isRawMode()) return text
  return text.replace(/\r?\n/g, '\r\n')
}

export function writeOut(text: string): void {
  process.stdout.write(ttyNormalize(text))
}

export function writeErr(text: string): void {
  process.stderr.write(ttyNormalize(text))
}
