// SPARROW: /telemetry command — inspect and mutate the telemetry section of
// ~/.config/manicode{-env}/sparrow-config.json. Mirrors the ads.ts command
// pattern: small handlers that return a `postUserMessage` helper the router
// applies to the chat message list.
//
// Live-apply: mutating subcommands (enable/disable/dataset/capture-prompts/
// debug) call `reinitTelemetry()` after persisting so the new config takes
// effect in-process without requiring a CLI restart.

import {
  getSparrowConfigPath,
  resolveTelemetryConfig,
  saveSparrowConfig,
  type ResolvedSource,
  type ResolvedTelemetryConfig,
} from '@codebuff/common/sparrow/config/sparrow-config'
import {
  flushTelemetry,
  isTelemetryActive,
  reinitTelemetry,
} from '@codebuff/common/sparrow/telemetry'

import { logger } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'

import type { ChatMessage } from '../types/chat'

type PostUserMessage = (messages: ChatMessage[]) => ChatMessage[]
type HandlerResult = { postUserMessage: PostUserMessage }

function sourceSuffix(src: ResolvedSource): string {
  return ` (${src})`
}

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '<not set>'
  if (apiKey.length <= 8) return '****'
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

function renderStatus(resolved: ResolvedTelemetryConfig): string {
  const active = isTelemetryActive()
  const lines = [
    'Telemetry (Honeycomb) status:',
    `  active:          ${active}`,
    `  enabled:         ${resolved.enabled}${sourceSuffix(resolved.sources.enabled)}`,
    `  apiKey:          ${maskApiKey(resolved.apiKey)}${sourceSuffix(resolved.sources.apiKey)}`,
    `  dataset:         ${resolved.dataset}${sourceSuffix(resolved.sources.dataset)}`,
    `  capturePrompts:  ${resolved.capturePrompts}${sourceSuffix(resolved.sources.capturePrompts)}`,
    `  debug:           ${resolved.debug}${sourceSuffix(resolved.sources.debug)}`,
    '',
    `Config file: ${getSparrowConfigPath()}`,
  ]
  if (resolved.enabled && !resolved.apiKey) {
    lines.push('')
    lines.push(
      'Note: enabled=true but no apiKey is set — telemetry is inactive.',
    )
    lines.push(
      '      Run /telemetry enable <api-key> to provide a Honeycomb key.',
    )
  }
  lines.push('')
  lines.push(
    'Changes via /telemetry enable|disable|dataset|capture-prompts|debug apply immediately.',
  )
  lines.push(
    'Use /telemetry flush to push pending spans immediately. /telemetry help for full usage.',
  )
  return lines.join('\n')
}

function renderHelp(): string {
  return [
    'Telemetry commands:',
    '  /telemetry                         Show current status',
    '  /telemetry status                  Show current status',
    '  /telemetry enable [api-key]        Enable telemetry; optionally set Honeycomb API key',
    '  /telemetry disable                 Disable telemetry (keeps api key on disk)',
    '  /telemetry dataset <name>          Set Honeycomb dataset (default: sparrow-codebuff)',
    '  /telemetry capture-prompts on|off  Toggle prompt/message capture (privacy opt-in)',
    '  /telemetry debug on|off            Toggle exporter debug logs',
    '  /telemetry flush                   Push any pending spans to Honeycomb now',
    '  /telemetry help                    Show this help',
    '',
    'Config file: ' + getSparrowConfigPath(),
    'Env overrides: HONEYCOMB_API_KEY, HONEYCOMB_DATASET, SPARROW_TELEMETRY_CAPTURE_PROMPTS',
  ].join('\n')
}

function showMessage(text: string): HandlerResult {
  return {
    postUserMessage: (messages) => [...messages, getSystemMessage(text)],
  }
}

/**
 * Apply the just-saved config in-process. Failures are swallowed and logged —
 * the user's config was already persisted to disk, so the worst case is they
 * have to restart to pick up the change (matches the previous behaviour).
 */
async function applyLive(): Promise<void> {
  try {
    await reinitTelemetry()
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] reinit failed')
  }
}

/**
 * Describe the resolved live state after a mutation, for the user-visible
 * confirmation line. Status line tells the user what happened and why it
 * matters (so `enable` without an apiKey doesn't claim telemetry is live).
 */
function liveStatusLine(): string {
  const active = isTelemetryActive()
  const resolved = resolveTelemetryConfig()
  if (active) {
    return `Telemetry is now active (dataset: ${resolved.dataset}).`
  }
  if (resolved.enabled && !resolved.apiKey) {
    return 'Telemetry stays inactive until a Honeycomb API key is provided.'
  }
  return 'Telemetry is now inactive.'
}

/** `/telemetry` or `/telemetry status` → print resolved config + sources. */
export function handleTelemetryStatus(): HandlerResult {
  const resolved = resolveTelemetryConfig()
  return showMessage(renderStatus(resolved))
}

/**
 * `/telemetry enable [api-key]` — sets `telemetry.enabled: true`. When an
 * api-key argument is supplied it's stored in `telemetry.honeycomb.apiKey`.
 */
export async function handleTelemetryEnable(
  args: string,
): Promise<HandlerResult> {
  const trimmed = args.trim()
  const apiKey = trimmed.length > 0 ? trimmed : undefined
  try {
    saveSparrowConfig({
      telemetry: {
        enabled: true,
        ...(apiKey ? { honeycomb: { apiKey } } : {}),
      },
    })
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] failed to enable')
    return showMessage(
      `Failed to update ${getSparrowConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  await applyLive()

  const lines = [
    apiKey
      ? 'Telemetry enabled and API key saved.'
      : 'Telemetry enabled.',
    '',
    liveStatusLine(),
  ]
  const resolved = resolveTelemetryConfig()
  if (!resolved.apiKey) {
    lines.push(
      '',
      'No Honeycomb API key is resolvable from config or env.',
      'Run `/telemetry enable <api-key>` or export HONEYCOMB_API_KEY.',
    )
  }
  return showMessage(lines.join('\n'))
}

/** `/telemetry disable` — sets `telemetry.enabled: false`. */
export async function handleTelemetryDisable(): Promise<HandlerResult> {
  try {
    saveSparrowConfig({ telemetry: { enabled: false } })
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] failed to disable')
    return showMessage(
      `Failed to update ${getSparrowConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  await applyLive()
  return showMessage(`Telemetry disabled.\n\n${liveStatusLine()}`)
}

/** `/telemetry dataset <name>` — override Honeycomb dataset. */
export async function handleTelemetryDataset(
  args: string,
): Promise<HandlerResult> {
  const dataset = args.trim()
  if (!dataset) {
    return showMessage(
      'Usage: /telemetry dataset <name>\nCurrent value is shown via /telemetry status.',
    )
  }
  try {
    saveSparrowConfig({
      telemetry: { honeycomb: { dataset } },
    })
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] failed to set dataset')
    return showMessage(
      `Failed to update ${getSparrowConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  await applyLive()
  return showMessage(
    `Honeycomb dataset set to "${dataset}".\n\n${liveStatusLine()}`,
  )
}

function parseOnOff(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  return null
}

/**
 * `/telemetry capture-prompts on|off` — toggle prompt/message capture.
 * Stored as `telemetry.capturePrompts = 'full' | 'off'` to match the env
 * var semantics (env only accepts 'full').
 *
 * Note: `shouldCapturePrompts()` is consulted per-call against the config
 * cache (invalidated by `saveSparrowConfig`), so this one technically
 * doesn't need a provider reinit. We still call `applyLive()` for uniform
 * behaviour and to keep `debug` / future knobs consistent.
 */
export async function handleTelemetryCapturePrompts(
  args: string,
): Promise<HandlerResult> {
  const parsed = parseOnOff(args)
  if (parsed === null) {
    return showMessage('Usage: /telemetry capture-prompts on|off')
  }
  try {
    saveSparrowConfig({
      telemetry: { capturePrompts: parsed ? 'full' : 'off' },
    })
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] failed to set capturePrompts')
    return showMessage(
      `Failed to update ${getSparrowConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  await applyLive()
  return showMessage(
    parsed
      ? 'Prompt capture enabled. (Prompts/messages will be attached as span events — use only in trusted environments.)'
      : 'Prompt capture disabled.',
  )
}

/** `/telemetry debug on|off` — toggle exporter debug logs. */
export async function handleTelemetryDebug(
  args: string,
): Promise<HandlerResult> {
  const parsed = parseOnOff(args)
  if (parsed === null) {
    return showMessage('Usage: /telemetry debug on|off')
  }
  try {
    saveSparrowConfig({ telemetry: { debug: parsed } })
  } catch (err) {
    logger.error({ err }, '[sparrow:telemetry] failed to set debug')
    return showMessage(
      `Failed to update ${getSparrowConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  await applyLive()
  return showMessage(
    `Telemetry debug logs ${parsed ? 'enabled' : 'disabled'}.`,
  )
}

/**
 * `/telemetry flush` — push any pending spans to Honeycomb without tearing
 * down the provider. Useful right before closing the CLI on short-lived
 * sessions where the BatchSpanProcessor's 5-second timer hasn't fired yet.
 *
 * `flushTelemetry()` is documented to never reject (failures resolve to
 * 'error'), so the switch below is the complete error-handling surface.
 */
export async function handleTelemetryFlush(): Promise<HandlerResult> {
  const result = await flushTelemetry()
  switch (result) {
    case 'flushed':
      return showMessage('Pending spans flushed to Honeycomb.')
    case 'timeout':
      return showMessage(
        'Flush did not complete within the 2s budget. Some spans may still be in flight — they\'ll be retried on the next batch cycle.',
      )
    case 'error':
      return showMessage(
        'Flush failed (see logs if debug is enabled). Spans remain queued and will retry on the next batch cycle.',
      )
    case 'inactive':
      return showMessage(
        'Telemetry is not active — nothing to flush. Run /telemetry status for details.',
      )
    default: {
      // Exhaustiveness check: if `flushTelemetry`'s return type gains a new
      // variant, TS will error here until this switch is updated.
      const _exhaustive: never = result
      return showMessage(`Unexpected flush result: ${String(_exhaustive)}`)
    }
  }
}

/** `/telemetry help` — print usage. */
export function handleTelemetryHelp(): HandlerResult {
  return showMessage(renderHelp())
}

/** Router entry point — dispatches to the right subcommand handler. */
export async function handleTelemetry(args: string): Promise<HandlerResult> {
  const trimmed = args.trim()
  if (!trimmed) return handleTelemetryStatus()

  // Split "sub arg1 arg2..." → ["sub", "arg1 arg2..."]
  const firstSpace = trimmed.search(/\s/)
  const sub = (
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  ).toLowerCase()
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1)

  switch (sub) {
    case 'status':
      return handleTelemetryStatus()
    case 'enable':
    case 'on':
      return handleTelemetryEnable(rest)
    case 'disable':
    case 'off':
      return handleTelemetryDisable()
    case 'dataset':
      return handleTelemetryDataset(rest)
    case 'capture-prompts':
    case 'capture':
      return handleTelemetryCapturePrompts(rest)
    case 'debug':
      return handleTelemetryDebug(rest)
    case 'flush':
      return handleTelemetryFlush()
    case 'help':
    case '?':
      return handleTelemetryHelp()
    default:
      return showMessage(
        `Unknown subcommand: "${sub}". Try /telemetry help.`,
      )
  }
}
