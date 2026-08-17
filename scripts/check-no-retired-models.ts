#!/usr/bin/env bun
/**
 * CI guard: fail if any active source file pins an Anthropic model that has been
 * retired.
 *
 * Context: Anthropic sunsets model IDs (e.g. `claude-sonnet-4-20250514`). A
 * retired ID returns a hard 404, but that 404 is raised *after* the stream opens,
 * so the AI SDK surfaces it as an opaque `AI_NoOutputGeneratedError`. The retry
 * ladder classifies that as a transient overload and retries it three times
 * before failing with nothing useful in the logs — a stale pin therefore looks
 * like a flaky provider rather than a config error. This guard blocks the pin
 * from landing in the first place.
 *
 * The check is driven by `RETIRED_MODEL_SUCCESSORS` / `toAnthropicModelId`
 * rather than a hardcoded pattern, so retiring a model in one place is enough:
 * add it to the map and this guard starts enforcing it.
 *
 * What it flags: `model: "<id>"` / `model: '<id>'` literals naming an Anthropic
 * model that is retired or otherwise unroutable. Both the prefixed
 * (`anthropic/claude-...`) and bare (`claude-...`) forms are checked.
 * What it ignores:
 *   - Archived/dead code in `agents-graveyard/` (matches the Grok guard).
 *   - Generated files (`*.generated.ts`).
 *   - JSON fixtures / eval snapshots (`*.json`) — recorded run state, not pins.
 *   - Test files, which deliberately assert on retired IDs.
 *   - This guard script itself.
 *
 * Usage: `bun scripts/check-no-retired-models.ts`
 * Exits 1 (with a list of offending locations and the replacement to use) if any
 * retired pin is found.
 */
import { $ } from 'bun'

import { toAnthropicModelId } from '../common/src/constants/claude-oauth'

// Paths/globs to exclude from the check.
const EXCLUDES = [
  'agents-graveyard/**',
  '**/*.generated.ts',
  '**/*.json',
  '**/__tests__/**',
  '**/*.test.ts',
  'scripts/check-no-retired-models.ts',
]

/** Matches `model: "..."` and `model: '...'`. */
const MODEL_PIN = /model:\s*["']([^"']+)["']/

async function main() {
  const globArgs = EXCLUDES.flatMap((glob) => ['-g', `!${glob}`])

  // ripgrep exits 0 when matches found, 1 when none, >1 on error.
  const result = await $`rg --line-number --no-heading --color never ${globArgs} model:`
    .nothrow()
    .quiet()

  if (result.exitCode > 1) {
    console.error('Error running ripgrep:', result.stderr.toString())
    process.exit(2)
  }

  const offenders: string[] = []
  for (const line of result.stdout.toString().split('\n')) {
    const match = line.match(MODEL_PIN)
    if (!match) continue

    const model = match[1]
    // Only Anthropic pins are resolved through the OAuth model map.
    if (!model.startsWith('anthropic/') && !model.startsWith('claude-')) continue

    try {
      toAnthropicModelId(model)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      offenders.push(`${line.split(':').slice(0, 2).join(':')}\n    ${reason}`)
    }
  }

  if (offenders.length === 0) {
    console.log('✅ No retired Anthropic model references found.')
    return
  }

  console.error(
    `❌ Found ${offenders.length} reference(s) to retired or unroutable Anthropic models:\n`,
  )
  for (const offender of offenders) console.error(`  ${offender}\n`)
  process.exit(1)
}

main()
