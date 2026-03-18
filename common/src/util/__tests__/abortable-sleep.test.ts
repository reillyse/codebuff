import { describe, expect, it } from 'bun:test'

import { abortableSleep } from '../promise'

describe('abortableSleep', () => {
  it('should resolve after the specified time', async () => {
    const start = Date.now()
    await abortableSleep(50, new AbortController().signal)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('should resolve immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await abortableSleep(5000, controller.signal)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  it('should resolve early when signal is aborted during sleep', async () => {
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 50)
    await abortableSleep(5000, controller.signal)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(200)
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('should not throw when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(abortableSleep(100, controller.signal)).resolves.toBeUndefined()
  })

  it('should resolve without error when abort fires after natural completion', async () => {
    const controller = new AbortController()
    await abortableSleep(10, controller.signal)
    // Abort after sleep already resolved — should be harmless
    controller.abort()
  })
})
