import {
  CURRENT_OPUS_MODEL,
  CURRENT_SONNET_FALLBACK_MODEL,
  CURRENT_SONNET_MODEL,
  getEmptyResponseFallbackModel,
} from '@codebuff/common/constants/model-config'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  EMPTY_RESPONSE_COOLDOWN_MS,
  __resetEmptyResponseCooldowns,
  __setEmptyResponseCooldownClock,
  isModelOnCooldown,
  pickStartModelSkippingCooldown,
  recordEmptyResponseCooldown,
  shouldNotifyCooldownOnce,
} from '../empty-response-cooldown'

describe('empty-response cooldown', () => {
  let currentTime: number

  beforeEach(() => {
    currentTime = 1_000_000
    __setEmptyResponseCooldownClock(() => currentTime)
  })

  afterEach(() => {
    __resetEmptyResponseCooldowns()
  })

  it('records a cooldown and reports the model as cooled', () => {
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(false)
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(true)
  })

  it('scopes cooldowns per session (no cross-session leakage)', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(true)
    // A different session is unaffected.
    expect(isModelOnCooldown('s2', CURRENT_SONNET_MODEL)).toBe(false)
  })

  it('expires the cooldown after 30 minutes', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(true)

    // Just before expiry: still cooled.
    currentTime += EMPTY_RESPONSE_COOLDOWN_MS - 1
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(true)

    // At/after expiry: no longer cooled.
    currentTime += 1
    expect(isModelOnCooldown('s1', CURRENT_SONNET_MODEL)).toBe(false)
  })

  it('returns the preferred model when nothing is cooled', () => {
    expect(
      pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL),
    ).toBe(CURRENT_SONNET_MODEL)
  })

  it('skips a cooled preferred model to the next ladder rung', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(
      pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL),
    ).toBe(CURRENT_SONNET_FALLBACK_MODEL)
  })

  it('skips multiple cooled rungs (sonnet-5 + sonnet-4.6 cooled -> opus)', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_FALLBACK_MODEL)
    expect(
      pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL),
    ).toBe(CURRENT_OPUS_MODEL)
  })

  it('falls back to the last candidate when the whole ladder is cooled', () => {
    // Cool every rung of the sonnet-5 ladder.
    let model: string | undefined = CURRENT_SONNET_MODEL
    const laddered = new Set<string>()
    while (model && !laddered.has(model)) {
      laddered.add(model)
      recordEmptyResponseCooldown('s1', model)
      model = getEmptyResponseFallbackModel(model)
    }

    // Even with everything cooled, we still get a usable model (not undefined).
    const start = pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL)
    expect(typeof start).toBe('string')
    expect(start.length).toBeGreaterThan(0)
  })

  it('notifies at most once per (session, model) cooldown until re-recorded', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    // First check for this cooldown notifies; subsequent checks do not.
    expect(shouldNotifyCooldownOnce('s1', CURRENT_SONNET_MODEL)).toBe(true)
    expect(shouldNotifyCooldownOnce('s1', CURRENT_SONNET_MODEL)).toBe(false)
    expect(shouldNotifyCooldownOnce('s1', CURRENT_SONNET_MODEL)).toBe(false)

    // Re-recording the cooldown (a fresh empty response) re-arms the notice.
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(shouldNotifyCooldownOnce('s1', CURRENT_SONNET_MODEL)).toBe(true)
    expect(shouldNotifyCooldownOnce('s1', CURRENT_SONNET_MODEL)).toBe(false)

    // Different session notifies independently.
    recordEmptyResponseCooldown('s2', CURRENT_SONNET_MODEL)
    expect(shouldNotifyCooldownOnce('s2', CURRENT_SONNET_MODEL)).toBe(true)
  })

  it('recovers to the preferred model once its cooldown expires', () => {
    recordEmptyResponseCooldown('s1', CURRENT_SONNET_MODEL)
    expect(
      pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL),
    ).toBe(CURRENT_SONNET_FALLBACK_MODEL)

    currentTime += EMPTY_RESPONSE_COOLDOWN_MS
    expect(
      pickStartModelSkippingCooldown('s1', CURRENT_SONNET_MODEL),
    ).toBe(CURRENT_SONNET_MODEL)
  })
})
