import { describe, test, expect } from 'bun:test'

import {
  getStatusIndicatorState,
  STALL_INDICATOR_THRESHOLD_MS,
} from '../../utils/status-indicator-state'

import type { StatusIndicatorStateArgs } from '../../utils/status-indicator-state'

describe('StatusIndicator state logic', () => {
  describe('getStatusIndicatorState', () => {
    const baseArgs: StatusIndicatorStateArgs = {
      statusMessage: null,
      streamStatus: 'idle',
      nextCtrlCWillExit: false,
      isConnected: true,
    }

    test('returns idle state when no special conditions', () => {
      const state = getStatusIndicatorState(baseArgs)
      expect(state.kind).toBe('idle')
    })

    test('returns ctrlC state when nextCtrlCWillExit is true (highest priority)', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        nextCtrlCWillExit: true,
        statusMessage: 'Some message',
        streamStatus: 'streaming',
        isConnected: false,
      })
      expect(state.kind).toBe('ctrlC')
    })

    test('returns clipboard state when message exists (second priority)', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        statusMessage: 'Copied to clipboard!',
        streamStatus: 'streaming',
        isConnected: false,
      })
      expect(state.kind).toBe('clipboard')
      if (state.kind === 'clipboard') {
        expect(state.message).toBe('Copied to clipboard!')
      }
    })

    test('returns retrying state when auth is retrying even if connected and reachable', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        isConnected: true,
        authStatus: 'retrying',
        streamStatus: 'streaming',
      })
      expect(state.kind).toBe('retrying')
    })

    test('returns retrying state when message send is retrying', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        isRetrying: true,
        streamStatus: 'waiting',
      })
      expect(state.kind).toBe('retrying')
    })

    test('returns connecting state when not connected (third priority)', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        isConnected: false,
        streamStatus: 'streaming',
      })
      expect(state.kind).toBe('connecting')
    })

    test('returns connecting state when auth service is unreachable', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        isConnected: true,
        authStatus: 'unreachable',
        streamStatus: 'streaming',
      })
      expect(state.kind).toBe('connecting')
    })

    test('returns connecting state when both WebSocket and auth service are unreachable', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        isConnected: false,
        authStatus: 'unreachable',
        streamStatus: 'streaming',
      })
      expect(state.kind).toBe('connecting')
    })

    test('returns waiting state when streamStatus is waiting', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        streamStatus: 'waiting',
      })
      expect(state.kind).toBe('waiting')
    })

    test('returns streaming state when streamStatus is streaming', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        streamStatus: 'streaming',
      })
      expect(state.kind).toBe('streaming')
    })

    test('handles empty clipboard message as falsy', () => {
      const state = getStatusIndicatorState({
        ...baseArgs,
        statusMessage: '',
        streamStatus: 'streaming',
      })
      // Empty string is falsy, should fall through to streaming state
      expect(state.kind).toBe('streaming')
    })

    describe('stalled state', () => {
      const now = 1_000_000

      test('returns stalled when active and last activity is past the threshold', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS,
          now,
        })
        expect(state.kind).toBe('stalled')
        if (state.kind === 'stalled') {
          expect(state.sinceMs).toBe(STALL_INDICATOR_THRESHOLD_MS)
        }
      })

      test('returns stalled while waiting (before first chunk) too', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'waiting',
          lastStreamActivityAt: now - (STALL_INDICATOR_THRESHOLD_MS + 5_000),
          now,
        })
        expect(state.kind).toBe('stalled')
      })

      test('does NOT return stalled just below the threshold', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          lastStreamActivityAt: now - (STALL_INDICATOR_THRESHOLD_MS - 1),
          now,
        })
        expect(state.kind).toBe('streaming')
      })

      test('does NOT return stalled when lastStreamActivityAt is null (detection disabled)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          lastStreamActivityAt: null,
          now,
        })
        expect(state.kind).toBe('streaming')
      })

      test('does NOT return stalled when not in an active phase (idle)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'idle',
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 10,
          now,
        })
        expect(state.kind).toBe('idle')
      })

      test('higher-priority states (retrying) beat stalled', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          isRetrying: true,
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 2,
          now,
        })
        expect(state.kind).toBe('retrying')
      })

      test('searching-memory beats stalled', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          isSearchingMemory: true,
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 2,
          now,
        })
        expect(state.kind).toBe('searching-memory')
      })

      test('does NOT return stalled while a local tool is in flight (e.g. running tests)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          // Silent long enough to otherwise be 'stalled'...
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 5,
          // ...but a local tool is actively running (no chunks expected).
          hasInFlightTools: true,
          now,
        })
        // Falls through to 'streaming' ("working...") instead of 'stalled'.
        expect(state.kind).toBe('streaming')
      })

      test('still returns stalled when no tool is in flight (regression guard)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 5,
          hasInFlightTools: false,
          now,
        })
        expect(state.kind).toBe('stalled')
      })
    })

    describe('retrying-attempt state', () => {
      const now = 1_000_000

      test('shows retrying-attempt during the backoff window instead of stalled', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'waiting',
          // Activity is stale enough to otherwise be 'stalled'...
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 2,
          // ...but we're inside a retry backoff window.
          retryActivity: { attempt: 2, total: 3, until: now + 3_000 },
          now,
        })
        expect(state.kind).toBe('retrying-attempt')
        if (state.kind === 'retrying-attempt') {
          expect(state.attempt).toBe(2)
          expect(state.total).toBe(3)
        }
      })

      test('falls through to stalled once the backoff window has elapsed (next attempt hangs)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          lastStreamActivityAt: now - STALL_INDICATOR_THRESHOLD_MS * 2,
          // Backoff window already ended: the next attempt itself is hanging.
          retryActivity: { attempt: 2, total: 3, until: now - 1 },
          now,
        })
        expect(state.kind).toBe('stalled')
      })

      test('does NOT show retrying-attempt when not in an active phase (idle)', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'idle',
          retryActivity: { attempt: 2, total: 3, until: now + 3_000 },
          now,
        })
        expect(state.kind).toBe('idle')
      })

      test('higher-priority retrying (auth/message-send) beats retrying-attempt', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'waiting',
          isRetrying: true,
          retryActivity: { attempt: 2, total: 3, until: now + 3_000 },
          now,
        })
        expect(state.kind).toBe('retrying')
      })

      test('searching-memory beats retrying-attempt', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
          isSearchingMemory: true,
          retryActivity: { attempt: 2, total: 3, until: now + 3_000 },
          now,
        })
        expect(state.kind).toBe('searching-memory')
      })
    })

    describe('state priority order', () => {
      test('nextCtrlCWillExit beats clipboard', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          nextCtrlCWillExit: true,
          statusMessage: 'Test',
        })
        expect(state.kind).toBe('ctrlC')
      })

      test('clipboard beats connecting', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          statusMessage: 'Test',
          isConnected: false,
        })
        expect(state.kind).toBe('clipboard')
      })

      test('retrying beats waiting', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          isConnected: true,
          authStatus: 'retrying',
          streamStatus: 'waiting',
        })
        expect(state.kind).toBe('retrying')
      })

      test('connecting beats waiting', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          isConnected: false,
          streamStatus: 'waiting',
        })
        expect(state.kind).toBe('connecting')
      })

      test('auth unreachable beats waiting', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          isConnected: true,
          authStatus: 'unreachable',
          streamStatus: 'waiting',
        })
        expect(state.kind).toBe('connecting')
      })

      test('waiting beats streaming', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'waiting',
        })
        expect(state.kind).toBe('waiting')
      })

      test('streaming beats idle', () => {
        const state = getStatusIndicatorState({
          ...baseArgs,
          streamStatus: 'streaming',
        })
        expect(state.kind).toBe('streaming')
      })
    })
  })
})
