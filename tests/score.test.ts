import { describe, expect, it } from 'vitest'
import { score } from '../src/scoring/score.js'
import { DIMENSION_WEIGHTS, SIGNALS } from '../src/scoring/rubric.js'
import type { Signals } from '../src/types.js'

const empty = (): Signals => ({ findings: [], errors: [] })

const healthy = (): Signals => ({
  daysSinceLastCommit: 3, daysSinceLastRelease: 20, commitsLast90Days: 40,
  busFactor: 6, medianIssueResponseDays: 1, stars: 5000, weeklyDownloads: 50000,
  archived: false, specEra: 'modern', hasCI: true, hasTests: true, hasLockfile: true,
  schemaExtracted: true, toolSurfaceRisk: 'none', secretsFound: 0, cveWorst: 'none',
  schemaTokenEstimate: 1500, toolCount: 6, findings: [], errors: [],
})

describe('rubric shape', () => {
  it('dimension weights sum to 1', () => {
    expect(Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
  it('every signal belongs to a known dimension and has positive weight', () => {
    for (const s of SIGNALS) {
      expect(DIMENSION_WEIGHTS[s.dimension]).toBeGreaterThan(0)
      expect(s.weight).toBeGreaterThan(0)
    }
  })
})

describe('score()', () => {
  it('perfect signals → A+ with high confidence everywhere', () => {
    const card = score('x', healthy(), '2026-07-31T00:00:00Z')
    expect(card.overall).toBe(100)
    expect(card.grade).toBe('A+')
    expect(card.rubricVersion).toBe('1.4.0')
    for (const d of card.dimensions) expect(d.confidence).toBe('high')
  })
  it('missing signals lower confidence, never throw, never zero the score', () => {
    const s = empty()
    s.daysSinceLastCommit = 10 // one health signal only
    const card = score('x', s, '2026-07-31T00:00:00Z')
    const health = card.dimensions.find(d => d.id === 'health')!
    expect(health.confidence).toBe('low')
    expect(health.score).toBeGreaterThan(0) // scored from what exists
  })
  it('a dimension with zero signals is excluded from overall and noted', () => {
    const s = empty()
    s.daysSinceLastCommit = 10; s.commitsLast90Days = 30; s.busFactor = 5
    s.archived = false; s.stars = 2000; s.daysSinceLastRelease = 10; s.medianIssueResponseDays = 1
    const card = score('x', s, '2026-07-31T00:00:00Z')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.available).toBe(0)
    expect(card.notes.join(' ')).toMatch(/security/)
    expect(card.overall).toBe(100) // health-only, perfect health signals
  })
  it('archived repo tanks health', () => {
    const s = healthy(); s.archived = true
    const card = score('x', s, '2026-07-31T00:00:00Z')
    const health = card.dimensions.find(d => d.id === 'health')!
    expect(health.score).toBeLessThan(90)
  })
  it('critical CVE tanks security', () => {
    const s = healthy(); s.cveWorst = 'critical'
    const card = score('x', s, '2026-07-31T00:00:00Z')
    expect(card.dimensions.find(d => d.id === 'security')!.score).toBeLessThan(80)
  })
  it('findings are routed to their dimension', () => {
    const s = healthy()
    s.findings.push({ id: 'security/test', dimension: 'security', severity: 'high', message: 'm', evidence: 'e' })
    const card = score('x', s, '2026-07-31T00:00:00Z')
    expect(card.dimensions.find(d => d.id === 'security')!.findings).toHaveLength(1)
    expect(card.dimensions.find(d => d.id === 'health')!.findings).toHaveLength(0)
  })
  it('is deterministic', () => {
    expect(score('x', healthy(), 'T')).toEqual(score('x', healthy(), 'T'))
  })
  it('flags insufficient data when fewer than 4 signals are available', () => {
    const s = empty()
    s.daysSinceLastCommit = 10 // one signal only
    const card = score('x', s, '2026-07-31T00:00:00Z')
    expect(card.insufficientData).toBe(true)
    expect(card.notes.join(' ')).toMatch(/not enough to score/i)
  })
  it('healthy fixture has plenty of signals → insufficientData is false', () => {
    const card = score('x', healthy(), '2026-07-31T00:00:00Z')
    expect(card.insufficientData).toBe(false)
  })
  it('withholds grade when the security tool-surface signal is absent', () => {
    const s = healthy(); s.toolSurfaceRisk = undefined
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.notes.join(' ')).toMatch(/tool surface|grade withheld/i)
  })
  it('does NOT withhold when tool-surface is present (even if low)', () => {
    const s = healthy(); s.toolSurfaceRisk = 'high'
    expect(score('x', s, 'T').insufficientData).toBe(false)
  })
  it('withholds when two or more dimensions are fully dropped', () => {
    const s = empty(); s.daysSinceLastCommit = 5 // only health has 1 signal; reliability/security/cost empty
    expect(score('x', s, 'T').insufficientData).toBe(true)
  })
  it('withholds via the dimensions-dropped branch alone (not the <4 clause)', () => {
    const s = healthy()
    // drop reliability + cost entirely, keep health(7) + security(3) intact →
    // availableTotal ~10 (clears <4), tool-surface present (no security-primary trip),
    // yet 2 dimensions fully dropped → must still withhold.
    s.specEra = undefined; s.hasCI = undefined; s.hasTests = undefined
    s.hasLockfile = undefined; s.schemaExtracted = undefined
    s.schemaTokenEstimate = undefined; s.toolCount = undefined
    const card = score('x', s, 'T')
    const reliability = card.dimensions.find(d => d.id === 'reliability')!
    const cost = card.dimensions.find(d => d.id === 'cost')!
    expect(reliability.available).toBe(0)
    expect(cost.available).toBe(0)
    expect(card.insufficientData).toBe(true)
  })
})

describe('score() — notServer (V2): a distinct terminal state, not insufficientData', () => {
  it('a notServer scorecard is NOT insufficientData, even though its coverage would otherwise withhold', () => {
    const s = empty() // sparse signals — would normally trip the <4-signals / dimensions-dropped gate
    s.notServer = true
    s.notServerReason = 'sdk'
    s.notServerNote = 'SDK/framework that defines the tool-registration API but registers no tools itself.'
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(false)
    expect(card.notServer).toBe(true)
    expect(card.notServerReason).toBe('sdk')
    expect(card.notes.join(' ')).toMatch(/not an mcp server/i)
  })
  it('notes for a notServer card do not also claim "insufficient data" / "grade withheld"', () => {
    const s = empty()
    s.notServer = true
    s.notServerReason = 'not-server'
    const card = score('x', s, 'T')
    expect(card.notes.join(' ')).not.toMatch(/insufficient|grade withheld/i)
  })
  // I9: a notServer card previously still carried a real numeric
  // overall/grade (e.g. typescript-sdk scored 100/A+) — misleading, since
  // there's no tool surface to grade, and it tripped `--fail-under` on a
  // library (see cli.test.ts). No headline score/grade is reported.
  it('I9: a notServer card has null overall and grade — no headline score to report', () => {
    const s = empty()
    s.notServer = true
    s.notServerReason = 'sdk'
    const card = score('x', s, 'T')
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
  })
  it('a normal card with no notServer signal is unaffected (regression)', () => {
    const card = score('x', healthy(), 'T')
    expect(card.notServer).toBeUndefined()
    expect(card.notServerReason).toBeUndefined()
  })
  it('security-primary-absent still withholds normally when notServer is NOT set (guard: only notServer bypasses the gate)', () => {
    const s = healthy(); s.toolSurfaceRisk = undefined
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.notServer).toBeUndefined()
  })
})

describe('score() — unresolved (W1): a repo GitHub 404s must never get a numeric grade', () => {
  // Reproduces the exact shape assemble.ts produces for a 404'd repo today:
  // sparse/empty signals (nothing was ever fetched) plus the new unresolved flag.
  it('an unresolved scorecard has null overall/grade — the same non-null-until-verified guarantee as notServer', () => {
    const s = empty()
    s.unresolved = true
    const card = score('x', s, 'T')
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
    expect(card.unresolved).toBe(true)
  })
  it('an unresolved scorecard is NOT insufficientData — it is its own distinct terminal state', () => {
    const s = empty()
    s.unresolved = true
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(false)
  })
  it('notes explain the repo could not be resolved, without also claiming "insufficient data"', () => {
    const s = empty()
    s.unresolved = true
    const card = score('x', s, 'T')
    expect(card.notes.join(' ')).toMatch(/not.*(resolved|found)/i)
    expect(card.notes.join(' ')).not.toMatch(/insufficient|grade withheld/i)
  })
  it('is mutually exclusive with notServer in practice, and a normal card is unaffected (regression)', () => {
    const card = score('x', healthy(), 'T')
    expect(card.unresolved).toBeUndefined()
  })
})
