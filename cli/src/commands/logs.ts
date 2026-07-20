import { existsSync, rmSync } from 'fs'
import path from 'path'

import { getProjectRoot } from '../project-files'
import { clearLogFile } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'

import type { ChatMessage } from '../types/chat'

/**
 * Debug log filenames under {projectRoot}/debug/ that are not managed by the
 * pino logger. `cli.jsonl` and the active session log are handled by
 * `clearLogFile()` which also resets the pino file handle.
 */
const DEBUG_LOG_FILES = [
  'hippo-interactions.log',
  'hippo-prompts.log',
  'prompt-log.txt',
] as const

export const handleLogsClear = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  let debugDir: string
  try {
    debugDir = path.join(getProjectRoot(), 'debug')
  } catch {
    return {
      postUserMessage: (messages) => [
        ...messages,
        getSystemMessage('❌ Could not determine project root — no log files cleared.'),
      ],
    }
  }

  const cleared: string[] = []

  // Reset the pino file handle and delete cli.jsonl + the active session log.
  // Must happen BEFORE any rmSync calls so we never delete an open file
  // descriptor (which silently loses writes on Unix and throws EPERM on Windows).
  const cliJsonlPath = path.join(debugDir, 'cli.jsonl')
  const cliJsonlExisted = existsSync(cliJsonlPath)
  try {
    clearLogFile()
  } catch {
    // Best-effort
  }
  if (cliJsonlExisted) cleared.push('cli.jsonl')

  for (const filename of DEBUG_LOG_FILES) {
    const filePath = path.join(debugDir, filename)
    if (existsSync(filePath)) {
      try {
        rmSync(filePath)
        cleared.push(filename)
      } catch {
        // Best-effort — skip files we can't remove
      }
    }
  }

  // Wipe per-session logs under debug/chats/ (all session log.jsonl files).
  const chatsDir = path.join(debugDir, 'chats')
  if (existsSync(chatsDir)) {
    try {
      rmSync(chatsDir, { recursive: true, force: true })
      cleared.push('chats/ (session logs)')
    } catch {
      // Best-effort — skip if we can't remove it
    }
  }

  let message: string
  if (cleared.length > 0) {
    const fileList = cleared.map((f) => `  - ${f}`).join('\n')
    message = `🗑️  Cleared ${cleared.length} log file${cleared.length === 1 ? '' : 's'} from ${debugDir}:\n${fileList}`
  } else {
    message = `No log files found in ${debugDir}.`
  }

  return {
    postUserMessage: (messages) => [...messages, getSystemMessage(message)],
  }
}
