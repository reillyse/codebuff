// SPARROW: Fills test gaps 8.6, 8.7, 8.8 from openspec/changes/sparrow-telemetry/tasks.md.
// - 8.6: Sub-agent spawn nests `agent.run` under parent's active `agent.step`.
// - 8.7: Uninitialized tracer → all entry points are safe no-ops.
// - 8.8: Privacy default — with capture off, no span attribute or event value
//         contains message content across every span type.

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
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
  getTracer,
  isTelemetryActive,
} from '../tracer-provider'

function byName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name)
}
function byNameAll(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name)
}

describe('sub-agent spawn nests agent.run under parent agent.step (spec 8.6)', () => {
  let exporter: InMemorySpanExporter

  beforeEach(async () => {
    __resetHarvestCache()
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
      serviceVersion: 'coverage-gaps',
    })
    await primeHarvestCache()
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
    __resetHarvestCache()
  })

  it('child agent.run (sub-agent) has parent = active agent.step of parent agent', async () => {
    await withPromptSpan({ sessionId: 'session' }, async () =>
      withAgentRunSpan(
        { agentId: 'parent', agentDisplayId: 'parent-display' },
        async () =>
          withAgentStepSpan(
            { agentId: 'parent', stepNumber: 1 },
            async () => {
              // Simulate spawn_agents tool invocation on the parent's step
              const tool = recordToolCall({
                toolName: 'spawn_agents',
                input: { agents: [{ agent_type: 'child' }] },
                childAgentId: 'child',
              })
              tool.finish({ success: true, output: 'spawned' })

              // Child agent.run opens while still inside the parent step's
              // OTel context, so AsyncLocalStorage links it to the step.
              await withAgentRunSpan(
                {
                  agentId: 'child',
                  agentDisplayId: 'child-display',
                  parentAgentId: 'parent',
                },
                async () =>
                  withAgentStepSpan(
                    { agentId: 'child', stepNumber: 1 },
                    async () => {
                      const llm = recordLlmCall({
                        requestModel: 'm',
                        route: 'codebuff_backend',
                      })
                      llm.finalize({ inputTokens: 5, outputTokens: 3 })
                      llm.end()
                    },
                  ),
              )
            },
          ),
      ),
    )

    const spans = exporter.getFinishedSpans()

    const prompt = byName(spans, SpanNames.PROMPT)!
    const agentRuns = byNameAll(spans, SpanNames.AGENT_RUN)
    expect(agentRuns.length).toBe(2)

    // Identify parent vs child by AGENT_ID attribute
    const parentRun = agentRuns.find(
      (s) => s.attributes[Attr.AGENT_ID] === 'parent',
    )!
    const childRun = agentRuns.find(
      (s) => s.attributes[Attr.AGENT_ID] === 'child',
    )!
    expect(parentRun).toBeDefined()
    expect(childRun).toBeDefined()

    // Parent run nests under prompt
    expect(parentRun.parentSpanContext?.spanId).toBe(
      prompt.spanContext().spanId,
    )

    // Find the parent's agent.step (only one step in this test for parent)
    const parentSteps = byNameAll(spans, SpanNames.AGENT_STEP).filter(
      (s) => s.attributes[Attr.AGENT_ID] === 'parent',
    )
    expect(parentSteps.length).toBe(1)
    const parentStep = parentSteps[0]

    // Child agent.run nests under the parent's active agent.step (spec 8.6)
    expect(childRun.parentSpanContext?.spanId).toBe(
      parentStep.spanContext().spanId,
    )

    // Parent agent id propagated onto child agent.run attributes
    expect(childRun.attributes[Attr.PARENT_AGENT_ID]).toBe('parent')

    // Child rollup is part of parent's rollup (spec: ancestors accumulate)
    expect(parentRun.attributes[Attr.LLM_CALL_COUNT]).toBe(1)
    expect(parentRun.attributes[Attr.ROLLUP_INPUT_TOKENS]).toBe(5)
  })
})

describe('uninitialized tracer: all entry points are silent no-ops (spec 8.7)', () => {
  beforeEach(() => {
    __resetTelemetryForTests()
    // Intentionally do NOT call __initTelemetryForTests here.
  })

  afterEach(() => {
    __resetTelemetryForTests()
  })

  it('isTelemetryActive() returns false', () => {
    expect(isTelemetryActive()).toBe(false)
  })

  it('getTracer() still returns a tracer (OTel noop) — never throws', () => {
    expect(() => getTracer()).not.toThrow()
    expect(getTracer()).toBeDefined()
  })

  it('recordLlmCall + finalize + end do not throw', () => {
    expect(() => {
      const llm = recordLlmCall({
        requestModel: 'm',
        route: 'codebuff_backend',
      })
      llm.recordAttempt({
        attempt: 1,
        route: 'codebuff_backend',
        model: 'm',
        succeeded: true,
      })
      llm.recordMessages('{"role":"user"}')
      llm.finalize({ inputTokens: 10, outputTokens: 5 })
      llm.end()
    }).not.toThrow()
  })

  it('recordToolCall + finish (success + failure) do not throw', () => {
    expect(() => {
      const a = recordToolCall({ toolName: 'read_files', input: {} })
      a.finish({ success: true, output: 'ok' })
      const b = recordToolCall({ toolName: 'read_files', input: {} })
      b.finish({ success: false, error: new Error('x') })
    }).not.toThrow()
  })

  it('withPromptSpan / withAgentRunSpan / withAgentStepSpan resolve to callback value', async () => {
    const value = await withPromptSpan({ sessionId: 's' }, async () =>
      withAgentRunSpan({ agentId: 'a' }, async () =>
        withAgentStepSpan({ agentId: 'a', stepNumber: 1 }, async () => 'ok'),
      ),
    )
    expect(value).toBe('ok')
  })

  it('callback errors still propagate through with*Span (not swallowed)', async () => {
    await expect(
      withPromptSpan({ sessionId: 's' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})

describe('privacy default: no message content across all spans (spec 8.8)', () => {
  let exporter: InMemorySpanExporter

  beforeEach(async () => {
    __resetHarvestCache()
    __resetTelemetryForTests()
    exporter = new InMemorySpanExporter()
    __initTelemetryForTests({
      processors: [new SimpleSpanProcessor(exporter)],
    })
    await primeHarvestCache()
  })

  afterEach(() => {
    exporter.reset()
    __resetTelemetryForTests()
    __resetHarvestCache()
  })

  it('no span in the full hierarchy contains the secret message content', async () => {
    const SECRET = '__VERY_SECRET_PROMPT_CONTENT_12345__'
    const SECRET_TOOL_ARG = '__VERY_SECRET_TOOL_ARGUMENT_67890__'

    await withPromptSpan({ sessionId: 'priv' }, async () =>
      withAgentRunSpan({ agentId: 'a' }, async () =>
        withAgentStepSpan({ agentId: 'a', stepNumber: 1 }, async () => {
          // LLM call: we never call recordMessages() so the secret should not
          // land on any span as content.
          const llm = recordLlmCall({
            requestModel: 'm',
            route: 'codebuff_backend',
          })
          // Simulate a user input the caller "forgot" to redact — it is never
          // handed to the telemetry layer on purpose, which is the whole point
          // of privacy-by-default.
          void SECRET
          llm.finalize({ inputTokens: 10, outputTokens: 5 })
          llm.end()

          // Tool call: input contains a "secret" argument; only byte counts
          // must be recorded, never the argument value itself.
          const tool = recordToolCall({
            toolName: 'write_file',
            input: { path: 'x.ts', content: SECRET_TOOL_ARG },
          })
          tool.finish({
            success: true,
            output: `wrote ${SECRET_TOOL_ARG.length} bytes`,
          })
        }),
      ),
    )

    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThan(0)

    // Sweep every attribute value on every span for any trace of the secrets.
    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        if (value === undefined || value === null) continue
        const serialized = Array.isArray(value)
          ? JSON.stringify(value)
          : String(value)
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toContain(SECRET_TOOL_ARG)
        // extra paranoia: nothing should carry the PROMPT_MESSAGES attribute
        // by default (that's the single opt-in channel for content capture)
        if (key === Attr.PROMPT_MESSAGES) {
          throw new Error(
            `Privacy leak: span ${span.name} set ${key} by default`,
          )
        }
      }

      // Sweep events + their attribute maps
      for (const ev of span.events) {
        expect(ev.name).not.toBe(Events.PROMPT_MESSAGES)
        for (const v of Object.values(ev.attributes ?? {})) {
          if (v === undefined || v === null) continue
          const s = Array.isArray(v) ? JSON.stringify(v) : String(v)
          expect(s).not.toContain(SECRET)
          expect(s).not.toContain(SECRET_TOOL_ARG)
        }
      }
    }
  })
})
