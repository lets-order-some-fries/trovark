import { describe, expect, it } from 'vitest'
import { summarize, toEntry, type IndexEntry } from '../index/scan.js'
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
