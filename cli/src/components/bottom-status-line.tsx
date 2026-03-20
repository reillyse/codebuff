import React, { useEffect, useState } from 'react'

import { useTheme } from '../hooks/use-theme'

import { formatElapsedTime } from '../utils/format-elapsed-time'
import { formatResetTime } from '../utils/time-format'

import type { ClaudeQuotaData } from '../hooks/use-claude-quota-query'
import type { HippoSessionStats } from '../utils/hippo-hooks'

interface BottomStatusLineProps {
  /** Whether Claude OAuth is connected */
  isClaudeConnected: boolean
  /** Whether Claude is actively being used (streaming/waiting) */
  isClaudeActive: boolean
  /** Quota data from Anthropic API */
  claudeQuota?: ClaudeQuotaData | null
  /** Whether hippo memory is enabled in settings */
  isHippoEnabled: boolean
  /** Whether the hippo binary is installed on disk */
  isHippoBinaryInstalled: boolean
  /** Whether hippo is actively searching memory */
  isHippoActive: boolean
  /** Stats from hippo memory for the current session */
  hippoStats?: HippoSessionStats | null
  /** Number of times hippo returned useful context this session */
  hippoRecalls?: number
  /** Whether hippo CLI is confirmed reachable (null = unknown, true = ok, false = failed) */
  hippoConnectionOk?: boolean | null
  /** Last error message from hippo connection failure */
  hippoLastError?: string | null
  /** Whether a hippo connection retry is in progress */
  isHippoRetrying?: boolean
  /** Callback to trigger a hippo connection retry */
  onHippoRetry?: () => void
  /** Timestamp (ms) when hippo was last used in this session */
  hippoLastUsedAt?: number | null
}

/**
 * Bottom status line component - shows below the input box
 * Displays hippo memory status and/or Claude subscription status
 */
export const BottomStatusLine: React.FC<BottomStatusLineProps> = ({
  isClaudeConnected,
  isClaudeActive,
  claudeQuota,
  isHippoEnabled,
  isHippoBinaryInstalled,
  isHippoActive,
  hippoStats,
  hippoRecalls = 0,
  hippoConnectionOk,
  hippoLastError,
  isHippoRetrying,
  onHippoRetry,
  hippoLastUsedAt,
}) => {
  const theme = useTheme()
  const [isHippoHovered, setIsHippoHovered] = useState(false)
  const [isClaudeHovered, setIsClaudeHovered] = useState(false)

  // Pulse the hippo dot while actively searching memory
  const [hippoDotVisible, setHippoDotVisible] = useState(true)
  useEffect(() => {
    if (!isHippoActive) {
      setHippoDotVisible(true)
      return
    }
    const interval = setInterval(() => {
      setHippoDotVisible((prev) => !prev)
    }, 350)
    return () => clearInterval(interval)
  }, [isHippoActive])

  // Live-updating "last used X ago" label
  const [lastUsedElapsed, setLastUsedElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (hippoLastUsedAt == null) {
      setLastUsedElapsed(null)
      return
    }
    const compute = () => setLastUsedElapsed(Math.max(0, Math.floor((Date.now() - hippoLastUsedAt) / 1000)))
    compute()
    const interval = setInterval(compute, 10_000)
    return () => clearInterval(interval)
  }, [hippoLastUsedAt])

  // Use the more restrictive of the two quotas (5-hour window is usually the limiting factor)
  const claudeDisplayRemaining = claudeQuota
    ? Math.min(claudeQuota.fiveHourRemaining, claudeQuota.sevenDayRemaining)
    : null

  // Check if Claude quota is exhausted (0%)
  const isClaudeExhausted = claudeDisplayRemaining !== null && claudeDisplayRemaining <= 0

  // Get the reset time for the limiting Claude quota window
  const claudeResetTime = claudeQuota
    ? claudeQuota.fiveHourRemaining <= claudeQuota.sevenDayRemaining
      ? claudeQuota.fiveHourResetsAt
      : claudeQuota.sevenDayResetsAt
    : null

  // Only show when there's something to display
  if (!isClaudeConnected && !isHippoEnabled) {
    return null
  }

  // Determine dot color for Claude: red if exhausted, green if active, muted otherwise
  const claudeDotColor = isClaudeExhausted
    ? theme.error
    : isClaudeActive
      ? theme.success
      : theme.muted

  // For dot color: only confirmed successful recalls prove the full stack works
  const hasConfirmedSuccess = hippoRecalls > 0
  // For hover display: show stats if any session data is available
  const hasSessionStats = (hippoStats != null && hippoStats.runs > 0) || hippoRecalls > 0
  const hippoDotColor = !isHippoBinaryInstalled
    ? theme.error
    : isHippoRetrying
      ? theme.info
      : hippoConnectionOk === false
        ? theme.warning
        : hippoConnectionOk === true && (isHippoActive || hasConfirmedSuccess)
          ? theme.success
          : theme.muted

  // Shared hover detail for Claude
  const claudeHoverDetail = isClaudeHovered && claudeQuota ? (
    <>
      <text style={{ fg: theme.foreground }}> Claude</text>
      <text style={{ fg: theme.muted }}>{` · 5h: ${Math.round(claudeQuota.fiveHourRemaining)}%`}</text>
      <text style={{ fg: theme.muted }}>{` · 7d: ${Math.round(claudeQuota.sevenDayRemaining)}%`}</text>
      {claudeResetTime && (
        <text style={{ fg: theme.muted }}>{` · resets in ${formatResetTime(claudeResetTime)}`}</text>
      )}
    </>
  ) : null

  return (
    <box
      style={{
        width: '100%',
        flexDirection: 'row',
        paddingLeft: 1,
        paddingRight: 1,
        gap: 2,
      }}
    >
      {/* Hippo memory indicator */}
      {isHippoEnabled && (
        <box
          onMouseOver={() => setIsHippoHovered(true)}
          onMouseOut={() => setIsHippoHovered(false)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 0,
          }}
        >
          <text style={{ fg: hippoDotVisible ? hippoDotColor : theme.muted }}>{hippoDotVisible ? '●' : '○'}</text>
          <text style={{ fg: isHippoHovered ? theme.foreground : theme.muted }}> Hippo memory</text>
          {isHippoHovered ? (
            isHippoActive ? (
              <text style={{ fg: theme.info }}> · searching...</text>
            ) : !isHippoBinaryInstalled ? (
              <text style={{ fg: theme.error }}> · not found</text>
            ) : isHippoRetrying ? (
              <text style={{ fg: theme.info }}> · retrying...</text>
            ) : hippoConnectionOk === false ? (
              <>
                <text style={{ fg: theme.warning }}>{` · ${formatHippoError(hippoLastError)}`}</text>
                {onHippoRetry && (
                  <text style={{ fg: theme.info }} selectable={false} onMouseDown={onHippoRetry}> [retry]</text>
                )}
              </>
            ) : hasSessionStats ? (
              <text style={{ fg: theme.muted }}>
                {formatSessionStats(hippoStats?.runs ?? 0, hippoRecalls)}
                {lastUsedElapsed != null && ` · ${formatLastUsed(lastUsedElapsed)}`}
              </text>
            ) : lastUsedElapsed != null ? (
              <text style={{ fg: theme.muted }}>{` · ${formatLastUsed(lastUsedElapsed)}`}</text>
            ) : hippoConnectionOk === true ? (
              <text style={{ fg: theme.muted }}> · connected</text>
            ) : (
              <text style={{ fg: theme.muted }}> · idle</text>
            )
          ) : (
            !isHippoBinaryInstalled ? (
              <text style={{ fg: theme.muted }}> · not found</text>
            ) : isHippoRetrying ? (
              <text style={{ fg: theme.muted }}> · retrying...</text>
            ) : hippoConnectionOk === false ? (
              <text style={{ fg: theme.muted }}> · disconnected</text>
            ) : null
          )}
        </box>
      )}

      {/* Spacer pushes Claude to the right */}
      <box style={{ flexGrow: 1 }} />

      {/* Show Claude subscription when connected and not depleted */}
      {isClaudeConnected && !isClaudeExhausted && (
        <box
          onMouseOver={() => setIsClaudeHovered(true)}
          onMouseOut={() => setIsClaudeHovered(false)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 0,
          }}
        >
          <text style={{ fg: claudeDotColor }}>●</text>
          {claudeHoverDetail ?? (
            <>
              <text style={{ fg: isClaudeHovered ? theme.foreground : theme.muted }}> Claude subscription</text>
              {claudeDisplayRemaining !== null ? (
                <BatteryIndicator value={claudeDisplayRemaining} theme={theme} />
              ) : null}
            </>
          )}
        </box>
      )}

      {/* Show Claude as depleted when exhausted */}
      {isClaudeConnected && isClaudeExhausted && (
        <box
          onMouseOver={() => setIsClaudeHovered(true)}
          onMouseOut={() => setIsClaudeHovered(false)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 0,
          }}
        >
          <text style={{ fg: theme.error }}>●</text>
          {claudeHoverDetail ?? (
            <>
              <text style={{ fg: theme.muted }}> Claude</text>
              {claudeResetTime && (
                <text style={{ fg: theme.muted }}>{` · resets in ${formatResetTime(claudeResetTime)}`}</text>
              )}
            </>
          )}
        </box>
      )}
    </box>
  )
}

/** Format hippo error for the hover display — shows error detail or generic 'disconnected' */
const formatHippoError = (lastError: string | null | undefined): string => {
  if (!lastError) return 'disconnected'
  const truncated = lastError.length > 40 ? lastError.substring(0, 40) + '…' : lastError
  return `disconnected: ${truncated}`
}

/** Format "last used" label — shows "just now" for recent, otherwise "Xm ago" */
const formatLastUsed = (elapsedSeconds: number): string => {
  if (elapsedSeconds < 10) return 'just now'
  return `${formatElapsedTime(elapsedSeconds)} ago`
}

/** Format session stats for the hippo hover display */
const formatSessionStats = (saves: number, recalls: number): string => {
  const parts: string[] = []
  if (saves > 0) {
    parts.push(`${saves} ${saves === 1 ? 'save' : 'saves'}`)
  }
  if (recalls > 0) {
    parts.push(`${recalls} ${recalls === 1 ? 'recall' : 'recalls'}`)
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

/** Battery indicator width in characters */
const BATTERY_WIDTH = 8

/** Compact battery-style progress indicator for the status line */
const BatteryIndicator: React.FC<{
  value: number
  theme: { muted: string; warning: string; error: string }
}> = ({ value, theme }) => {
  const clampedValue = Math.max(0, Math.min(100, value))
  const filledWidth = Math.round((clampedValue / 100) * BATTERY_WIDTH)
  const emptyWidth = BATTERY_WIDTH - filledWidth

  const filledChar = '█'
  const emptyChar = '░'

  const filled = filledChar.repeat(filledWidth)
  const empty = emptyChar.repeat(emptyWidth)

  // Color based on percentage thresholds
  // Use muted color for healthy capacity (>25%) to avoid drawing attention,
  // warning/error colors only when running low
  const barColor =
    clampedValue <= 10
      ? theme.error
      : clampedValue <= 25
        ? theme.warning
        : theme.muted

  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 0 }}>
      <text style={{ fg: theme.muted }}> [</text>
      <text style={{ fg: barColor }}>{filled}</text>
      <text style={{ fg: theme.muted }}>{empty}]</text>
    </box>
  )
}
