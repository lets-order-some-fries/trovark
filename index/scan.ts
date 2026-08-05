// Batch-score discovered servers → results.json (compact cards + first-party stats)
import { readFileSync, writeFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'
import { resolve } from '../src/resolver.js'
import { assemble } from '../src/assemble.js'
import { score } from '../src/scoring/score.js'
import { RUBRIC_VERSION } from '../src/scoring/rubric.js'
import type { Scorecard } from '../src/types.js'

export interface IndexEntry {
  ref: string
  ok: boolean
  error?: string
  overall?: number
  grade?: string
  insufficientData?: boolean
  // V2: distinct from insufficientData — a library/SDK/proxy/stub repo with
  // no tools to grade, not a server we failed to check. See src/derive/classify.ts.
  notServer?: boolean
  notServerReason?: string
  // W1: distinct from both notServer and insufficientData — the GitHub repo
  // 404s (deleted/renamed/never existed), so there was never anything to
  // grade. See src/collectors/github.ts's RepoNotFoundError.
  unresolved?: boolean
  repoUrl?: string
  dims?: Record<'health' | 'reliability' | 'security' | 'cost', { score: number; confidence: string }>
  topFindings?: Array<{ id: string; severity: string }>
  daysSinceLastCommit?: number
  // D1 (integrity-v1): undefined when not checked (no files fetched) — same
  // absence != clean discipline as Scorecard.integrityHits. Stats (below)
  // are deliberately left untouched for now; this is a per-entry count only.
  integrity?: { payloads: number; observations: number }
}

export interface IndexStats {
  total: number; scored: number; failed: number; insufficient: number
  // V2: count of repos classified as library/SDK/proxy/stub (the correct
  // terminal outcome, not a withhold) — tracked separately from `insufficient`.
  // W6: EXCLUDES notServerReason==='dynamic' — a dynamic-surface server is
  // NOT a library, it's a real server with an unknowable static surface, so
  // it must not inflate the "library / not a server" tile. See `dynamic`
  // below.
  notServer: number
  // W6 (coverage-v1.5, Task W6 Part B): repos whose tool surface is built at
  // runtime from upstream servers/a DB (src/derive/dynamic.ts) — a THIRD
  // distinct terminal state, alongside notServer ("library, nothing to
  // grade") and unresolved ("repo doesn't exist"). Also excluded from
  // gradeDist/avgOverall/staleOver180/secretsFindings/shellExecTools (same
  // `!e.notServer` filters already cover it, since dynamic entries still set
  // IndexEntry.notServer=true — see toEntry below).
  dynamic: number
  // W1: repos GitHub 404s (deleted/renamed/never existed) — never graded,
  // never counted in gradeDist/avgOverall/staleOver180/secretsFindings/
  // shellExecTools (see summarize() below).
  unresolved: number
  gradeDist: Record<string, number>
  avgOverall: number
  staleOver180: number
  secretsFindings: number
  deprecated: number
  shellExecTools: number
}

export function summarize(entries: IndexEntry[]): IndexStats {
  const scoredOk = entries.filter(e => e.ok)
  // W1: excluded defense-in-depth (not just via `typeof e.overall ===
  // 'number'`) — a repo GitHub 404s must never be counted as graded, even if
  // a stale/malformed entry somehow still carried a numeric overall/grade.
  const graded = scoredOk.filter(e => !e.insufficientData && !e.notServer && !e.unresolved && typeof e.overall === 'number')
  const gradeDist: Record<string, number> = {}
  for (const g of graded) {
    const letter = (g.grade ?? '').replace(/[+-]$/, '')
    if (letter) gradeDist[letter] = (gradeDist[letter] ?? 0) + 1
  }
  const has = (e: IndexEntry, id: string) => (e.topFindings ?? []).some(f => f.id === id)
  // M14: notServer entries (library/SDK/proxy/stub — not real servers you
  // should worry about) are already excluded from gradeDist/avgOverall
  // above; staleOver180/secretsFindings/shellExecTools must be consistent —
  // a library that happens to be stale, or whose own API-definition code
  // reads as "exec"-shaped, shouldn't inflate the site's headline tiles.
  // W1: unresolved entries (repo 404s) get the same treatment — there is no
  // real signal behind them at all.
  const nonLibrary = scoredOk.filter(e => !e.notServer && !e.unresolved)
  return {
    total: entries.length,
    scored: scoredOk.length,
    failed: entries.length - scoredOk.length,
    insufficient: scoredOk.filter(e => e.insufficientData).length,
    // W6: notServer excludes the dynamic-reason subset (tracked separately
    // below) so the "library / not a server" tile never counts a real,
    // just-unanalyzable-statically server as a library.
    notServer: scoredOk.filter(e => e.notServer && e.notServerReason !== 'dynamic').length,
    dynamic: scoredOk.filter(e => e.notServerReason === 'dynamic').length,
    unresolved: scoredOk.filter(e => e.unresolved).length,
    gradeDist,
    avgOverall: graded.length === 0 ? 0 : Math.round(graded.reduce((a, e) => a + (e.overall ?? 0), 0) / graded.length),
    staleOver180: nonLibrary.filter(e => (e.daysSinceLastCommit ?? 0) > 180).length,
    secretsFindings: nonLibrary.filter(e => has(e, 'security/committed-secret')).length,
    deprecated: scoredOk.filter(e => has(e, 'health/deprecated-package')).length,
    shellExecTools: nonLibrary.filter(e => has(e, 'security/shell-exec-tool')).length,
  }
}

function toEntry(ref: string, card: Scorecard, daysSinceLastCommit?: number): IndexEntry {
  const dims = Object.fromEntries(card.dimensions.map(d => [d.id, { score: d.score, confidence: d.confidence }])) as IndexEntry['dims']
  const findings = card.dimensions.flatMap(d => d.findings)
    .sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity))
    .slice(0, 3).map(f => ({ id: f.id, severity: f.severity }))
  return {
    // I9: card.overall/grade are null for notServer cards — IndexEntry keeps
    // them optional (number|undefined), so convert null -> undefined here.
    ref, ok: true, overall: card.overall ?? undefined, grade: card.grade ?? undefined,
    insufficientData: card.insufficientData || undefined,
    notServer: card.notServer || undefined,
    notServerReason: card.notServer ? card.notServerReason : undefined,
    unresolved: card.unresolved || undefined,
    repoUrl: card.resolved?.repo ? `https://github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}` : undefined,
    dims, topFindings: findings.length > 0 ? findings : undefined,
    daysSinceLastCommit,
    integrity: card.integrityHits ? {
      payloads: card.integrityHits.filter(h => h.kind === 'hidden-payload').length,
      observations: card.integrityHits.filter(h => h.kind !== 'hidden-payload').length,
    } : undefined,
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main(): Promise<void> {
  const inFile = arg('--in', 'index/servers.json')
  const outFile = arg('--out', 'index/results.json')
  const limit = Number(arg('--limit', '0'))
  const concurrency = Number(arg('--concurrency', '4'))
  const hasToken = Boolean(process.env.GITHUB_TOKEN)
  const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })
  const now = new Date()

  let refs: string[] = (JSON.parse(readFileSync(inFile, 'utf8')) as { refs: string[] }).refs
  if (limit > 0) refs = refs.slice(0, limit)

  let done = 0
  const entries = await pool(refs, concurrency, async (ref): Promise<IndexEntry> => {
    try {
      const identity = await resolve(ref, http)
      const signals = await assemble(identity, http, now, { hasToken })
      const card = score(ref, signals, now.toISOString(), {
        ...(identity.npmPackage ? { npmPackage: identity.npmPackage } : {}),
        ...(identity.pypiPackage ? { pypiPackage: identity.pypiPackage } : {}),
        ...(identity.repo ? { repo: identity.repo } : {}),
      })
      return toEntry(ref, card, signals.daysSinceLastCommit)
    } catch (err) {
      return { ref, ok: false, error: (err as Error).message }
    } finally {
      done++
      if (done % 10 === 0 || done === refs.length) console.error(`scanned ${done}/${refs.length}`)
    }
  })

  entries.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    if ((b.overall ?? -1) !== (a.overall ?? -1)) return (b.overall ?? -1) - (a.overall ?? -1)
    return a.ref.localeCompare(b.ref)
  })

  const payload = { generatedAt: now.toISOString(), rubricVersion: RUBRIC_VERSION, stats: summarize(entries), entries }
  writeFileSync(outFile, JSON.stringify(payload, null, 2))
  console.error(`wrote ${outFile}: ${payload.stats.scored}/${payload.stats.total} scored, avg ${payload.stats.avgOverall}`)
}

if (process.argv[1]?.endsWith('scan.ts')) await main()
