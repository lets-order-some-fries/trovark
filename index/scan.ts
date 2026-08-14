// Batch-score discovered servers → results.json (compact cards + first-party stats)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHttp } from '../src/util/http.js'
import { resolve } from '../src/resolver.js'
import { assemble } from '../src/assemble.js'
import { score } from '../src/scoring/score.js'
import { RUBRIC_VERSION } from '../src/scoring/rubric.js'
import { buildSurfaceSnapshot, diffSurfaces } from '../src/derive/surface.js'
import type { DriftEvent, SurfaceSource } from '../src/derive/surface.js'
import { appendDriftEvents, loadSnapshot, saveSnapshot } from './surfaceStore.js'
import type { Scorecard, ToolInfo } from '../src/types.js'

export interface IndexEntry {
  ref: string
  ok: boolean
  error?: string
  // W6 (false-published-claim fix): ABSENT (not 0, not a stale number) for
  // every withheld terminal state — insufficientData, notServer and
  // unresolved alike. Scorecard.overall/.grade are null for all three (see
  // src/scoring/score.ts's single `withheld` computation) and toEntry below
  // converts null -> undefined, which JSON.stringify omits. Before the fix,
  // insufficientData entries still published a numeric overall and a letter
  // grade here — 29 of 29 in the committed index, several "A" — so a machine
  // consumer of the public dataset read a confident grade for a server we had
  // explicitly declined to assess. summarize() already filtered these out of
  // gradeDist/avgOverall, so no published statistic moves.
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
  // W6 (fabricated-dimension-value fix): `score` is null when the dimension
  // had no measurement (zero collectible signals, or — for security — an
  // absent primary tool-surface signal). Null must survive into
  // index/results.json as null: coercing it to 0 would publish the worst
  // possible score as a measurement. No aggregate in summarize() consumes
  // dimension scores; if one is ever added it must skip nulls, not default
  // them. See src/types.ts DimensionScore.
  dims?: Record<'health' | 'reliability' | 'security' | 'cost', { score: number | null; confidence: string }>
  topFindings?: Array<{ id: string; severity: string }>
  daysSinceLastCommit?: number
  // W6 review remediation item M2: structured passthrough of
  // Scorecard.readmeSourced — a README-sourced tool surface is a
  // maintainer's CLAIM, not verified extraction. See src/types.ts for the
  // full rationale. Omitted (not false) when never computed.
  readmeSourced?: boolean
  // D1 (integrity-v1): undefined when not checked (no files fetched) — same
  // absence != clean discipline as Scorecard.integrityHits. Stats (below)
  // are deliberately left untouched for now; this is a per-entry count only.
  integrity?: { payloads: number; observations: number }
  // Secondary-rate-limit postmortem (2026-08-13): count of collector errors
  // absorbed into Signals.errors for this entry. A degraded entry looks
  // healthy (ok: true) by design; this field is how the outage gate and any
  // downstream consumer can tell "measured and withheld" from "never read".
  // Omitted when zero.
  collectorErrors?: number
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
  // D2 (observatory): drift events recorded by THIS run only — an artifact
  // count, not a quality statistic. Absent from summarize() (which is pure
  // over entries); main() sets it from recordSurfaces' return.
  driftEvents?: number
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

// Exported (was module-private) so tests/scan.test.ts can assert the
// Scorecard -> IndexEntry passthrough directly (W6 review remediation item
// M2 — readmeSourced threading) without going through the network-dependent
// main() pipeline.
export function toEntry(ref: string, card: Scorecard, daysSinceLastCommit?: number, collectorErrors?: number): IndexEntry {
  const dims = Object.fromEntries(card.dimensions.map(d => [d.id, { score: d.score, confidence: d.confidence }])) as IndexEntry['dims']
  const findings = card.dimensions.flatMap(d => d.findings)
    .sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity))
    .slice(0, 3).map(f => ({ id: f.id, severity: f.severity }))
  return {
    // Secondary-rate-limit postmortem (2026-08-13): a gracefully-degraded
    // entry (collector errors absorbed into Signals.errors) used to be
    // indistinguishable from a healthy one in the published data — a scan
    // run during a GitHub SECONDARY rate-limit outage reported
    // collectorFailures: 0, coverage complete, while 242 servers silently
    // drained into withheld. Non-zero only when collectors errored.
    ...(collectorErrors ? { collectorErrors } : {}),
    // I9/W1/W6: card.overall/grade are null for EVERY withheld card
    // (notServer, unresolved, insufficientData) — IndexEntry keeps them
    // optional (number|undefined), so convert null -> undefined here, which
    // JSON.stringify then omits from results.json entirely.
    ref, ok: true, overall: card.overall ?? undefined, grade: card.grade ?? undefined,
    insufficientData: card.insufficientData || undefined,
    notServer: card.notServer || undefined,
    notServerReason: card.notServer ? card.notServerReason : undefined,
    unresolved: card.unresolved || undefined,
    repoUrl: card.resolved?.repo ? `https://github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}` : undefined,
    dims, topFindings: findings.length > 0 ? findings : undefined,
    daysSinceLastCommit,
    readmeSourced: card.readmeSourced || undefined,
    integrity: card.integrityHits ? {
      payloads: card.integrityHits.filter(h => h.kind === 'hidden-payload').length,
      observations: card.integrityHits.filter(h => h.kind !== 'hidden-payload').length,
    } : undefined,
  }
}

// D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md):
// pure-ish helper (all I/O confined to dir) so it is testable without a
// network scan. Called once per run, after the pool completes AND after the
// coverage/outage gates pass — a refused scan never writes snapshots either.
// A server absent from `extracted` keeps its old snapshot and produces NO
// event (missing snapshot != removal); diffs across differing
// extractorVersion/source are suppressed by diffSurfaces, never rendered.
export function recordSurfaces(
  surfacesDir: string,
  extracted: Array<{ ref: string; tools: ToolInfo[]; source: SurfaceSource }>,
  scannedAt: string, rubricVersion: string,
): { written: number; events: number; suppressed: number } {
  const events: DriftEvent[] = []
  let suppressed = 0
  for (const { ref, tools, source } of extracted) {
    const next = buildSurfaceSnapshot(ref, tools, scannedAt, rubricVersion, source)
    const prev = loadSnapshot(surfacesDir, ref)
    if (prev) {
      const d = diffSurfaces(prev, next)
      if (d.kind === 'event') events.push(d)
      else if (d.kind === 'suppressed') suppressed++
    }
    saveSnapshot(surfacesDir, next)
  }
  if (events.length || !existsSync(join(surfacesDir, '..', 'drift.json'))) {
    appendDriftEvents(join(surfacesDir, '..', 'drift.json'), events)
  }
  return { written: extracted.length, events: events.length, suppressed }
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
  // D2: surface inputs collected during the scan, snapshotted only after the
  // coverage/outage gates pass. Gated on notServer/unresolved so a library or
  // a 404'd repo never records a "tool surface".
  const surfaceInputs: Array<{ ref: string; tools: ToolInfo[]; source: SurfaceSource }> = []
  const entries = await pool(refs, concurrency, async (ref): Promise<IndexEntry> => {
    try {
      const identity = await resolve(ref, http)
      const signals = await assemble(identity, http, now, { hasToken })
      if (signals.tools && signals.toolSource && !signals.notServer && !signals.unresolved) {
        surfaceInputs.push({ ref, tools: signals.tools, source: signals.toolSource })
      }
      const card = score(ref, signals, now.toISOString(), {
        ...(identity.npmPackage ? { npmPackage: identity.npmPackage } : {}),
        ...(identity.pypiPackage ? { pypiPackage: identity.pypiPackage } : {}),
        ...(identity.repo ? { repo: identity.repo } : {}),
      })
      return toEntry(ref, card, signals.daysSinceLastCommit, signals.errors.length)
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

  // Fault hunt 2026-08-08 (C7): the index write used to be all-or-nothing
  // with no completeness gate, so a run that DIED partway wrote nothing at
  // all — leaving the previous results.json in place, which diffs as a clean
  // "zero changes" run. That is not a hypothetical: a 400-server scan exited
  // at 150/400 on an unsettled fetch and the stale file read as a successful
  // no-change result. A second run, starved by the GitHub rate limit,
  // reported graded 321->94 as though it were a code regression.
  //
  // `coverage` makes the shape of the run part of the artifact, so a
  // consumer can never mistake a partial run for a complete one. The two
  // failure modes above are now separable: `completed < attempted` means the
  // run did not finish; a spike in `collectorFailures` means it ran but
  // could not read the servers.
  const collectorFailures = entries.filter(e => !e.ok).length
  // Secondary-rate-limit postmortem (2026-08-13): thrown failures are only
  // half the outage signature — GitHub's secondary limit 403s degrade
  // GRACEFULLY into ok:true entries with empty signals (the whole point of
  // graceful degradation), so a scan can be mostly noise while reporting
  // zero failures. Count entries whose collectors recorded errors as well.
  const degradedEntries = entries.filter(e => (e as { collectorErrors?: number }).collectorErrors).length
  const coverage = {
    attempted: refs.length,
    completed: entries.length,
    collectorFailures,
    degradedEntries,
    complete: entries.length === refs.length,
  }
  if (!coverage.complete) {
    console.error(`REFUSING TO WRITE ${outFile}: only ${entries.length}/${refs.length} refs completed.`)
    console.error('A partial index would be indistinguishable from a clean scan. Re-run when the source is healthy.')
    process.exitCode = 1
    return
  }
  // A run that "completed" every ref but failed to collect most of them is
  // an outage, not a measurement of the ecosystem. Publishing it would move
  // hundreds of servers into withheld and read as a product regression.
  const failureRate = (collectorFailures + degradedEntries) / Math.max(1, refs.length)
  if (failureRate > 0.25 && !process.argv.includes('--allow-degraded')) {
    console.error(`REFUSING TO WRITE ${outFile}: ${collectorFailures} failed + ${degradedEntries} degraded of ${refs.length} refs (${Math.round(failureRate * 100)}%).`)
    console.error('This is an outage signature (rate limit or network), not a change in the servers. Pass --allow-degraded to override.')
    process.exitCode = 1
    return
  }

  // D2: snapshots + drift are written ONLY here, after both gates above have
  // passed — a refused scan (partial run or outage signature) writes neither
  // the index nor any surface state, so bad runs can't manufacture drift.
  const surf = recordSurfaces(join(dirname(outFile), 'surfaces'), surfaceInputs, now.toISOString(), RUBRIC_VERSION)
  console.error(`surfaces: ${surf.written} written, ${surf.events} drift events, ${surf.suppressed} suppressed`)

  const payload = { generatedAt: now.toISOString(), rubricVersion: RUBRIC_VERSION, coverage, stats: { ...summarize(entries), driftEvents: surf.events }, entries }
  writeFileSync(outFile, JSON.stringify(payload, null, 2))
  console.error(`wrote ${outFile}: ${payload.stats.scored}/${payload.stats.total} scored, avg ${payload.stats.avgOverall}`)
}

if (process.argv[1]?.endsWith('scan.ts')) {
  // The scan can only end two ways now: it writes an index, or it says why
  // it did not. Silent death — the mode that produced two false measurements
  // — is no longer one of them.
  let finished = false
  process.on('exit', code => {
    if (!finished && code === 0) {
      console.error('SCAN DID NOT COMPLETE: the process exited before the index was written, and nothing was changed on disk.')
      console.error('Do NOT read the existing index as a result of this run.')
      process.exitCode = 1
    }
  })
  await main()
  finished = true
}
