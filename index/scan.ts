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
  repoUrl?: string
  dims?: Record<'health' | 'reliability' | 'security' | 'cost', { score: number; confidence: string }>
  topFindings?: Array<{ id: string; severity: string }>
  daysSinceLastCommit?: number
}

export interface IndexStats {
  total: number; scored: number; failed: number; insufficient: number
  // V2: count of repos classified as library/SDK/proxy/stub (the correct
  // terminal outcome, not a withhold) — tracked separately from `insufficient`.
  notServer: number
  gradeDist: Record<string, number>
  avgOverall: number
  staleOver180: number
  secretsFindings: number
  deprecated: number
  shellExecTools: number
}

export function summarize(entries: IndexEntry[]): IndexStats {
  const scoredOk = entries.filter(e => e.ok)
  const graded = scoredOk.filter(e => !e.insufficientData && !e.notServer && typeof e.overall === 'number')
  const gradeDist: Record<string, number> = {}
  for (const g of graded) {
    const letter = (g.grade ?? '').replace(/[+-]$/, '')
    if (letter) gradeDist[letter] = (gradeDist[letter] ?? 0) + 1
  }
  const has = (e: IndexEntry, id: string) => (e.topFindings ?? []).some(f => f.id === id)
  return {
    total: entries.length,
    scored: scoredOk.length,
    failed: entries.length - scoredOk.length,
    insufficient: scoredOk.filter(e => e.insufficientData).length,
    notServer: scoredOk.filter(e => e.notServer).length,
    gradeDist,
    avgOverall: graded.length === 0 ? 0 : Math.round(graded.reduce((a, e) => a + (e.overall ?? 0), 0) / graded.length),
    staleOver180: scoredOk.filter(e => (e.daysSinceLastCommit ?? 0) > 180).length,
    secretsFindings: scoredOk.filter(e => has(e, 'security/committed-secret')).length,
    deprecated: scoredOk.filter(e => has(e, 'health/deprecated-package')).length,
    shellExecTools: scoredOk.filter(e => has(e, 'security/shell-exec-tool')).length,
  }
}

function toEntry(ref: string, card: Scorecard, daysSinceLastCommit?: number): IndexEntry {
  const dims = Object.fromEntries(card.dimensions.map(d => [d.id, { score: d.score, confidence: d.confidence }])) as IndexEntry['dims']
  const findings = card.dimensions.flatMap(d => d.findings)
    .sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity))
    .slice(0, 3).map(f => ({ id: f.id, severity: f.severity }))
  return {
    ref, ok: true, overall: card.overall, grade: card.grade,
    insufficientData: card.insufficientData || undefined,
    notServer: card.notServer || undefined,
    notServerReason: card.notServer ? card.notServerReason : undefined,
    repoUrl: card.resolved?.repo ? `https://github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}` : undefined,
    dims, topFindings: findings.length > 0 ? findings : undefined,
    daysSinceLastCommit,
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
