import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path, { dirname } from 'path'
import { format as stringFormat } from 'util'


import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { env, IS_DEV, IS_TEST, IS_CI } from '@codebuff/common/env'
import { createAnalyticsDispatcher } from '@codebuff/common/util/analytics-dispatcher'
import { getAnalyticsEventId } from '@codebuff/common/util/analytics-log'
import { pino } from 'pino'

import {
  flushAnalytics,
  logError,
  setAnalyticsErrorLogger,
  trackEvent,
} from './analytics'
import { getProjectRoot } from '../project-files'

export interface LoggerContext {
  userId?: string
  userEmail?: string
  clientSessionId?: string
  fingerprintId?: string
  clientRequestId?: string
  [key: string]: any // Allow for future extensions
}

export const loggerContext: LoggerContext = {}

let logPath: string | undefined = undefined
let pinoLogger: any = undefined

// Persistent, discoverable global log sink for the installed CLI. Unlike the
// per-conversation `log.jsonl` (which is scattered across chat dirs), this is a
// single stable file so a "random stop" always leaves a findable trail of
// WARN/ERROR/FATAL entries. Size-rotated like prompt-logger/hippo-logger.
const GLOBAL_LOG_MAX_SIZE = 5 * 1024 * 1024 // 5MB
const GLOBAL_LOG_TRUNCATE_TO = 2.5 * 1024 * 1024 // Keep last ~2.5MB after truncation

// Per-project debug log — captures all levels for the directory where codebuff runs.
// Capped at 50MB so the full per-project debug directory stays well under 400MB
// when combined with hippo-interactions.log (~20MB), hippo-prompts.log (~20MB),
// prompt-log.txt (~5MB), and per-session chat logs.
const PROJECT_LOG_MAX_SIZE = 50 * 1024 * 1024 // 50MB
const PROJECT_LOG_TRUNCATE_TO = 25 * 1024 * 1024 // Keep last 25MB after rotation

function getGlobalLogPath(): string | null {
  try {
    return path.join(os.homedir(), '.codebuff', 'logs', 'cli.jsonl')
  } catch {
    return null
  }
}

/**
 * Rotate a log file in-place when it exceeds maxSize, keeping the last
 * truncateTo bytes snapped to a newline boundary (so we never leave a partial
 * JSON line at the top). Best-effort: never throws.
 */
function rotateFileIfTooLarge(filePath: string, maxSize: number, truncateTo: number): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size <= maxSize) return
    const content = readFileSync(filePath)
    const kept = content.slice(content.length - truncateTo)
    const firstNewline = kept.indexOf(10) // 0x0A = '\n'
    const clean = firstNewline >= 0 ? kept.slice(firstNewline + 1) : kept
    writeFileSync(filePath, clean)
  } catch {
    // Best-effort — never block the caller
  }
}

/**
 * Append a line to the persistent global CLI log. No-op in dev/test/ci (those
 * already have their own discoverable logs). Best-effort: never throws.
 */
function appendToGlobalLog(entry: string): void {
  if (IS_DEV || IS_TEST || IS_CI) return
  const filePath = getGlobalLogPath()
  if (!filePath) return

  try {
    mkdirSync(dirname(filePath), { recursive: true })
    rotateFileIfTooLarge(filePath, GLOBAL_LOG_MAX_SIZE, GLOBAL_LOG_TRUNCATE_TO)
    appendFileSync(filePath, entry)
  } catch {
    // Best-effort logging — the logger must never throw.
  }
}

const loggingLevels = ['info', 'debug', 'warn', 'error', 'fatal'] as const
type LogLevel = (typeof loggingLevels)[number]
const analyticsDispatcher = createAnalyticsDispatcher({
  envName: env.NEXT_PUBLIC_CB_ENVIRONMENT,
  bufferWhenNoUser: true,
})

/**
 * Safely stringify an object, handling circular references.
 * Replaces circular references with '[Circular]' placeholder.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  })
}

function isEmptyObject(value: any): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

function setLogPath(p: string): void {
  if (p === logPath) return // nothing to do

  logPath = p
  mkdirSync(dirname(p), { recursive: true })

  // Rotate the log file before opening it if it exceeds the size cap.
  rotateFileIfTooLarge(p, PROJECT_LOG_MAX_SIZE, PROJECT_LOG_TRUNCATE_TO)

  // ──────────────────────────────────────────────────────────────
  //  pino.destination(..) → SonicBoom stream, no worker thread
  // ──────────────────────────────────────────────────────────────
  const fileStream = pino.destination({
    dest: p, // absolute or relative file path
    mkdir: true, // create parent dirs if they don’t exist
    sync: true, // set true if you *must* block on every write
  })

  pinoLogger = pino(
    {
      level: 'debug',
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    },
    fileStream, // <-- no worker thread involved
  )
}

export function clearLogFile(): void {
  const projectRoot = getProjectRoot()
  const defaultLog = path.join(projectRoot, 'debug', 'cli.jsonl')
  const targets = new Set<string>()

  if (logPath) {
    targets.add(logPath)
  }
  targets.add(defaultLog)

  for (const target of targets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target)
      }
    } catch {
      // Ignore errors when clearing logs
    }
  }

  logPath = undefined
  pinoLogger = undefined
}

function sendAnalyticsAndLog(
  level: LogLevel,
  data: any,
  msg?: string,
  ...args: any[]
): void {
  if (!IS_CI && !IS_TEST) {
    let projectRoot: string | undefined
    try {
      projectRoot = getProjectRoot()
    } catch {
      projectRoot = undefined
    }
    if (projectRoot) {
      // All CLI debug logs consolidate into a single per-project file so the
      // trail is easy to find (previously prod scattered logs across
      // debug/chats/{chatId}/log.jsonl).
      const logTarget = path.join(projectRoot, 'debug', 'cli.jsonl')

      setLogPath(logTarget)
    }
  }

  const isStringOnly = typeof data === 'string' && msg === undefined
  const normalizedData = isStringOnly ? undefined : data
  const normalizedMsg = isStringOnly ? (data as string) : msg
  const includeData = normalizedData != null && !isEmptyObject(normalizedData)

  const toTrack = {
    ...(includeData ? { data: normalizedData } : {}),
    level,
    loggerContext,
    msg: stringFormat(normalizedMsg, ...args),
  }

  logAsErrorIfNeeded(toTrack)

  try {
    if (!IS_DEV && includeData && typeof normalizedData === 'object') {
      const analyticsPayloads = analyticsDispatcher.process({
        data: normalizedData,
        level,
        msg: stringFormat(normalizedMsg ?? '', ...args),
        fallbackUserId: loggerContext.userId,
      })

      analyticsPayloads.forEach((payload) => {
        trackEvent(payload.event, payload.properties)
      })
    }

    // Send all log events to PostHog in production for better observability
    // Skip if the log already has an eventId (to avoid duplicate tracking)
    const hasEventId = includeData && getAnalyticsEventId(normalizedData) !== null
    if (!IS_DEV && !IS_TEST && !IS_CI && !hasEventId) {
      trackEvent(AnalyticsEvent.CLI_LOG, {
        level,
        msg: stringFormat(normalizedMsg ?? '', ...args),
        ...(includeData ? { data: normalizedData } : {}),
        ...loggerContext,
      })
    }
  } catch {
    // Silently swallow analytics errors — the logger must never throw
  }

  // In dev mode, use appendFileSync for real-time logging (Bun has issues with pino sync)
  // In prod mode, use pino for better performance
  if (IS_DEV && logPath) {
    const logEntry = safeStringify({
      level: level.toUpperCase(),
      timestamp: new Date().toISOString(),
      ...loggerContext,
      ...(includeData ? { data: normalizedData } : {}),
      msg: stringFormat(normalizedMsg ?? '', ...args),
    })
    try {
      appendFileSync(logPath, logEntry + '\n')
    } catch {
      // Ignore write errors
    }
  } else if (pinoLogger !== undefined) {
    const base = { ...loggerContext }
    const obj = includeData ? { ...base, data: normalizedData } : base
    pinoLogger[level](obj, normalizedMsg as any, ...args)
  }

  // Build a single serialized entry reused for both sink calls below.
  const sinkEntry =
    safeStringify({
      level: level.toUpperCase(),
      timestamp: new Date().toISOString(),
      ...loggerContext,
      ...(includeData ? { data: normalizedData } : {}),
      msg: stringFormat(normalizedMsg ?? '', ...args),
    }) + '\n'

  // Always mirror WARN/ERROR/FATAL to the persistent global log so the next
  // "random stop" leaves a findable trail (no-op in dev/test/ci).
  if (level === 'warn' || level === 'error' || level === 'fatal') {
    appendToGlobalLog(sinkEntry)
  }
}

function logAsErrorIfNeeded(toTrack: {
  data?: any
  level: LogLevel
  loggerContext: LoggerContext
  msg: string
}) {
  if (toTrack.level === 'error' || toTrack.level === 'fatal') {
    logError(
      new Error(toTrack.msg),
      toTrack.loggerContext.userId ?? 'unknown',
      { ...(toTrack.data ?? {}), context: toTrack.loggerContext },
    )
    flushAnalytics()
  }
}

/**
 * Wrapper around Pino logger.
 *
 * To also send to Posthog, set data.eventId to type AnalyticsEvent
 *
 * e.g. logger.info({eventId: AnalyticsEvent.SOME_EVENT, field: value}, 'some message')
 */
export const logger: Record<LogLevel, pino.LogFn> = Object.fromEntries(
  loggingLevels.map((level) => {
    return [
      level,
      (data: any, msg?: string, ...args: any[]) =>
        sendAnalyticsAndLog(level, data, msg, ...args),
    ]
  }),
) as Record<LogLevel, pino.LogFn>

setAnalyticsErrorLogger((error, context) => {
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown analytics error')

  logger.warn(
    {
      analyticsError: true,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      context,
    },
    '[analytics] error',
  )
})
