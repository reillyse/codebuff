import { describe, expect, test } from 'bun:test'

import {
  IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
  selectLongRunningTools,
} from '../in-flight-tools-box'

import type { InFlightToolInfo } from '../../utils/stream-activity'

const tool = (
  toolName: string,
  startedAt: number,
  toolCallId = `${toolName}-id`,
): InFlightToolInfo => ({ toolCallId, toolName, startedAt })

describe('selectLongRunningTools', () => {
  const now = 1_000_000

  test('returns tools past the threshold, sorted longest-running first', () => {
    const tools = [
      tool('code_search', now - 31_000),
      tool('run_terminal_command', now - 45_000),
    ]
    const result = selectLongRunningTools(
      tools,
      now,
      IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
    )
    expect(result.map((t) => t.toolName)).toEqual([
      'run_terminal_command',
      'code_search',
    ])
    expect(result[0].elapsedMs).toBe(45_000)
    expect(result[1].elapsedMs).toBe(31_000)
  })

  test('excludes tools that have not yet reached the threshold', () => {
    const tools = [
      tool('code_search', now - 10_000), // too young
      tool('run_terminal_command', now - 30_000), // exactly at threshold
    ]
    const result = selectLongRunningTools(
      tools,
      now,
      IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
    )
    expect(result.map((t) => t.toolName)).toEqual(['run_terminal_command'])
  })

  test('returns empty when nothing qualifies', () => {
    const tools = [tool('code_search', now - 5_000)]
    expect(
      selectLongRunningTools(tools, now, IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS),
    ).toEqual([])
  })

  test('never surfaces control tools like end_turn even when long-running', () => {
    const tools = [
      tool('end_turn', now - 120_000),
      tool('run_terminal_command', now - 40_000),
    ]
    const result = selectLongRunningTools(
      tools,
      now,
      IN_FLIGHT_TOOLS_DETAIL_THRESHOLD_MS,
    )
    expect(result.map((t) => t.toolName)).toEqual(['run_terminal_command'])
  })

  test('honors a custom threshold', () => {
    const tools = [tool('code_search', now - 6_000)]
    expect(selectLongRunningTools(tools, now, 5_000)).toHaveLength(1)
    expect(selectLongRunningTools(tools, now, 10_000)).toHaveLength(0)
  })
})
