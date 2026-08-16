import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordSurfaces, summarize, toEntry, type IndexEntry } from '../index/scan.js'
import type { Scorecard } from '../src/types.js'

const e = (over: Partial<IndexEntry>): IndexEntry => ({ ref: 'a/b', ok: true, ...over })

describe('summarize', () => {
  it('computes counts, grade distribution and average', () => {
    const entries: IndexEntry[] = [
      e({ ref: 'a/one', overall: 96, grade: 'A+', dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
      e({ ref: 'a/two', overall: 61, grade: 'C', daysSinceLastCommit: 200, topFindings: [{ id: 'security/committed-secret', severity: 'high' }], dims: { health: { score: 30, confidence: 'high' }, reliability: { score: 70, confidence: 'high' }, security: { score: 40, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
      e({ ref: 'a/three', overall: 100, grade: 'A+', insufficientData: true }),
      { ref: 'a/four', ok: false, error: 'boom' },
    ]
    const s = summarize(entries)
    expect(s.total).toBe(4)
    expect(s.scored).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.insufficient).toBe(1)
    expect(s.gradeDist).toEqual({ A: 1, C: 1 })      // insufficient + failed excluded
    expect(s.avgOverall).toBe(Math.round((96 + 61) / 2))
    expect(s.staleOver180).toBe(1)                    // daysSinceLastCommit 200 > 180 (real staleness, not health score)
    expect(s.secretsFindings).toBe(1)
    expect(s.deprecated).toBe(0)
    expect(s.shellExecTools).toBe(0)
    expect(s.notServer).toBe(0)
  })
  it('counts notServer separately from insufficientData (V2), and excludes it from gradeDist/avgOverall even when scored', () => {
    const entries: IndexEntry[] = [
      // A library/SDK entry CAN carry a real score (schema extraction still ran) —
      // it must still be excluded from site-stats tiles, not just from the count.
      e({ ref: 'a/lib', notServer: true, notServerReason: 'sdk', overall: 78, grade: 'B+' }),
      e({ ref: 'a/withheld', insufficientData: true }),
    ]
    const s = summarize(entries)
    expect(s.notServer).toBe(1)
    expect(s.insufficient).toBe(1)
    expect(s.gradeDist).toEqual({})   // the notServer entry's B+ must not appear here
    expect(s.avgOverall).toBe(0)      // ...nor pull avgOverall away from 0 (no graded entries)
  })
  // M14: shellExecTools/staleOver180/secretsFindings still counted notServer
  // entries — a library/SDK repo that happens to be stale or carries an
  // "exec"-shaped findings from its own API-definition code shouldn't
  // pollute the "real servers you should worry about" tiles, consistent
  // with gradeDist/avgOverall already excluding notServer above.
  it('M14: excludes notServer entries from staleOver180/secretsFindings/shellExecTools (not just gradeDist/avgOverall)', () => {
    const entries: IndexEntry[] = [
      e({
        ref: 'a/lib', notServer: true, notServerReason: 'sdk', overall: 78, grade: 'B+',
        daysSinceLastCommit: 400,
        topFindings: [
          { id: 'security/committed-secret', severity: 'high' },
          { id: 'security/shell-exec-tool', severity: 'high' },
        ],
      }),
    ]
    const s = summarize(entries)
    expect(s.notServer).toBe(1)
    expect(s.staleOver180).toBe(0)
    expect(s.secretsFindings).toBe(0)
    expect(s.shellExecTools).toBe(0)
  })
  it('counts staleOver180 from daysSinceLastCommit, not health score', () => {
    const entries: IndexEntry[] = [
      e({ ref: 'a/stale', overall: 90, grade: 'A', daysSinceLastCommit: 200, dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
      e({ ref: 'a/fresh', overall: 90, grade: 'A', daysSinceLastCommit: 100, dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
      e({ ref: 'a/unknown', overall: 90, grade: 'A', dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
    ]
    const s = summarize(entries)
    expect(s.staleOver180).toBe(1)   // only the 200d entry; 100d not stale, undefined not counted
  })
  it('empty input → zeroed stats, no NaN', () => {
    const s = summarize([])
    expect(s.total).toBe(0)
    expect(s.avgOverall).toBe(0)
    expect(s.gradeDist).toEqual({})
  })
})

describe('summarize — unresolved repos (W1): a GitHub 404 must never count as a graded F', () => {
  it('counts unresolved separately, and excludes it from gradeDist/avgOverall even if overall/grade were somehow set', () => {
    // Reproduces today's actual buggy shape (index/results.json pre-fix): an
    // entry with insufficientData:true STILL carried overall:0/grade:"F".
    // The fix must be defense-in-depth — summarize() must never let such an
    // entry pollute the published stats, regardless of what leaked into
    // overall/grade upstream.
    const entries: IndexEntry[] = [
      e({ ref: 'pulumi/mcp-server', unresolved: true, overall: 0, grade: 'F' }),
      e({ ref: 'a/real', overall: 90, grade: 'A' }),
    ]
    const s = summarize(entries)
    expect(s.unresolved).toBe(1)
    expect(s.gradeDist).toEqual({ A: 1 })
    expect(s.avgOverall).toBe(90)
  })
  it('excludes unresolved entries from staleOver180/secretsFindings/shellExecTools too', () => {
    const entries: IndexEntry[] = [
      e({
        ref: 'pulumi/mcp-server', unresolved: true, overall: 0, grade: 'F',
        daysSinceLastCommit: 400,
        topFindings: [
          { id: 'security/committed-secret', severity: 'high' },
          { id: 'security/shell-exec-tool', severity: 'high' },
        ],
      }),
    ]
    const s = summarize(entries)
    expect(s.unresolved).toBe(1)
    expect(s.staleOver180).toBe(0)
    expect(s.secretsFindings).toBe(0)
    expect(s.shellExecTools).toBe(0)
  })
  it('unresolved is independent of notServer — both can be counted without double-affecting each other', () => {
    const entries: IndexEntry[] = [
      e({ ref: 'a/gone', unresolved: true }),
      e({ ref: 'a/lib', notServer: true, notServerReason: 'sdk' }),
    ]
    const s = summarize(entries)
    expect(s.unresolved).toBe(1)
    expect(s.notServer).toBe(1)
  })
})

// W6 review remediation item M2 (.superpowers/sdd/w6-review-findings.md):
// Scorecard.readmeSourced must thread through toEntry into IndexEntry
// unchanged, so a JSON consumer of index/results.json can tell a
// README-sourced tool surface (a maintainer's claim) apart from a
// code-extracted one without parsing findings.
describe('toEntry — readmeSourced passthrough (M2)', () => {
  const baseCard: Scorecard = {
    ref: 'a/b', rubricVersion: '1.5.0', overall: 80, grade: 'B',
    dimensions: [], notes: [], generatedAt: '2026-08-06T00:00:00Z', insufficientData: false,
  }
  it('a README-sourced scorecard produces an IndexEntry with readmeSourced === true', () => {
    const entry = toEntry('a/b', { ...baseCard, readmeSourced: true })
    expect(entry.readmeSourced).toBe(true)
  })
  it('a code-extracted scorecard (readmeSourced false) produces an IndexEntry with readmeSourced false/absent', () => {
    const entry = toEntry('a/b', { ...baseCard, readmeSourced: false })
    expect(entry.readmeSourced).toBeFalsy()
  })
  it('a scorecard with no readmeSourced at all produces an IndexEntry with it absent', () => {
    const entry = toEntry('a/b', baseCard)
    expect(entry.readmeSourced).toBeUndefined()
  })
})

// W6 (false-published-claim fix): an insufficientData Scorecard now carries
// overall/grade null. That must arrive in index/results.json as ABSENT (the
// IndexEntry convention for "no value" — same as notServer/unresolved), never
// as a number, and summarize()'s graded aggregates must be provably untouched
// by the change.
describe('toEntry / summarize — a withheld grade must not reach index/results.json', () => {
  const withheldCard: Scorecard = {
    ref: 'eat-pray-ai/yutu', rubricVersion: '1.5.0', overall: null, grade: null,
    dimensions: [
      { id: 'health', score: 97, confidence: 'high', available: 7, total: 7, findings: [] },
      { id: 'reliability', score: 92, confidence: 'high', available: 5, total: 5, findings: [] },
      { id: 'security', score: null, confidence: 'medium', available: 2, total: 3, findings: [] },
      { id: 'cost', score: null, confidence: 'low', available: 0, total: 2, findings: [] },
    ],
    notes: ['Security tool surface could not be determined — grade withheld to avoid a false clean bill.'],
    generatedAt: '2026-08-06T00:00:00Z', insufficientData: true,
  }

  it('IndexEntry.overall and .grade are undefined for a withheld card — no "A" in the published dataset', () => {
    const entry = toEntry('eat-pray-ai/yutu', withheldCard, 2)
    expect(entry.overall).toBeUndefined()
    expect(entry.grade).toBeUndefined()
    expect(entry.insufficientData).toBe(true)
  })
  it('the serialized entry contains no overall/grade keys with a value', () => {
    const entry = toEntry('eat-pray-ai/yutu', withheldCard, 2)
    const round = JSON.parse(JSON.stringify(entry)) as IndexEntry
    expect('overall' in round).toBe(false)
    expect('grade' in round).toBe(false)
  })
  it('the partial dimensions it DOES have still publish — withholding the headline is not withholding the evidence', () => {
    const entry = toEntry('eat-pray-ai/yutu', withheldCard, 2)
    expect(entry.dims!.health.score).toBe(97)
    expect(entry.dims!.reliability.score).toBe(92)
    expect(entry.dims!.security.score).toBeNull()
    expect(entry.dims!.cost.score).toBeNull()
  })
  // summarize() already filtered on `!e.insufficientData`, so the graded
  // aggregates were correct even while the bogus grades were being published.
  // Pinned here so the fix is provably a no-op for every published statistic.
  it('summarize: avgOverall and gradeDist are computed over GRADED servers only and are unchanged by the fix', () => {
    const graded: IndexEntry[] = [
      e({ ref: 'a/one', overall: 96, grade: 'A+' }),
      e({ ref: 'a/two', overall: 61, grade: 'C' }),
      e({ ref: 'a/three', overall: 72, grade: 'B-' }),
    ]
    // pre-fix shape: withheld entries still carried overall 95 / grade 'A'
    const before = summarize([...graded, e({ ref: 'w/one', insufficientData: true, overall: 95, grade: 'A' })])
    // post-fix shape: the same entries, headline withheld
    const after = summarize([...graded, e({ ref: 'w/one', insufficientData: true })])
    expect(after.avgOverall).toEqual(before.avgOverall)
    expect(after.gradeDist).toEqual(before.gradeDist)
    expect(after.insufficient).toBe(before.insufficient)
    // ...and the values are the graded-only ones
    expect(after.avgOverall).toBe(Math.round((96 + 61 + 72) / 3))
    expect(after.gradeDist).toEqual({ A: 1, C: 1, B: 1 })
    expect(after.insufficient).toBe(1)
  })
  it('summarize: all 29 withheld entries dropping their grade moves no published statistic', () => {
    const graded = Array.from({ length: 10 }, (_, i) => e({ ref: `g/${i}`, overall: 70 + i, grade: 'B' }))
    const withheldOld = Array.from({ length: 29 }, (_, i) => e({ ref: `w/${i}`, insufficientData: true, overall: 90, grade: 'A' }))
    const withheldNew = Array.from({ length: 29 }, (_, i) => e({ ref: `w/${i}`, insufficientData: true }))
    const before = summarize([...graded, ...withheldOld])
    const after = summarize([...graded, ...withheldNew])
    expect(after).toEqual(before)
    expect(after.gradeDist).toEqual({ B: 10 })
    expect(after.avgOverall).toBe(Math.round((70 + 79) / 2))
    expect(Number.isFinite(after.avgOverall)).toBe(true)
  })
  it('summarize: an index made ONLY of withheld entries reports avgOverall 0 and an empty gradeDist, no NaN', () => {
    const s = summarize(Array.from({ length: 5 }, (_, i) => e({ ref: `w/${i}`, insufficientData: true })))
    expect(s.avgOverall).toBe(0)
    expect(s.gradeDist).toEqual({})
    expect(s.insufficient).toBe(5)
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') expect(Number.isFinite(v), `${k} is not finite`).toBe(true)
    }
  })
  it('a graded card still threads its overall/grade through toEntry untouched (regression)', () => {
    const gradedCard: Scorecard = { ...withheldCard, ref: 'github/github-mcp-server', overall: 96, grade: 'A+', insufficientData: false }
    const entry = toEntry('github/github-mcp-server', gradedCard, 1)
    expect(entry.overall).toBe(96)
    expect(entry.grade).toBe('A+')
    expect(entry.insufficientData).toBeUndefined()
  })
})

// W6 (fabricated-dimension-value fix): a dimension with no measurement
// carries score: null all the way into index/results.json. It must arrive
// as null — never coerced to 0 (the worst possible score) or dropped — and
// no aggregate may consume it as a number.
describe('toEntry / summarize — null dimension scores must never be coerced', () => {
  const dynamicCard: Scorecard = {
    ref: 'duaraghav8/MCPJungle', rubricVersion: '1.5.0', overall: null, grade: null,
    dimensions: [
      { id: 'health', score: 92, confidence: 'high', available: 7, total: 7, findings: [] },
      { id: 'reliability', score: 70, confidence: 'high', available: 5, total: 5, findings: [] },
      { id: 'security', score: null, confidence: 'low', available: 1, total: 3, findings: [] },
      { id: 'cost', score: null, confidence: 'low', available: 0, total: 2, findings: [] },
    ],
    notes: [], generatedAt: '2026-08-06T00:00:00Z', insufficientData: false,
    notServer: true, notServerReason: 'dynamic',
  }
  it('toEntry threads null through to IndexEntry.dims unchanged — not 0, not undefined', () => {
    const entry = toEntry('duaraghav8/MCPJungle', dynamicCard)
    expect(entry.dims!.security.score).toBeNull()
    expect(entry.dims!.cost.score).toBeNull()
    expect(entry.dims!.health.score).toBe(92)
    expect(entry.dims!.security.confidence).toBe('low')
  })
  it('summarize tolerates null dimension scores and produces no NaN in any numeric stat', () => {
    const entries: IndexEntry[] = [
      toEntry('duaraghav8/MCPJungle', dynamicCard, 10),
      e({ ref: 'a/real', overall: 90, grade: 'A', dims: { health: { score: 90, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 90, confidence: 'high' }, cost: { score: 90, confidence: 'high' } } }),
    ]
    const s = summarize(entries)
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') expect(Number.isFinite(v), `${k} is not finite`).toBe(true)
    }
    // the dynamic entry is excluded from the graded aggregates entirely — a
    // null dimension can neither be averaged in nor counted as 0.
    expect(s.avgOverall).toBe(90)
    expect(s.dynamic).toBe(1)
    expect(s.gradeDist).toEqual({ A: 1 })
  })
  it('an all-null-dimension entry cannot drag any average toward zero', () => {
    const allNull: Scorecard = {
      ...dynamicCard,
      dimensions: dynamicCard.dimensions.map(d => ({ ...d, score: null, available: 0 })),
    }
    const s = summarize([
      toEntry('a/gone', allNull),
      e({ ref: 'a/real', overall: 80, grade: 'B' }),
    ])
    expect(s.avgOverall).toBe(80)
    expect(Number.isFinite(s.avgOverall)).toBe(true)
  })
})

// Fault hunt 2026-08-08 (C7). The scanner could fail in ways that were
// indistinguishable from success: a run that died partway wrote nothing, so
// the previous index stayed on disk and diffed as "zero changes"; a run
// starved by the rate limit wrote a full index in which most servers had
// simply failed to collect, which read as a product regression. Both
// happened during real work. `coverage` now makes the shape of the run part
// of the artifact.
describe('scan coverage gate', () => {
  const entry = (ref: string, ok: boolean) => (ok
    ? { ref, ok: true as const, overall: 80, grade: 'B+' }
    : { ref, ok: false as const, error: 'HTTP 403' })

  it('reports a complete, healthy run as complete', () => {
    const refs = ['a/b', 'c/d', 'e/f', 'g/h']
    const entries = refs.map(r => entry(r, true))
    const cov = coverageOf(refs.length, entries)
    expect(cov.complete).toBe(true)
    expect(cov.collectorFailures).toBe(0)
  })

  it('flags a run that did not finish every ref', () => {
    const cov = coverageOf(400, Array.from({ length: 150 }, (_, i) => entry(`a/${i}`, true)))
    expect(cov.complete).toBe(false)
    expect(cov.attempted).toBe(400)
    expect(cov.completed).toBe(150)
  })

  it('surfaces an outage: every ref completed but most failed to collect', () => {
    const entries = Array.from({ length: 400 }, (_, i) => entry(`a/${i}`, i < 60))
    const cov = coverageOf(400, entries)
    expect(cov.complete).toBe(true)              // the loop finished...
    expect(cov.collectorFailures).toBe(340)      // ...but it measured nothing
    expect(cov.collectorFailures / cov.attempted).toBeGreaterThan(0.25)
  })
})

// Mirrors the coverage computation in index/scan.ts's main().
function coverageOf(attempted: number, entries: Array<{ ok: boolean }>) {
  const collectorFailures = entries.filter(e => !e.ok).length
  return { attempted, completed: entries.length, collectorFailures, complete: entries.length === attempted }
}

// D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md):
// recordSurfaces is the scan-side wiring — snapshot every extracted surface,
// diff against the previous snapshot, append real events to the drift log.
// First run is the baseline by construction; a server absent from a run is
// NEVER a removal event (missing snapshot != removed tools).
describe('recordSurfaces', () => {
  const tools = [{ name: 'x', description: 'X', schemaText: 'def' }]
  it('first run writes snapshots, zero events (baseline); second identical run adds nothing; a change adds one event', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'tv-scan-')), 'surfaces')  // D2 review MINOR: ../drift.json must land inside the tmpdir, not the shared OS tmp root
    const r1 = recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-08-05T00:00:00.000Z', '1.5.0')
    expect(r1).toEqual({ written: 1, events: 0, suppressed: 0 })
    const r2 = recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-09-01T00:00:00.000Z', '1.5.0')
    expect(r2.events).toBe(0)
    const r3 = recordSurfaces(d, [{ ref: 'a/b', tools: [...tools, { name: 'y', schemaText: 'd2' }], source: 'code' as const }], '2026-10-01T00:00:00.000Z', '1.5.0')
    expect(r3.events).toBe(1)
  })
  it('a server absent from this run keeps its old snapshot and produces NO event (missing != removed)', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'tv-scan-')), 'surfaces')  // D2 review MINOR: ../drift.json must land inside the tmpdir, not the shared OS tmp root
    recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-08-05T00:00:00.000Z', '1.5.0')
    const r = recordSurfaces(d, [], '2026-09-01T00:00:00.000Z', '1.5.0')
    expect(r).toEqual({ written: 0, events: 0, suppressed: 0 })
  })
})

// Secondary-rate-limit postmortem (2026-08-13). GitHub's SECONDARY limit
// 403s while /rate_limit still shows thousands remaining, and graceful
// degradation converts those 403s into ok:true entries with empty signals —
// so a scan that was mostly noise reported collectorFailures: 0, coverage
// complete, while 242 servers silently drained into withheld. Degraded
// entries now count toward the outage gate alongside thrown failures.
describe('outage gate counts gracefully-degraded entries', () => {
  it('an entry with collector errors carries collectorErrors; a clean one omits it', () => {
    const clean = { ref: 'a/b', ok: true } as { collectorErrors?: number }
    const degraded = { ref: 'c/d', ok: true, collectorErrors: 3 } as { collectorErrors?: number }
    const entries = [clean, degraded]
    const failed = entries.filter(e => !(e as { ok: boolean }).ok).length
    const degradedCount = entries.filter(e => e.collectorErrors).length
    expect(failed).toBe(0)               // the old gate saw a perfect scan
    expect(degradedCount).toBe(1)        // the new gate sees the outage
    expect((failed + degradedCount) / entries.length).toBeGreaterThan(0.25)
  })
})

// 2026-08-15: consecutive scans swung 18 <-> 43 degraded entries, and every
// one of the 25 servers that changed published state between two scans had
// been degraded in the earlier one. A transient 403 is not a property of the
// server, so one more good-faith attempt runs before a withhold is published.
describe('degraded refs get one retry, and only a cleaner read replaces them', () => {
  const entry = (ref: string, errs?: number) => ({ ref, ok: true, ...(errs ? { collectorErrors: errs } : {}) })

  // Mirrors the replacement rule in index/scan.ts's retry pass.
  const merge = (before: Array<ReturnType<typeof entry>>, after: Array<ReturnType<typeof entry>>) => {
    const byRef = new Map(after.map(e => [e.ref, e]))
    let recovered = 0
    const out = before.map(b => {
      const a = byRef.get(b.ref)
      if (a && (a.collectorErrors ?? 0) < (b.collectorErrors ?? Infinity)) { recovered++; return a }
      return b
    })
    return { out, recovered }
  }

  it('replaces a degraded entry with a clean re-read', () => {
    const { out, recovered } = merge([entry('a/b', 3)], [entry('a/b')])
    expect(recovered).toBe(1)
    expect(out[0].collectorErrors).toBeUndefined()
  })
  it('keeps the original when the retry is no better — never a coin flip on which attempt ran last', () => {
    const { out, recovered } = merge([entry('a/b', 2)], [entry('a/b', 2)])
    expect(recovered).toBe(0)
    expect(out[0].collectorErrors).toBe(2)
  })
  it('keeps the original when the retry is worse', () => {
    const { out } = merge([entry('a/b', 1)], [entry('a/b', 5)])
    expect(out[0].collectorErrors).toBe(1)
  })
  it('never touches entries that were healthy the first time', () => {
    const { out, recovered } = merge([entry('a/b'), entry('c/d', 2)], [entry('c/d')])
    expect(recovered).toBe(1)
    expect(out[0].collectorErrors).toBeUndefined()
  })
  it('never retries an unresolved repo — a 404 cannot be re-read', () => {
    const entries = [
      { ref: 'gone/repo', ok: true, collectorErrors: 1, unresolved: true },
      { ref: 'flaky/repo', ok: true, collectorErrors: 2 },
    ]
    const retryable = entries.filter(e => e.collectorErrors && !e.unresolved).map(e => e.ref)
    expect(retryable).toEqual(['flaky/repo'])
  })

  it('surface inputs dedupe last-wins, so a retried ref is snapshotted once', () => {
    const inputs = [
      { ref: 'a/b', tools: [{ name: 'x', schemaText: 'first' }], source: 'code' as const },
      { ref: 'a/b', tools: [{ name: 'x', schemaText: 'retry' }], source: 'code' as const },
    ]
    const deduped = [...new Map(inputs.map(x => [x.ref, x])).values()]
    expect(deduped).toHaveLength(1)
    expect(deduped[0].tools[0].schemaText).toBe('retry')
  })
})
