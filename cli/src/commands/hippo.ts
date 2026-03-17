import fs from 'fs'
import path from 'path'

import { HIPPO_BINARY } from '../utils/hippo-hooks'
import { logger } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'
import { getProjectRoot } from '../project-files'
import { saveSettings, loadSettings } from '../utils/settings'

import type { ChatMessage } from '../types/chat'

export const handleHippoEnable = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  logger.info('[hippo] Enabling Hippo memory integration')

  saveSettings({ hippoEnabled: true })

  // Warn if hippo binary is not installed
  if (!fs.existsSync(HIPPO_BINARY)) {
    return {
      postUserMessage: (messages) => [
        ...messages,
        getSystemMessage(`Hippo memory enabled, but binary not found at ${HIPPO_BINARY}. Install hippo to use memory features.`),
      ],
    }
  }

  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage('Hippo memory enabled. Context will be retrieved from and stored to Hippo.'),
    ],
  }
}

export const handleHippoDisable = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  logger.info('[hippo] Disabling Hippo memory integration')
  saveSettings({ hippoEnabled: false })

  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage('Hippo memory disabled.'),
    ],
  }
}

export const handleHippoToggle = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  const currentEnabled = getHippoEnabled()
  
  if (currentEnabled) {
    return handleHippoDisable()
  } else {
    return handleHippoEnable()
  }
}

export const getHippoEnabled = (): boolean => {
  const settings = loadSettings()
  return settings.hippoEnabled ?? true
}

export const handleHippoStatus = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  const enabled = getHippoEnabled()
  const binaryExists = fs.existsSync(HIPPO_BINARY)
  const loggingEnabled = loadSettings().hippoLoggingEnabled === true
  
  const statusLines = [
    `Hippo memory: ${enabled ? 'enabled' : 'disabled'}`,
    `Binary: ${binaryExists ? 'installed' : 'not found'} (${HIPPO_BINARY})`,
    `Debug logging: ${loggingEnabled ? 'enabled' : 'disabled'}`,
  ]
  
  if (enabled && !binaryExists) {
    statusLines.push('⚠️  Hippo is enabled but binary not found. Install hippo to use memory features.')
  }

  if (loggingEnabled) {
    try {
      const debugDir = path.join(getProjectRoot(), 'debug')
      statusLines.push(`Log files: ${debugDir}/hippo-interactions.log, ${debugDir}/hippo-prompts.log`)
    } catch {
      // Ignore if project root unavailable
    }
  }
  
  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage(statusLines.join('\n')),
    ],
  }
}

export const handleHippoLogEnable = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  logger.info('[hippo] Enabling Hippo debug logging')
  saveSettings({ hippoLoggingEnabled: true })

  let logDir = 'debug'
  try {
    logDir = path.join(getProjectRoot(), 'debug')
  } catch {
    // Ignore
  }

  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage(`Hippo debug logging enabled. Logs written to:\n  ${logDir}/hippo-interactions.log\n  ${logDir}/hippo-prompts.log\nLogs truncate at 20MB.`),
    ],
  }
}

export const handleHippoLogDisable = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  logger.info('[hippo] Disabling Hippo debug logging')
  saveSettings({ hippoLoggingEnabled: false })

  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage('Hippo debug logging disabled.'),
    ],
  }
}

export const handleHippoLogToggle = (): {
  postUserMessage: (messages: ChatMessage[]) => ChatMessage[]
} => {
  const current = loadSettings().hippoLoggingEnabled === true
  if (current) return handleHippoLogDisable()
  return handleHippoLogEnable()
}
