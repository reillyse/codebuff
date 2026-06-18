import { afterEach, describe, expect, it, mock } from 'bun:test'

import {
  runWithSubagentTimeout,
  SubagentTimeoutError,
} from '../tools/handlers/tool/spawn-agent-utils'

function makeLogger() {
  return {
    debug: mock((..._args: unknown[]) => {}),
    info: mock((..._args: unknown[]) => {}),
    warn: mock((..._args: unknown[]) => {}),
    error: mock((..._args: unknown[]) => {}),
  }
}

const neverResolves = () => new Promise<never>(() => {})

describe('runWithSubagentTimeout', () => {
  afterEach(() => {
    mock.restore()
  })

  it('resolves with the run result when it completes before the timeout', async () => {
    const logger = makeLogger()
    const result = await runWithSubagentTimeout({
      parentSignal: new AbortController().signal,
      timeoutMs: 1000,
      agentType: 'test-agent',
      logger,
      run: async () => 'done',
    })

    expect(result).toBe('done')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('rejects with SubagentTimeoutError when the run hangs past the timeout', async () => {
    const logger = makeLogger()

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 20,
        agentType: 'hanging-agent',
        logger,
        run: neverResolves,
      }),
    ).rejects.toBeInstanceOf(SubagentTimeoutError)

    expect(logger.error).toHaveBeenCalledTimes(1)
    const errMessage = logger.error.mock.calls[0][1] as string
    expect(errMessage).toContain('hanging-agent')
    expect(errMessage).toContain('timeout')
    expect(errMessage).toContain('aborted')
  })

  it('aborts the child signal when the run hangs past the timeout', async () => {
    const logger = makeLogger()
    let observedSignal: AbortSignal | undefined

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 20,
        agentType: 'hanging-agent',
        logger,
        run: (childSignal) => {
          observedSignal = childSignal
          return neverResolves()
        },
      }),
    ).rejects.toBeInstanceOf(SubagentTimeoutError)

    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not hang the join: a stalled subagent surfaces as a timeout error', async () => {
    // Simulates the deadlock scenario where a subagent's model client stalls
    // without ever erroring. The join must still make progress.
    const logger = makeLogger()
    const start = Date.now()

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 30,
        agentType: 'code-reviewer',
        logger,
        run: neverResolves,
      }),
    ).rejects.toBeInstanceOf(SubagentTimeoutError)

    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('invokes onTimeout once (after aborting) when the run hangs past the timeout', async () => {
    const logger = makeLogger()
    const onTimeout = mock(() => {})
    let observedSignal: AbortSignal | undefined

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 20,
        agentType: 'hanging-agent',
        logger,
        onTimeout,
        run: (childSignal) => {
          observedSignal = childSignal
          return neverResolves()
        },
      }),
    ).rejects.toBeInstanceOf(SubagentTimeoutError)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    // Child is aborted before onTimeout fires so callers can emit a finish event.
    expect(observedSignal?.aborted).toBe(true)
  })

  it('attaches agentState from getAgentState to the SubagentTimeoutError on timeout', async () => {
    const logger = makeLogger()
    const agentState = { agentId: 'sub-1', creditsUsed: 42 }

    const error = await runWithSubagentTimeout({
      parentSignal: new AbortController().signal,
      timeoutMs: 20,
      agentType: 'hanging-agent',
      logger,
      getAgentState: () => agentState as never,
      run: neverResolves,
    }).catch((e) => e)

    expect(error).toBeInstanceOf(SubagentTimeoutError)
    expect((error as SubagentTimeoutError).agentState).toBe(agentState as never)
  })

  it('does not invoke onTimeout when the run completes before the timeout', async () => {
    const logger = makeLogger()
    const onTimeout = mock(() => {})

    const result = await runWithSubagentTimeout({
      parentSignal: new AbortController().signal,
      timeoutMs: 1000,
      agentType: 'test-agent',
      logger,
      onTimeout,
      run: async () => 'done',
    })

    expect(result).toBe('done')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('still rejects with SubagentTimeoutError when onTimeout throws', async () => {
    const logger = makeLogger()

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 20,
        agentType: 'hanging-agent',
        logger,
        onTimeout: () => {
          throw new Error('emit failed')
        },
        run: neverResolves,
      }),
    ).rejects.toBeInstanceOf(SubagentTimeoutError)

    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('aborts the child signal immediately when the parent signal is already aborted', async () => {
    const logger = makeLogger()
    const parentController = new AbortController()
    parentController.abort()

    let observedAborted: boolean | undefined
    await runWithSubagentTimeout({
      parentSignal: parentController.signal,
      timeoutMs: 1000,
      agentType: 'test-agent',
      logger,
      run: async (childSignal) => {
        observedAborted = childSignal.aborted
        return 'ok'
      },
    })

    expect(observedAborted).toBe(true)
  })

  it('aborts the child signal when the parent signal aborts mid-run', async () => {
    const logger = makeLogger()
    const parentController = new AbortController()

    const result = await runWithSubagentTimeout({
      parentSignal: parentController.signal,
      timeoutMs: 1000,
      agentType: 'test-agent',
      logger,
      run: (childSignal) =>
        new Promise<string>((resolve) => {
          childSignal.addEventListener(
            'abort',
            () => resolve('aborted'),
            { once: true },
          )
          // Trigger the parent abort on the next tick.
          setTimeout(() => parentController.abort(), 5)
        }),
    })

    expect(result).toBe('aborted')
  })

  it('propagates a non-timeout error thrown by run', async () => {
    const logger = makeLogger()

    await expect(
      runWithSubagentTimeout({
        parentSignal: new AbortController().signal,
        timeoutMs: 1000,
        agentType: 'test-agent',
        logger,
        run: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')

    expect(logger.error).not.toHaveBeenCalled()
  })
})
