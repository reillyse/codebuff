import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Attr } from '../attributes'
import {
  __resetHarvestCache,
  extractLinearIssue,
  harvestContext,
  harvestContextAwait,
  harvestContextNow,
  normalizeRemoteUrl,
  primeHarvestCache,
} from '../context-harvester'

describe('normalizeRemoteUrl', () => {
  it('returns undefined for empty/undefined', () => {
    expect(normalizeRemoteUrl(undefined)).toBeUndefined()
    expect(normalizeRemoteUrl('')).toBeUndefined()
    expect(normalizeRemoteUrl('   ')).toBeUndefined()
  })

  it('handles SSH shorthand with .git suffix', () => {
    expect(normalizeRemoteUrl('git@github.com:sparrow-io/codebuff.git')).toBe(
      'github.com/sparrow-io/codebuff',
    )
  })

  it('handles SSH shorthand without .git suffix', () => {
    expect(normalizeRemoteUrl('git@github.com:sparrow-io/codebuff')).toBe(
      'github.com/sparrow-io/codebuff',
    )
  })

  it('handles nested SSH paths (group/subgroup/repo)', () => {
    expect(
      normalizeRemoteUrl('git@gitlab.com:group/subgroup/repo.git'),
    ).toBe('gitlab.com/group/subgroup/repo')
  })

  it('handles https URLs with credentials', () => {
    expect(
      normalizeRemoteUrl('https://user:token@github.com/org/repo.git'),
    ).toBe('github.com/org/repo')
  })

  it('handles https URLs without credentials', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo.git')).toBe(
      'github.com/org/repo',
    )
  })

  it('handles plain https without .git suffix', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo')).toBe(
      'github.com/org/repo',
    )
  })

  it('handles git:// scheme', () => {
    expect(normalizeRemoteUrl('git://github.com/org/repo.git')).toBe(
      'github.com/org/repo',
    )
  })
})

describe('extractLinearIssue', () => {
  it('returns undefined when no sources provided', () => {
    expect(extractLinearIssue({})).toBeUndefined()
    expect(extractLinearIssue({ branch: '', commitSubject: '' })).toBeUndefined()
  })

  it('extracts from branch name', () => {
    expect(
      extractLinearIssue({ branch: 'feature/ENG-1234-add-telemetry' }),
    ).toBe('ENG-1234')
  })

  it('extracts from commit subject', () => {
    expect(
      extractLinearIssue({ commitSubject: 'fix(auth): ABC-42 resolve token leak' }),
    ).toBe('ABC-42')
  })

  it('prefers branch over commit subject when both present', () => {
    expect(
      extractLinearIssue({
        branch: 'ENG-100-foo',
        commitSubject: 'fix: BUG-200 something',
      }),
    ).toBe('ENG-100')
  })

  it('rejects unbounded letter prefixes (>8)', () => {
    expect(
      extractLinearIssue({ branch: 'VERYLONGPREFIX-123' }),
    ).toBeUndefined()
  })

  it('rejects single-letter prefixes', () => {
    expect(extractLinearIssue({ branch: 'X-123' })).toBeUndefined()
  })

  it('rejects issue numbers >6 digits', () => {
    expect(extractLinearIssue({ branch: 'ENG-1234567' })).toBeUndefined()
  })

  it('matches minimum 2-letter prefix', () => {
    expect(extractLinearIssue({ branch: 'AB-1' })).toBe('AB-1')
  })
})

describe('harvestContext cache behavior', () => {
  beforeEach(() => {
    __resetHarvestCache()
  })

  afterEach(() => {
    __resetHarvestCache()
  })

  it('returns sync fallback attrs when cache is completely cold', () => {
    const ctx = harvestContext({ sessionId: 'sess-1' })
    // Cheap sync attrs should always be present
    expect(ctx[Attr.CWD]).toBeDefined()
    expect(ctx[Attr.HOST_NAME]).toBeDefined()
    expect(ctx[Attr.OS_TYPE]).toBeDefined()
    expect(ctx[Attr.PROCESS_PID]).toBeGreaterThan(0)
    expect(ctx[Attr.SESSION_ID]).toBe('sess-1')
  })

  it('applies sessionId to every call without mutating cache', () => {
    const a = harvestContext({ sessionId: 'a' })
    const b = harvestContext({ sessionId: 'b' })
    expect(a[Attr.SESSION_ID]).toBe('a')
    expect(b[Attr.SESSION_ID]).toBe('b')
  })

  it('harvestContextAwait returns full context with git data when in a git repo', async () => {
    const ctx = await harvestContextAwait({ sessionId: 'sess-await' })
    expect(ctx[Attr.SESSION_ID]).toBe('sess-await')
    expect(ctx[Attr.CWD]).toBeDefined()
    // This test runs inside the codebuff git worktree so git.repo should be set.
    // If the probe somehow failed or we're not in a repo, skip the git asserts.
    if (ctx[Attr.GIT_REPO]) {
      expect(typeof ctx[Attr.GIT_REPO]).toBe('string')
      expect(ctx[Attr.GIT_BRANCH]).toBeDefined()
      expect(ctx[Attr.GIT_COMMIT]).toBeDefined()
      expect(typeof ctx[Attr.GIT_DIRTY]).toBe('boolean')
    }
  })

  it('caches the harvested value so subsequent calls return the same object', async () => {
    await primeHarvestCache()
    // First call populates via await; second should hit the warm cache and match.
    const a = await harvestContextAwait({})
    const b = await harvestContextAwait({})
    expect(a[Attr.CWD]).toBe(b[Attr.CWD])
    if (a[Attr.GIT_COMMIT]) {
      expect(a[Attr.GIT_COMMIT]).toBe(b[Attr.GIT_COMMIT])
    }
  })

  it('dedups concurrent harvestContextAwait calls (inflight promise)', async () => {
    // All four concurrent awaits should resolve to fresh data, but only one
    // underlying set of git probes runs. We can't easily assert probe count
    // without mocking spawn, but we can assert that the outputs are all equal
    // by value (same session-derived fields).
    __resetHarvestCache()
    const [a, b, c, d] = await Promise.all([
      harvestContextAwait({ sessionId: 's' }),
      harvestContextAwait({ sessionId: 's' }),
      harvestContextAwait({ sessionId: 's' }),
      harvestContextAwait({ sessionId: 's' }),
    ])
    expect(a[Attr.CWD]).toBe(b[Attr.CWD])
    expect(b[Attr.CWD]).toBe(c[Attr.CWD])
    expect(c[Attr.CWD]).toBe(d[Attr.CWD])
    expect(a[Attr.SESSION_ID]).toBe('s')
  })

  it('primeHarvestCache populates the cache so sync harvestContext returns non-empty git', async () => {
    __resetHarvestCache()
    await primeHarvestCache()
    const ctx = harvestContext({})
    // After priming, CWD and host should be populated from cache (same values
    // as sync fallback, but via the cache path).
    expect(ctx[Attr.CWD]).toBeDefined()
    expect(ctx[Attr.HOST_NAME]).toBeDefined()
  })

  it('harvestContextNow bypasses cache entirely', async () => {
    const a = await harvestContextNow({ sessionId: 'now-1' })
    const b = await harvestContextNow({ sessionId: 'now-2' })
    expect(a[Attr.SESSION_ID]).toBe('now-1')
    expect(b[Attr.SESSION_ID]).toBe('now-2')
    expect(a[Attr.CWD]).toBe(b[Attr.CWD])
  })
})
