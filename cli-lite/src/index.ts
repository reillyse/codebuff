#!/usr/bin/env bun

// Must be the first import — sets env defaults before SDK validates them.
import './env-setup'

import { spawnSync } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'

import pkg from '../package.json'
import { runOnce, startRepl, DEFAULT_AGENT_MODE, getAgentForMode } from './repl'

const DEFAULT_AGENT = getAgentForMode(DEFAULT_AGENT_MODE)

function getVersion(): string {
  if (process.env.CODEBUFF_CLI_VERSION) {
    return process.env.CODEBUFF_CLI_VERSION
  }
  try {
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: 'pipe', cwd: pkgDir })
    if (result.status === 0) {
      const sha = result.stdout.toString().trim()
      if (sha) return `${pkg.version}+${sha}`
    }
  } catch {
    // git not available
  }
  return pkg.version
}

const program = new Command()
  .name('codebuff-lite')
  .description('Codebuff Lite — TUI-free AI coding agent powered by the Codebuff SDK')
  .version(getVersion())
  .option('-a, --agent <id>', 'Agent to use', DEFAULT_AGENT)
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .option('-v, --verbose', 'Show tool calls and subagent activity', process.env.CODEBUFF_VERBOSE !== undefined && process.env.CODEBUFF_VERBOSE !== '0')
  .argument('[prompt...]', 'Prompt to send (omit for interactive REPL mode)')
  .action(async (promptParts: string[], opts: {
    agent: string
    cwd: string
    verbose: boolean
  }) => {
    const prompt = promptParts.join(' ').trim()

    if (prompt) {
      // Single-shot mode: run once and exit
      await runOnce({
        agent: opts.agent,
        cwd: opts.cwd,
        verbose: opts.verbose,
        prompt,
      })
    } else {
      // Interactive REPL mode
      await startRepl({
        agent: opts.agent,
        cwd: opts.cwd,
        verbose: opts.verbose,
      })
    }
  })

program.parse()
