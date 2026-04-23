import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Attr, Events, SpanNames } from '../attributes'
import { __resetHarvestCache, primeHarvestCache } from '../context-harvester'
import {
  recordLlmCall,
  recordToolCall,
  withAgentRunSpan,
  withAgentStepSpan,
  withPromptSpan,
} from '../span-helpers'
import {
  __initTelemetryForTests,
  __resetTelemetryForTests,
} from '../tracer-provider'

function byName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name)
}

function byNameAll(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name)
}

describe('telemetry integration: full span hierarchy', () => {
  let exporter: InMemorySpanExporter

  beforeEach(async () => {
    __resetHarvestCache()
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
      serviceVersion: 'integration-test',
    })
    // Prime so withPromptSpan's async harvest resolves from cache, not a probe.
    await primeHarvestCache()
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
    __resetHarvestCache()
  })

  it('builds prompt > agent.run > agent.step > gen_ai.chat + tool.call', async () => {
    await withPromptSpan(
      { sessionId: 'sess-1', serviceVersion: 'integration-test' },
      async () =>
        withAgentRunSpan(
          { agentId: 'agent-root', agentDisplayId: 'base', parentAgentId: undefined },
          async () =>
            withAgentStepSpan(
              { agentId: 'agent-root', agentDisplayId: 'base', stepNumber: 1 },
              async () => {
                // One LLM call with usage + cost
                const llm = recordLlmCall({
                  system: 'ai-sdk',
                  requestModel: 'test-model',
                  route: 'codebuff_backend',
                  routeAttempt: 1,
                })
                llm.finalize({
                  responseModel: 'test-model',
                  finishReason: 'stop',
                  inputTokens: 1000,
                  outputTokens: 500,
                  cacheReadTokens: 200,
                  cacheCreationTokens: 100,
                  costUsd: 0.01,
                  costCredits: 100,
                })
                llm.end()

                // One tool call
                const tool = recordToolCall({
                  toolName: 'read_files',
                  input: { paths: ['foo.ts'] },
                })
                tool.finish({ success: true, output: 'file contents' })
              },
            ),
        ),
    )

    const spans = exporter.getFinishedSpans()

    // Exactly 5 spans: prompt, agent.run, agent.step, gen_ai.chat, tool.call
    expect(spans.length).toBe(5)

    const prompt = byName(spans, SpanNames.PROMPT)!
    const agentRun = byName(spans, SpanNames.AGENT_RUN)!
    const agentStep = byName(spans, SpanNames.AGENT_STEP)!
    const genAi = byName(spans, SpanNames.GEN_AI_CHAT)!
    const tool = byName(spans, SpanNames.TOOL_CALL)!
    expect(prompt).toBeDefined()
    expect(agentRun).toBeDefined()
    expect(agentStep).toBeDefined()
    expect(genAi).toBeDefined()
    expect(tool).toBeDefined()

    // Parent/child relationships via OTel context propagation
    const promptId = prompt.spanContext().spanId
    const agentRunId = agentRun.spanContext().spanId
    const agentStepId = agentStep.spanContext().spanId
    expect(agentRun.parentSpanContext?.spanId).toBe(promptId)
    expect(agentStep.parentSpanContext?.spanId).toBe(agentRunId)
    expect(genAi.parentSpanContext?.spanId).toBe(agentStepId)
    expect(tool.parentSpanContext?.spanId).toBe(agentStepId)

    // Session + service version on prompt
    expect(prompt.attributes[Attr.SESSION_ID]).toBe('sess-1')
    expect(prompt.attributes[Attr.SERVICE_VERSION]).toBe('integration-test')
    // Harvest-provided sync attrs
    expect(prompt.attributes[Attr.CWD]).toBeDefined()
    expect(prompt.attributes[Attr.HOST_NAME]).toBeDefined()

    // Agent run/step identifiers
    expect(agentRun.attributes[Attr.AGENT_ID]).toBe('agent-root')
    expect(agentRun.attributes[Attr.AGENT_DISPLAY_ID]).toBe('base')
    expect(agentStep.attributes[Attr.STEP_NUMBER]).toBe(1)

    // gen_ai.chat attributes
    expect(genAi.attributes[Attr.GEN_AI_SYSTEM]).toBe('ai-sdk')
    expect(genAi.attributes[Attr.GEN_AI_REQUEST_MODEL]).toBe('test-model')
    expect(genAi.attributes[Attr.GEN_AI_USAGE_INPUT_TOKENS]).toBe(1000)
    expect(genAi.attributes[Attr.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(500)
    expect(genAi.attributes[Attr.ROUTE]).toBe('codebuff_backend')

    // tool.call attributes
    expect(tool.attributes[Attr.TOOL_NAME]).toBe('read_files')
    expect(tool.attributes[Attr.TOOL_SUCCESS]).toBe(true)
    expect(tool.attributes[Attr.TOOL_BYTES_IN]).toBeGreaterThan(0)
    expect(tool.attributes[Attr.TOOL_BYTES_OUT]).toBeGreaterThan(0)
    expect(tool.attributes[Attr.TOOL_DURATION_MS]).toBeGreaterThanOrEqual(0)
  })

  it('rolls up LLM cost/tokens into every ancestor', async () => {
    await withPromptSpan({ sessionId: 's' }, async () =>
      withAgentRunSpan({ agentId: 'a1' }, async () =>
        withAgentStepSpan({ agentId: 'a1', stepNumber: 1 }, async () => {
          const llm1 = recordLlmCall({ requestModel: 'm', route: 'codebuff_backend' })
          llm1.finalize({
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.001,
            costCredits: 10,
          })
          llm1.end()

          const llm2 = recordLlmCall({ requestModel: 'm', route: 'codebuff_backend' })
          llm2.finalize({
            inputTokens: 200,
            outputTokens: 80,
            costUsd: 0.002,
            costCredits: 20,
          })
          llm2.end()
        }),
      ),
    )

    const spans = exporter.getFinishedSpans()
    const prompt = byName(spans, SpanNames.PROMPT)!
    const agentRun = byName(spans, SpanNames.AGENT_RUN)!
    const agentStep = byName(spans, SpanNames.AGENT_STEP)!

    // Every ancestor gets the full sum of 2 LLM calls
    for (const ancestor of [prompt, agentRun, agentStep]) {
      expect(ancestor.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(300)
      expect(ancestor.attributes[Attr.ROLLUP_OUTPUT_TOKENS]).toBe(130)
      expect(ancestor.attributes[Attr.COST_CREDITS]).toBe(30)
      expect(ancestor.attributes[Attr.LLM_CALL_COUNT]).toBe(2)
      const costUsd = ancestor.attributes[Attr.COST_USD] as number
      expect(costUsd).toBeCloseTo(0.003, 6)
    }
  })

  it('records route_attempt_failed events when fallback occurs on the same span', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({
        system: 'ai-sdk',
        requestModel: 'claude-sonnet',
        route: 'claude_oauth',
        routeAttempt: 1,
      })
      // Simulate a failed Claude OAuth attempt, then fallback to codebuff_backend
      llm.recordAttempt({
        attempt: 1,
        route: 'claude_oauth',
        model: 'claude-sonnet',
        succeeded: false,
        error: 'claude_oauth_rate_limited',
      })
      llm.finalize({
        route: 'codebuff_backend',
        attempt: 2,
        inputTokens: 100,
        outputTokens: 50,
      })
      llm.end()
    })

    const genAi = byName(exporter.getFinishedSpans(), SpanNames.GEN_AI_CHAT)!
    expect(genAi).toBeDefined()

    // Initial attempt attrs on open
    expect(genAi.attributes[Attr.GEN_AI_REQUEST_MODEL]).toBe('claude-sonnet')
    // Final route + attempt number set by finalize
    expect(genAi.attributes[Attr.ROUTE]).toBe('codebuff_backend')
    expect(genAi.attributes[Attr.ROUTE_ATTEMPT]).toBe(2)

    // route_attempt_failed event recorded
    const failedEvents = genAi.events.filter(
      (e) => e.name === Events.ROUTE_ATTEMPT_FAILED,
    )
    expect(failedEvents.length).toBe(1)
    expect(failedEvents[0].attributes?.[Attr.ROUTE]).toBe('claude_oauth')
    expect(failedEvents[0].attributes?.error).toBe('claude_oauth_rate_limited')
  })

  it('gates prompt/completion content on explicit recordMessages() (privacy by default)', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({ requestModel: 'm', route: 'codebuff_backend' })
      // Intentionally NOT calling llm.recordMessages() — default behavior
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })

    const genAi = byName(exporter.getFinishedSpans(), SpanNames.GEN_AI_CHAT)!
    const messageEvents = genAi.events.filter(
      (e) => e.name === Events.PROMPT_MESSAGES,
    )
    expect(messageEvents.length).toBe(0)
    // No prompt.messages attribute either
    expect(genAi.attributes[Attr.PROMPT_MESSAGES]).toBeUndefined()
  })

  it('records prompt/completion content as an event when recordMessages() is called', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const llm = recordLlmCall({ requestModel: 'm', route: 'codebuff_backend' })
      llm.recordMessages(JSON.stringify([{ role: 'user', content: 'hi' }]))
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    })

    const genAi = byName(exporter.getFinishedSpans(), SpanNames.GEN_AI_CHAT)!
    const messageEvents = genAi.events.filter(
      (e) => e.name === Events.PROMPT_MESSAGES,
    )
    expect(messageEvents.length).toBe(1)
    expect(
      messageEvents[0].attributes?.[Attr.PROMPT_MESSAGES],
    ).toBeDefined()
  })

  it('records tool.call failure with ERROR status', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const tool = recordToolCall({
        toolName: 'run_terminal_command',
        input: { command: 'false' },
      })
      tool.finish({ success: false, error: new Error('ExitCode1') })
    })

    const tool = byName(exporter.getFinishedSpans(), SpanNames.TOOL_CALL)!
    expect(tool.attributes[Attr.TOOL_SUCCESS]).toBe(false)
    // ERROR status code = 2 in @opentelemetry/api SpanStatusCode
    expect(tool.status.code).toBe(2)
    // message is derived from error.name which defaults to 'Error' for `new Error(...)`
    expect(tool.status.message).toMatch(/Error/)
  })

  it('records child_agent_id for spawn_agents linkage', async () => {
    await withPromptSpan({ sessionId: 's' }, async () => {
      const tool = recordToolCall({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'editor' }] },
        childAgentId: 'editor',
      })
      tool.finish({ success: true, output: [] })
    })

    const tool = byName(exporter.getFinishedSpans(), SpanNames.TOOL_CALL)!
    expect(tool.attributes[Attr.TOOL_NAME]).toBe('spawn_agents')
    expect(tool.attributes[Attr.CHILD_AGENT_ID]).toBe('editor')
  })

  it('auto-flushes at the end of a top-level prompt span (turn-end flush)', async () => {
    // Spy processor that records every forceFlush() call. The real
    // BatchSpanProcessor is slow + async; this lets us assert the flush
    // happens synchronously after the prompt span closes, even though the
    // flush itself is fire-and-forget.
    let forceFlushCount = 0
    const spyProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: () => {
        forceFlushCount++
        return Promise.resolve()
      },
      shutdown: () => Promise.resolve(),
    }

    // Swap in a fresh provider with the spy alongside the existing
    // SimpleSpanProcessor/exporter (so span assertions still work).
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter), spyProcessor],
      serviceVersion: 'integration-test',
    })

    expect(forceFlushCount).toBe(0)

    await withPromptSpan({ sessionId: 'flush-test' }, async () => {
      // No LLM/tool work needed — just close the prompt span.
    })

    // The flush is fire-and-forget (void-expressioned) but its scheduling
    // is synchronous — the call into forceFlush() happens on the same tick
    // as the prompt span's end(). A single microtask tick is enough.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(forceFlushCount).toBe(1)
    // Prompt span still exported normally.
    const prompt = byName(exporter.getFinishedSpans(), SpanNames.PROMPT)
    expect(prompt).toBeDefined()
  })

  it('turn-end flush fires even when the prompt callback throws', async () => {
    let forceFlushCount = 0
    const spyProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: () => {
        forceFlushCount++
        return Promise.resolve()
      },
      shutdown: () => Promise.resolve(),
    }

    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter), spyProcessor],
      serviceVersion: 'integration-test',
    })

    await expect(
      withPromptSpan({ sessionId: 'flush-throw' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forceFlushCount).toBe(1)
  })

  it('turn-end flush swallows flush errors (does not affect turn result)', async () => {
    const erroringProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: () => Promise.reject(new Error('flush-fail')),
      shutdown: () => Promise.resolve(),
    }

    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter), erroringProcessor],
      serviceVersion: 'integration-test',
    })

    // The prompt completes normally and returns its value; the flush
    // rejection must be swallowed and must NOT surface as an unhandled
    // rejection or propagate to the caller.
    const result = await withPromptSpan(
      { sessionId: 'flush-error' },
      async () => 'ok' as const,
    )
    expect(result).toBe('ok')

    // Give the rejected fire-and-forget promise a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Prompt span still reached the exporter.
    expect(byName(exporter.getFinishedSpans(), SpanNames.PROMPT)).toBeDefined()
  })

  it('supports multiple sequential steps under one agent.run', async () => {
    await withPromptSpan({ sessionId: 's' }, async () =>
      withAgentRunSpan({ agentId: 'a' }, async () => {
        for (let i = 1; i <= 3; i++) {
          await withAgentStepSpan(
            { agentId: 'a', stepNumber: i },
            async () => {
              const llm = recordLlmCall({
                requestModel: 'm',
                route: 'codebuff_backend',
              })
              llm.finalize({ inputTokens: 10, outputTokens: 5, costCredits: 1 })
              llm.end()
            },
          )
        }
      }),
    )

    const spans = exporter.getFinishedSpans()
    const steps = byNameAll(spans, SpanNames.AGENT_STEP)
    expect(steps.length).toBe(3)
    expect(
      steps
        .map((s) => s.attributes[Attr.STEP_NUMBER] as number)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3])

    // Agent run rollup aggregates across all 3 steps
    const agentRun = byName(spans, SpanNames.AGENT_RUN)!
    expect(agentRun.attributes[Attr.LLM_CALL_COUNT]).toBe(3)
    expect(agentRun.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(30)
    expect(agentRun.attributes[Attr.COST_CREDITS]).toBe(3)
  })
})
