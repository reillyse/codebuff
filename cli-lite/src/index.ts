#!/usr/bin/env bun

// Must be the first import — sets env defaults before SDK validates them.
import './env-setup'

import { Command } from 'commander'

import { printError } from './output'
import { runOnce, startRepl } from './repl'

const DEFAULT_AGENT = 'codebuff/base2@latest'

function getApiKey(): string | undefined {
  return process.env.CODEBUFF_API_KEY
}

const program = new Command()
  .name('codebuff-lite')
  .description('Codebuff Lite — TUI-free AI coding agent powered by the Codebuff SDK')
  .version('0.1.0')
  .option('-a, --agent <id>', 'Agent to use', DEFAULT_AGENT)
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .option('-v, --verbose', 'Show tool calls and subagent activity', false)
  .option('-k, --api-key <key>', 'Codebuff API key (or set CODEBUFF_API_KEY env var)')
  .argument('[prompt...]', 'Prompt to send (omit for interactive REPL mode)')
  .action(async (promptParts: string[], opts: {
    agent: string
    cwd: string
    verbose: boolean
    apiKey?: string
  }) => {
    const apiKey = opts.apiKey ?? getApiKey()

    if (!apiKey) {
      printError(
        'No API key found. Set CODEBUFF_API_KEY environment variable or use --api-key flag.\n' +
        'Get your API key at: https://www.codebuff.com/api-keys',
      )
      process.exit(1)
    }

    const prompt = promptParts.join(' ').trim()

    if (prompt) {
      // Single-shot mode: run once and exit
      await runOnce({
        apiKey,
        agent: opts.agent,
        cwd: opts.cwd,
        verbose: opts.verbose,
        prompt,
      })
    } else {
      // Interactive REPL mode
      await startRepl({
        apiKey,
        agent: opts.agent,
        cwd: opts.cwd,
        verbose: opts.verbose,
      })
    }
  })

program.parse()
