// SPARROW: Auto-harvester for per-prompt project/git/user context.
// All shell-outs are wrapped in try/catch; any failure silently omits that attribute.
//
// We use async `spawn` with Promise.all so cold-cache harvesting runs all git
// probes in parallel (capped at ~500ms each). The resolved value is cached for
// CACHE_TTL_MS so hot-cache callers pay nothing. A synchronous entry point is
// preserved for call sites that can't await (e.g. process-exit hooks) — it
// returns whatever is currently cached, possibly empty.

import { spawn } from 'child_process'
import os from 'os'

import { Attr } from './attributes'

const CACHE_TTL_MS = 5_000
const GIT_TIMEOUT_MS = 500
const GIT_MAX_BUFFER = 1 << 20 // 1 MiB — porcelain status can be large on dirty trees

export type HarvestedContext = Partial<{
  [Attr.CWD]: string
  [Attr.HOST_NAME]: string
  [Attr.OS_TYPE]: string
  [Attr.PROCESS_PID]: number
  [Attr.USER_EMAIL]: string
  [Attr.USER_NAME]: string
  [Attr.GIT_REPO]: string
  [Attr.GIT_BRANCH]: string
  [Attr.GIT_COMMIT]: string
  [Attr.GIT_WORKTREE]: string
  [Attr.GIT_DIRTY]: boolean
  [Attr.LINEAR_ISSUE]: string
  [Attr.SESSION_ID]: string
}>

let cache: { at: number; value: HarvestedContext } | null = null
let inflight: Promise<HarvestedContext> | null = null

/**
 * Run a single `git <args>` command with a hard timeout. Returns trimmed
 * stdout on exit 0, undefined otherwise. Never throws.
 */
function runGitAsync(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let bytes = 0

    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      finish(undefined)
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(undefined)
    }, GIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > GIT_MAX_BUFFER) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish(undefined)
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return finish(undefined)
      const trimmed = stdout.trim()
      finish(trimmed.length > 0 ? trimmed : undefined)
    })
  })
}

/**
 * Normalize a git remote URL to `host/org/repo`, stripping credentials and `.git` suffix.
 */
export function normalizeRemoteUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let s = raw.trim()
  if (!s) return undefined

  // SSH shorthand: git@host:org/repo(.git)
  const sshShort = /^[^@\s:]+@([^:\s]+):(.+?)(?:\.git)?$/.exec(s)
  if (sshShort) {
    return `${sshShort[1]}/${sshShort[2]}`.replace(/\.git$/, '')
  }

  // URL-ish: strip scheme + userinfo
  s = s.replace(/^[a-zA-Z]+:\/\//, '')
  s = s.replace(/^[^@/]+@/, '') // strip userinfo
  s = s.replace(/\.git$/, '')
  return s || undefined
}

// Require a lowercase letter in the issue slug to avoid false positives like
// HTTP-2, UTF-8, PR-123. Linear keys are typically UPPER but we scope tighter:
// prefix must be 2-8 uppercase letters and must not be a common acronym.
const LINEAR_RE = /\b([A-Z]{2,8}-\d{1,6})\b/

export function extractLinearIssue(params: {
  branch?: string
  commitSubject?: string
}): string | undefined {
  const { branch, commitSubject } = params
  const sources = [branch, commitSubject].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  for (const src of sources) {
    const m = LINEAR_RE.exec(src)
    if (m) return m[1]
  }
  return undefined
}

export type HarvestOptions = {
  sessionId?: string
}

/**
 * Resolve fresh context, bypassing cache. Runs all git probes in parallel.
 */
export async function harvestContextNow(
  opts: HarvestOptions = {},
): Promise<HarvestedContext> {
  const ctx: HarvestedContext = {}

  try {
    ctx[Attr.CWD] = process.cwd()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.HOST_NAME] = os.hostname()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.OS_TYPE] = os.type()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.PROCESS_PID] = process.pid
  } catch {
    /* ignore */
  }

  const [
    userEmail,
    userName,
    insideRepo,
    repoRaw,
    branch,
    commit,
    worktree,
    status,
    commitSubject,
  ] = await Promise.all([
    runGitAsync(['config', 'user.email']),
    runGitAsync(['config', 'user.name']),
    runGitAsync(['rev-parse', '--is-inside-work-tree']),
    runGitAsync(['remote', 'get-url', 'origin']),
    runGitAsync(['rev-parse', '--abbrev-ref', 'HEAD']),
    runGitAsync(['rev-parse', 'HEAD']),
    runGitAsync(['rev-parse', '--show-toplevel']),
    runGitAsync(['status', '--porcelain']),
    runGitAsync(['log', '-1', '--pretty=%s']),
  ])

  if (userEmail) ctx[Attr.USER_EMAIL] = userEmail
  if (userName) ctx[Attr.USER_NAME] = userName

  if (insideRepo === 'true') {
    const repo = normalizeRemoteUrl(repoRaw)
    if (repo) ctx[Attr.GIT_REPO] = repo
    if (branch) ctx[Attr.GIT_BRANCH] = branch
    if (commit) ctx[Attr.GIT_COMMIT] = commit
    if (worktree) ctx[Attr.GIT_WORKTREE] = worktree
    ctx[Attr.GIT_DIRTY] = Boolean(status && status.length > 0)
    const linear = extractLinearIssue({ branch, commitSubject })
    if (linear) ctx[Attr.LINEAR_ISSUE] = linear
  }

  if (opts.sessionId) ctx[Attr.SESSION_ID] = opts.sessionId

  return ctx
}

// Synchronous cheap attrs always available even before the first git probe.
function syncCheapAttrs(sessionId?: string): HarvestedContext {
  const ctx: HarvestedContext = {}
  try {
    ctx[Attr.CWD] = process.cwd()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.HOST_NAME] = os.hostname()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.OS_TYPE] = os.type()
  } catch {
    /* ignore */
  }
  try {
    ctx[Attr.PROCESS_PID] = process.pid
  } catch {
    /* ignore */
  }
  if (sessionId) ctx[Attr.SESSION_ID] = sessionId
  return ctx
}

// Kick off a background refresh if one isn't already running; dedup via
// `inflight`. Returns the promise so awaiters can join it.
function ensureInflight(): Promise<HarvestedContext> {
  if (!inflight) {
    inflight = harvestContextNow({})
      .then((fresh) => {
        cache = { at: Date.now(), value: fresh }
        return fresh
      })
      .catch(() => ({}) as HarvestedContext)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/**
 * Return cached context if warm; otherwise kick off a refresh in the background
 * and return the stale value (or sync fallback) immediately. Session id is
 * applied per-call.
 *
 * This is the synchronous-feeling API used by non-async hot paths. If you can
 * afford to await the first-prompt fetch, prefer `harvestContextAwait()` so
 * cold-start spans aren't missing git context.
 */
export function harvestContext(opts: HarvestOptions = {}): HarvestedContext {
  const now = Date.now()
  const sessionId = opts.sessionId

  // Cache hot → return it.
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return sessionId
      ? { ...cache.value, [Attr.SESSION_ID]: sessionId }
      : cache.value
  }

  // Cache cold/stale → schedule background refresh (dedup via `inflight`).
  void ensureInflight()

  // If we have any stale cache, return it immediately rather than the bare fallback.
  if (cache) {
    return sessionId
      ? { ...cache.value, [Attr.SESSION_ID]: sessionId }
      : cache.value
  }
  return syncCheapAttrs(sessionId)
}

/**
 * Async variant: if the cache is completely cold (never populated), await the
 * inflight refresh so the caller sees the full git context. If the cache has
 * any value (even stale), returns immediately with the stale value and kicks
 * off a background refresh. Safe: the awaited promise never rejects and is
 * bounded by `GIT_TIMEOUT_MS` per git probe.
 *
 * Use this from async call sites like the root prompt span so the very first
 * prompt of a session includes git/project context.
 */
export async function harvestContextAwait(
  opts: HarvestOptions = {},
): Promise<HarvestedContext> {
  const now = Date.now()
  const sessionId = opts.sessionId

  // Cache hot → return it.
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return sessionId
      ? { ...cache.value, [Attr.SESSION_ID]: sessionId }
      : cache.value
  }

  // Cache cold/stale → kick off (or join) refresh.
  const pending = ensureInflight()

  // Stale cache present: return it immediately without awaiting.
  if (cache) {
    return sessionId
      ? { ...cache.value, [Attr.SESSION_ID]: sessionId }
      : cache.value
  }

  // Cold cache: await the refresh so we return with full context.
  try {
    const fresh = await pending
    return sessionId ? { ...fresh, [Attr.SESSION_ID]: sessionId } : fresh
  } catch {
    return syncCheapAttrs(sessionId)
  }
}

/**
 * Eagerly prime the cache. Call at CLI startup so the first user prompt has
 * the full git context available.
 */
export async function primeHarvestCache(): Promise<void> {
  try {
    const fresh = await harvestContextNow({})
    cache = { at: Date.now(), value: fresh }
  } catch {
    /* ignore */
  }
}

/** Test-only: clear the cache. */
export function __resetHarvestCache(): void {
  cache = null
  inflight = null
}
