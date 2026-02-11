import fs from 'fs'
import os from 'os'
import path from 'path'

import { logger } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'
import { saveSettings, loadSettings } from '../utils/settings'

import type { ChatMessage } from '../types/chat'

// Path to hippo binary - matches hippo-hooks.ts
const HIPPO_BINARY = process.env.HIPPO_PATH ?? path.join(os.homedir(), 'Programming/hippo/build/hippo')

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
  
  const statusLines = [
    `Hippo memory: ${enabled ? 'enabled' : 'disabled'}`,
    `Binary: ${binaryExists ? 'installed' : 'not found'} (${HIPPO_BINARY})`,
  ]
  
  if (enabled && !binaryExists) {
    statusLines.push('⚠️  Hippo is enabled but binary not found. Install hippo to use memory features.')
  }
  
  return {
    postUserMessage: (messages) => [
      ...messages,
      getSystemMessage(statusLines.join('\n')),
    ],
  }
}
