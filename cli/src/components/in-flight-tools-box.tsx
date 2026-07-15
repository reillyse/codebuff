import { TextAttributes } from '@opentui/core'
import React, { useEffect, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { getToolDisplayInfo } from '../utils/codebuff-client'
import { formatElapsedTime } from '../utils/format-elapsed-time'

import type { InFlightToolInfo } from '../utils/stream-activity'

/**
 * How long a tool must be in flight before it (and the details box) is
 * surfaced. Kept above the 20s "stalled" threshold so the box only appears for
 * genuinely long-running tools, not brief ones.
 */
export const IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS = 30_000

/**
 * Tool names that are pure control-flow signals rather than user-meaningful
 * work; we never surface these in the "tools running" box even though they may
 * briefly be in flight.
 */
const HIDDEN_TOOL_NAMES = new Set<string>(['end_turn'])

export type LongRunningTool = {
  toolName: string
  elapsedMs: number
}

/**
 * Pure selection logic (unit-tested): given the in-flight tools, return the
 * user-meaningful ones that have been running at least `thresholdMs`, sorted
 * longest-running first. Returns an empty array when nothing qualifies.
 */
export const selectLongRunningTools = (
  tools: InFlightToolInfo[],
  now: number,
  thresholdMs: number = IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
): LongRunningTool[] =>
  tools
    .filter((t) => !HIDDEN_TOOL_NAMES.has(t.toolName))
    .map((t) => ({ toolName: t.toolName, elapsedMs: now - t.startedAt }))
    .filter((t) => t.elapsedMs >= thresholdMs)
    .sort((a, b) => b.elapsedMs - a.elapsedMs)

interface InFlightToolsBoxProps {
  /** Snapshot of currently-executing tools (read on the caller's 1s tick). */
  tools: InFlightToolInfo[]
  /** Whether a response is actively in progress (waiting/streaming). */
  isActive: boolean
  /** Injectable clock for testing; defaults to Date.now. */
  now?: number
  /** Injectable threshold for testing. */
  thresholdMs?: number
}

/**
 * An expandable info box that appears once at least one tool has been running
 * for {@link IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS}, detailing the current tools
 * and how long each has been running. Renders nothing when not applicable.
 */
export const InFlightToolsBox = ({
  tools,
  isActive,
  now = Date.now(),
  thresholdMs = IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
}: InFlightToolsBoxProps) => {
  const theme = useTheme()
  const [isExpanded, setIsExpanded] = useState(false)

  const longRunning = isActive
    ? selectLongRunningTools(tools, now, thresholdMs)
    : []

  // Reset the expand state once the box has nothing to show, so a stale
  // expansion from a prior run doesn't carry into the next time the box appears.
  const isHidden = longRunning.length === 0
  useEffect(() => {
    if (isHidden && isExpanded) {
      setIsExpanded(false)
    }
  }, [isHidden, isExpanded])

  if (isHidden) {
    return null
  }

  const count = longRunning.length
  const longestSeconds = Math.floor(longRunning[0].elapsedMs / 1000)
  const toggleIndicator = isExpanded ? '▾ ' : '▸ '
  const summary = `${count} tool${count === 1 ? '' : 's'} running · longest ${formatElapsedTime(longestSeconds)}`

  return (
    <box
      style={{
        width: '100%',
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.surface,
      }}
    >
      <Button
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
        }}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <text style={{ wrapMode: 'none' }}>
          <span fg={theme.warning}>{toggleIndicator}</span>
          <span fg={theme.warning} attributes={TextAttributes.BOLD}>
            {summary}
          </span>
        </text>
      </Button>

      {isExpanded && (
        <box
          style={{
            flexDirection: 'column',
            gap: 0,
            paddingLeft: 2,
          }}
        >
          {longRunning.map((tool, index) => {
            const seconds = Math.floor(tool.elapsedMs / 1000)
            const displayName = getToolDisplayInfo(tool.toolName).name
            return (
              <text
                key={`in-flight-tool-${index}-${tool.toolName}`}
                style={{ wrapMode: 'none' }}
              >
                <span fg={theme.foreground}>{'• '}</span>
                <span fg={theme.foreground}>{displayName}</span>
                <span fg={theme.muted}>{` · ${formatElapsedTime(seconds)}`}</span>
              </text>
            )
          })}
        </box>
      )}
    </box>
  )
}
