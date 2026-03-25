/**
 * Streaming markdown-to-plain-text renderer for TUI-free CLI.
 * Buffers text until complete lines are available, then strips markdown syntax.
 * Tracks code fence state across chunks.
 */

function formatInline(text: string): string {
  const codes: string[] = []
  let result = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code)
    return `\x00${codes.length - 1}\x00`
  })

  result = result.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/\*(.+?)\*/g, '$1')
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
  result = result.replace(/~~(.+?)~~/g, '$1')

  result = result.replace(/\x00(\d+)\x00/g, (_, idx: string) => {
    return codes[Number(idx)]
  })

  return result
}

export function createMarkdownStream() {
  let buffer = ''
  let inFence = false
  let fenceLang = ''

  function processLine(line: string): string | null {
    if (inFence) {
      if (/^\s*```/.test(line)) {
        inFence = false
        fenceLang = ''
        return null
      }
      return line
    }

    if (/^\s*```/.test(line)) {
      inFence = true
      fenceLang = line.replace(/^\s*```/, '').trim()
      if (fenceLang) {
        return `[${fenceLang}]`
      }
      return null
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      const text = headingMatch[2]
      return formatInline(text)
    }

    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      const width = Math.min(process.stdout.columns || 80, 80)
      return `${'-'.repeat(width)}`
    }

    if (line.startsWith('>')) {
      const text = line.startsWith('> ') ? line.slice(2) : line.slice(1)
      return `| ${text ? formatInline(text) : ''}`
    }

    const ulMatch = line.match(/^(\s*)[*+-]\s+(.+)/)
    if (ulMatch) {
      return `${ulMatch[1]}- ${formatInline(ulMatch[2])}`
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/)
    if (olMatch) {
      return `${olMatch[1]}${olMatch[2]}. ${formatInline(olMatch[3])}`
    }

    return formatInline(line)
  }

  return {
    write(chunk: string): string {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop()!

      if (parts.length === 0) return ''

      const formatted = parts
        .map(processLine)
        .filter((line): line is string => line !== null)

      if (formatted.length === 0) return ''
      return formatted.join('\n') + '\n'
    },

    flush(): string {
      if (!buffer) {
        inFence = false
        fenceLang = ''
        return ''
      }
      const line = buffer
      buffer = ''
      const result = processLine(line)
      inFence = false
      fenceLang = ''
      return result ?? ''
    },
  }
}
