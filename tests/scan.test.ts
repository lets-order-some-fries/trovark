import { describe, expect, it } from 'vitest'
import { summarize, type IndexEntry } from '../index/scan.js'

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
