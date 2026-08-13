import { pluralize } from '@codebuff/common/util/string'
import { TextAttributes } from '@opentui/core'
import React from 'react'

import { CopyButton } from './copy-button'
import { ElapsedTimer } from './elapsed-timer'
import { useTheme } from '../hooks/use-theme'

import type { ContentBlock, TextContentBlock } from '../types/chat'

interface MessageFooterProps {
  blocks?: ContentBlock[]
  content: string
  isLoading: boolean
  isComplete?: boolean
  completionTime?: string
  credits?: number
  timerStartTime: number | null
}

export const MessageFooter: React.FC<MessageFooterProps> = ({
  blocks,
  content,
  isLoading,
  isComplete,
  completionTime,
  credits,
  timerStartTime,
}) => {
  const theme = useTheme()

  const shouldShowLoadingTimer = isLoading && !isComplete
  const shouldShowCompletionFooter = isComplete

  // Build text from content and text blocks for copy button
  const textToCopy = [
    content,
    ...(blocks || [])
      .filter((b): b is TextContentBlock => b.type === 'text')
      .map((b) => b.content),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim()

  // Loading timer
  if (shouldShowLoadingTimer) {
    return (
      <text
        attributes={TextAttributes.DIM}
        style={{
          wrapMode: 'none',
          marginTop: 0,
          marginBottom: 0,
          alignSelf: 'flex-end',
        }}
      >
        <ElapsedTimer
          startTime={timerStartTime}
          attributes={TextAttributes.DIM}
        />
      </text>
    )
  }

  // Completion footer
  if (!shouldShowCompletionFooter) {
    return null
  }

  const footerItems: { key: string; node: React.ReactNode }[] = []

  // Add copy button first if there's content to copy
  if (textToCopy.length > 0) {
    footerItems.push({
      key: 'copy',
      node: (
        <CopyButton
          textToCopy={textToCopy}
          leadingSpace={false}
          style={{ wrapMode: 'none' }}
        />
      ),
    })
  }

  if (completionTime) {
    footerItems.push({
      key: 'time',
      node: (
        <text
          attributes={TextAttributes.DIM}
          style={{
            wrapMode: 'none',
            fg: theme.secondary,
            marginTop: 0,
            marginBottom: 0,
          }}
        >
          {completionTime}
        </text>
      ),
    })
  }
  if (typeof credits === 'number' && credits > 0) {
    footerItems.push({
      key: 'credits',
      node: <CreditsIndicator credits={credits} />,
    })
  }

  if (footerItems.length === 0) {
    return null
  }

  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-end',
        gap: 1,
      }}
    >
      {footerItems.map((item, idx) => (
        <React.Fragment key={item.key}>
          {idx > 0 && (
            <text
              attributes={TextAttributes.DIM}
              style={{
                wrapMode: 'none',
                fg: theme.muted,
                marginTop: 0,
                marginBottom: 0,
              }}
            >
              •
            </text>
          )}
          {item.node}
        </React.Fragment>
      ))}
    </box>
  )
}

const CreditsIndicator: React.FC<{ credits: number }> = ({ credits }) => {
  const theme = useTheme()

  return (
    <text
      attributes={TextAttributes.DIM}
      style={{ wrapMode: 'none', fg: theme.secondary, marginTop: 0, marginBottom: 0 }}
    >
      {pluralize(credits, 'credit')}
    </text>
  )
}
