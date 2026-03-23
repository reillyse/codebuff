import path from 'path'

import { describe, test, expect } from 'bun:test'

import { getAgentForMode, DEFAULT_AGENT_MODE } from '../repl'

describe('repl', () => {
  describe('getAgentForMode', () => {
    test('DEFAULT maps to base2', () => {
      expect(getAgentForMode('DEFAULT')).toBe('codebuff/base2@latest')
    })

    test('MAX maps to base2-max', () => {
      expect(getAgentForMode('MAX')).toBe('codebuff/base2-max@latest')
    })

    test('PLAN maps to base2-plan', () => {
      expect(getAgentForMode('PLAN')).toBe('codebuff/base2-plan@latest')
    })

    test('FREE falls back to base2 (DEFAULT)', () => {
      expect(getAgentForMode('FREE')).toBe('codebuff/base2@latest')
    })
  })

  describe('DEFAULT_AGENT_MODE', () => {
    test('defaults to MAX when env var is not set', () => {
      expect(DEFAULT_AGENT_MODE).toBe('MAX')
    })
  })

  describe('CODEBUFF_DEFAULT_MODE env var', () => {
    const cliLiteRoot = path.resolve(import.meta.dir, '../..')

    async function evalDefaultMode(envValue?: string): Promise<{ mode: string; stderr: string }> {
      const env: Record<string, string> = { ...(process.env as Record<string, string>) }
      if (envValue !== undefined) {
        env.CODEBUFF_DEFAULT_MODE = envValue
      } else {
        delete env.CODEBUFF_DEFAULT_MODE
      }
      const proc = Bun.spawn(
        ['bun', '-e', 'const m = await import("./src/repl.ts"); console.log(m.DEFAULT_AGENT_MODE)'],
        { cwd: cliLiteRoot, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      return { mode: stdout.trim(), stderr }
    }

    test('no env var → MAX', async () => {
      const { mode } = await evalDefaultMode()
      expect(mode).toBe('MAX')
    }, 15_000)

    test('default → DEFAULT', async () => {
      const { mode } = await evalDefaultMode('default')
      expect(mode).toBe('DEFAULT')
    }, 15_000)

    test('max → MAX', async () => {
      const { mode } = await evalDefaultMode('max')
      expect(mode).toBe('MAX')
    }, 15_000)

    test('plan → PLAN', async () => {
      const { mode } = await evalDefaultMode('plan')
      expect(mode).toBe('PLAN')
    }, 15_000)

    test('Default (mixed case) → DEFAULT', async () => {
      const { mode } = await evalDefaultMode('Default')
      expect(mode).toBe('DEFAULT')
    }, 15_000)

    test('PLAN (upper) → PLAN', async () => {
      const { mode } = await evalDefaultMode('PLAN')
      expect(mode).toBe('PLAN')
    }, 15_000)

    test('invalid value → MAX with warning', async () => {
      const { mode, stderr } = await evalDefaultMode('invalid')
      expect(mode).toBe('MAX')
      expect(stderr).toContain('Warning')
      expect(stderr).toContain('invalid')
    }, 15_000)

    test('valid value produces no warning', async () => {
      const { mode, stderr } = await evalDefaultMode('plan')
      expect(mode).toBe('PLAN')
      expect(stderr).not.toContain('Warning')
    }, 15_000)
  })
})
