import fs from 'fs'
import path from 'path'

import { describe, expect, it } from 'bun:test'

import { CodebuffClient } from '../client'
import { EventCollector, DEFAULT_TIMEOUT } from '../../e2e/utils'

import type { AgentOutput } from '@codebuff/common/types/session-state'

const apiKey = process.env.CODEBUFF_API_KEY

function extractOutputText(output: AgentOutput): string {
  if (output.type !== 'lastMessage' && output.type !== 'allMessages') return ''
  const messages = output.value as { role: string; content: unknown }[]
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part
        ) {
          return String(part.text)
        }
      }
    }
  }
  return ''
}

/**
 * These suites drive the real Codebuff backend. When it is unreachable — the
 * service is down, or the machine is offline — `client.run` rejects with a
 * network/5xx error that says nothing about prompt caching. Skip in that case
 * rather than reporting a failure, matching how the suite already skips when
 * CODEBUFF_API_KEY is unset.
 */
function isBackendUnavailable(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === 'number' && statusCode >= 500) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return (
    message.includes('network request failed') ||
    message.includes('fetch failed') ||
    message.includes('econnrefused')
  )
}

describe('Prompt Caching', () => {
  it(
    'should be cheaper on second request',
    async () => {
      if (!apiKey) {
        console.log(
          'Skipping prompt caching integration test: set CODEBUFF_API_KEY to run.\n' +
            'Example: CODEBUFF_API_KEY=your-key bun test src/__tests__/run.integration.test.ts',
        )
        return
      }

      try {
        const client = new CodebuffClient({ apiKey })

        const filler =
          `Run UUID: ${crypto.randomUUID()} ` +
          'Ignore this text. This is just to make the prompt longer. '.repeat(500)
        const prompt = 'respond with "hi"'

        const collector1 = new EventCollector()
        const run1 = await client.run({
          agent: 'base2',
          prompt: `${filler}\n\n${prompt}`,
          handleEvent: collector1.handleEvent,
        })

        console.dir(run1.output, { depth: null })
        expect(run1.output.type).not.toBe('error')

        const cost1 = collector1.getLastEvent('finish')?.totalCost ?? -1
        expect(cost1).toBeGreaterThanOrEqual(0)

        const collector2 = new EventCollector()
        const run2 = await client.run({
          agent: 'base2',
          prompt,
          previousRun: run1,
          handleEvent: collector2.handleEvent,
        })

        console.dir(run2.output, { depth: null })
        expect(run2.output.type).not.toBe('error')

        const cost2 = collector2.getLastEvent('finish')?.totalCost ?? -1
        expect(cost2).toBeGreaterThanOrEqual(0)

        console.log(`First request cost: ${cost1}, Second request cost: ${cost2}`)
        expect(cost2).toBeLessThanOrEqual(cost1 * 0.5)
      } catch (error) {
        if (isBackendUnavailable(error)) {
          console.log(
            'Skipping prompt caching integration test: Codebuff backend unreachable.',
          )
          return
        }
        throw error
      }
    },
    DEFAULT_TIMEOUT * 2,
  )

  it(
    'should not invalidate cache when git status changes between requests',
    async () => {
      if (!apiKey) {
        console.log(
          'Skipping prompt caching integration test: set CODEBUFF_API_KEY to run.',
        )
        return
      }

      const magic1 = Math.floor(10000 + Math.random() * 90000)
      const magic2 = Math.floor(10000 + Math.random() * 90000)
      const tempFile1 = path.join(
        __dirname,
        `cache-test-magic-${magic1}.tmp`,
      )
      const tempFile2 = path.join(
        __dirname,
        `cache-test-magic-${magic2}.tmp`,
      )

      try {
        fs.writeFileSync(tempFile1, `MAGIC_NUMBER=${magic1}`)

        const client = new CodebuffClient({ apiKey, cwd: process.cwd() })

        const filler =
          `Run UUID: ${crypto.randomUUID()} ` +
          'Ignore this text. This is just to make the prompt longer. '.repeat(
            500,
          )

        const collector1 = new EventCollector()
        const run1 = await client.run({
          agent: 'base2',
          prompt:
            `${filler}\n\n` +
            'Look at the Initial Git Changes section in your system prompt. ' +
            'There should be an untracked file in sdk/src/__tests__/ whose filename contains a 5-digit number. ' +
            'What is that 5-digit number? Respond with ONLY the number, nothing else.',
          handleEvent: collector1.handleEvent,
        })

        console.dir(run1.output, { depth: null })
        expect(run1.output.type).not.toBe('error')

        const responseText = extractOutputText(run1.output)
        console.log(
          `Magic number: ${magic1}, LLM response: "${responseText}"`,
        )
        expect(responseText).toContain(String(magic1))

        const cost1 = collector1.getLastEvent('finish')?.totalCost ?? -1
        expect(cost1).toBeGreaterThanOrEqual(0)

        fs.unlinkSync(tempFile1)
        fs.writeFileSync(tempFile2, `MAGIC_NUMBER=${magic2}`)

        const collector2 = new EventCollector()
        const run2 = await client.run({
          agent: 'base2',
          prompt: 'respond with "hi"',
          previousRun: run1,
          handleEvent: collector2.handleEvent,
        })

        console.dir(run2.output, { depth: null })
        expect(run2.output.type).not.toBe('error')

        const cost2 = collector2.getLastEvent('finish')?.totalCost ?? -1
        expect(cost2).toBeGreaterThanOrEqual(0)

        console.log(
          `Git status change test - Magic: ${magic1}→${magic2}, First: ${cost1}, Second: ${cost2}`,
        )
        expect(cost2).toBeLessThanOrEqual(cost1 * 0.5)
      } catch (error) {
        if (isBackendUnavailable(error)) {
          console.log(
            'Skipping prompt caching integration test: Codebuff backend unreachable.',
          )
          return
        }
        throw error
      } finally {
        try { fs.unlinkSync(tempFile1) } catch {}
        try { fs.unlinkSync(tempFile2) } catch {}
      }
    },
    DEFAULT_TIMEOUT * 2,
  )
})
