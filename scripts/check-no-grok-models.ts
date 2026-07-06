#!/usr/bin/env bun
/**
 * CI guard: fail if any active source file references a deprecated Grok / xAI model.
 *
 * Context: Codebuff standardized agents on OpenAI + Anthropic models (routed via
 * OAuth). Grok models (e.g. `x-ai/grok-4-fast`) were deprecated by xAI and cause
 * runtime `AI_APICallError` failures (which broke the nightly E2E + weft agent
 * images). This guard blocks reintroduction of Grok model references.
 *
 * What it flags: string literals selecting an xAI model, e.g. `x-ai/grok-...`.
 * What it ignores:
 *   - The English verb "grok" (only `x-ai/grok-*` model slugs are matched).
 *   - Archived/dead code in `agents-graveyard/`.
 *   - Generated files (`*.generated.ts`).
 *   - JSON fixtures / eval snapshots (`*.json`).
 *   - Marketing/docs copy under `web/src/content/` and `web/src/app/docs/`.
 *   - Provider-SDK special-casing in `packages/internal/src/openrouter-ai-sdk/`
 *     (handles a quirk where `x-ai/grok-code-fast-1` rejects the `stop` param;
 *     this is a compatibility shim, not a model selection).
 *   - This guard script itself.
 *
 * Usage: `bun scripts/check-no-grok-models.ts`
 * Exits 1 (with a list of offending locations) if any match is found.
 */
import { $ } from 'bun'

// Matches xAI model slugs like `x-ai/grok-4-fast`, `x-ai/grok-4-07-09`,
// `x-ai/grok-code-fast-1`, etc. Does NOT match the English word "grok".
const PATTERN = String.raw`x-ai/grok`

// Paths/globs to exclude from the check.
const EXCLUDES = [
  'agents-graveyard/**',
  '**/*.generated.ts',
  '**/*.json',
  'web/src/content/**',
  'web/src/app/docs/**',
  'packages/internal/src/openrouter-ai-sdk/**',
  'scripts/check-no-grok-models.ts',
]

async function main() {
  const globArgs = EXCLUDES.flatMap((glob) => ['-g', `!${glob}`])

  // ripgrep exits 0 when matches found, 1 when none, >1 on error.
  const result =
    await $`rg --line-number --no-heading --color never ${globArgs} ${PATTERN}`
      .nothrow()
      .quiet()

  const stdout = result.stdout.toString().trim()

  if (result.exitCode === 1 && stdout === '') {
    console.log('✅ No deprecated Grok / xAI model references found.')
    return
  }

  if (result.exitCode > 1) {
    console.error('Error running ripgrep:', result.stderr.toString())
    process.exit(2)
  }

  console.error(
    '❌ Found deprecated Grok / xAI model reference(s).\n' +
      'Codebuff standardized on OpenAI + Anthropic models. Replace these with a\n' +
      'supported model (e.g. `openai/gpt-5-mini`, `anthropic/claude-haiku-4.5`).\n',
  )
  console.error(stdout)
  process.exit(1)
}

main()
