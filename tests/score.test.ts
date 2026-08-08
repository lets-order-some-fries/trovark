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
    expect(card.rubricVersion).toBe('1.6.0')
    for (const d of card.dimensions) expect(d.confidence).toBe('high')
  })
  // W6 review remediation item M2 (.superpowers/sdd/w6-review-findings.md):
  // Signals.readmeSourced is a structured passthrough to Scorecard, not
  // renamed/dropped/recomputed along the way.
  it('M2: readmeSourced threads through from Signals to Scorecard unchanged', () => {
    const s = healthy()
    s.readmeSourced = true
    const card = score('x', s, '2026-07-31T00:00:00Z')
    expect(card.readmeSourced).toBe(true)
  })
  it('M2: a code-extracted card (readmeSourced false) carries false, not absent', () => {
    const s = healthy()
    s.readmeSourced = false
    const card = score('x', s, '2026-07-31T00:00:00Z')
    expect(card.readmeSourced).toBe(false)
  })
  it('M2: readmeSourced stays undefined on the card when extraction never ran at all', () => {
    const card = score('x', empty(), '2026-07-31T00:00:00Z')
    expect(card.readmeSourced).toBeUndefined()
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
    const health = card.dimensions.find(d => d.id === 'health')!
    expect(sec.available).toBe(0)
    expect(card.notes.join(' ')).toMatch(/security/)
    // The dropped dimensions are EXCLUDED from the weighted mean rather than
    // averaged in as 0 — health, the only measured dimension, still reports a
    // perfect 100 and is not deflated by the three empty ones.
    expect(health.score).toBe(100)
    // W6 (false-published-claim fix): this fixture is health-only —
    // reliability, security and cost all have zero collectible signals, so it
    // trips the coverage gate on two independent conditions (security primary
    // absent, and 3 dimensions fully dropped). It previously published
    // overall 100 / grade "A+" while ALSO reporting insufficientData: true —
    // a confident top grade for a server we had explicitly declined to
    // assess, which is precisely the claim the gate exists to suppress. The
    // headline is now withheld in the data, not just in the display.
    // (Exclusion-from-the-mean on a genuinely GRADED card — where the
    // headline survives — is pinned separately by the Rule A tests below.)
    expect(card.insufficientData).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
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

// W6 (fabricated-dimension-value fix): "absence lowers confidence, never
// fakes a value" applied to the DIMENSION scores themselves. The
// coverage gate already withheld the GRADE, but the dimension numbers were
// published regardless — and notServer/dynamic/unresolved bypass the gate
// entirely, so a dynamic gateway whose tool surface is explicitly unreadable
// was publishing security 100/100 (from the lone low-weight no-secrets
// signal, its primary absent) and cost 0/100 (from zero signals). Zero is
// not "unknown" — it is the worst possible score, published as a
// measurement.
describe('score() — a dimension with no measurement reports null, never a number', () => {
  const mixed = (): Signals => ({
    daysSinceLastCommit: 45, daysSinceLastRelease: 200, commitsLast90Days: 12,
    busFactor: 3, medianIssueResponseDays: 5, stars: 300, weeklyDownloads: 2000,
    archived: false, specEra: 'modern', hasCI: true, hasTests: false, hasLockfile: true,
    schemaExtracted: true, toolSurfaceRisk: 'medium', secretsFound: 0, cveWorst: 'low',
    schemaTokenEstimate: 12000, toolCount: 30, findings: [], errors: [],
  })

  // Rule A: available === 0 → there is no measurement, so say so. 0 is the
  // WORST possible score, not "unknown".
  it('Rule A: a dimension with available === 0 reports score null — explicitly not 0', () => {
    const s = healthy()
    s.schemaTokenEstimate = undefined; s.toolCount = undefined  // cost: 0 of 2
    const card = score('x', s, 'T')
    const cost = card.dimensions.find(d => d.id === 'cost')!
    expect(cost.available).toBe(0)
    expect(cost.score).toBeNull()
    expect(cost.score).not.toBe(0)
  })
  it('Rule A: the existing "No X signals could be collected" note still appears', () => {
    const s = healthy()
    s.schemaTokenEstimate = undefined; s.toolCount = undefined
    const card = score('x', s, 'T')
    expect(card.notes.join(' ')).toContain('No cost signals could be collected')
  })
  it('Rule A: a null dimension is excluded from overall, never averaged in as 0', () => {
    const s = healthy()
    s.schemaTokenEstimate = undefined; s.toolCount = undefined
    const card = score('x', s, 'T')
    expect(card.overall).toBe(100)  // health/reliability/security perfect; cost not counted as 0
  })

  // Rule B: the security PRIMARY (tool-surface risk, weight 3 of 6) is what
  // the dimension is actually about. Without it, security renormalizes onto
  // the low-weight no-secrets candidate signal and reads as a clean bill.
  // This is the v1.2 bug (unreadable repo → confident A+) reappearing at
  // dimension level.
  it('Rule B: toolSurfaceRisk undefined → security score is null, not renormalized onto the remaining low-weight signals', () => {
    const s = healthy()
    s.toolSurfaceRisk = undefined
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.available).toBe(2)     // no-secrets + dependency-cves still collected
    expect(sec.score).toBeNull()      // ...but the dimension is not measured
    expect(sec.score).not.toBe(100)
  })
  it('Rule B: confidence is untouched — absence lowers confidence AND withholds the number', () => {
    const s = healthy()
    s.toolSurfaceRisk = undefined
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.confidence).toBe('medium')   // 2/3 signals — unchanged by the withhold
    expect(sec.score).toBeNull()
  })
  it('Rule B: the existing "Low confidence in security" note still appears when coverage is low (1/3)', () => {
    const s = healthy()
    s.toolSurfaceRisk = undefined; s.cveWorst = undefined  // only no-secrets survives → 1/3
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.confidence).toBe('low')
    expect(sec.score).toBeNull()
    expect(card.notes.join(' ')).toMatch(/Low confidence in security: only 1\/3 signals available/)
  })
  it('Rule B: a readable tool surface scores security normally — no behaviour change', () => {
    for (const risk of ['none', 'low', 'medium', 'high'] as const) {
      const s = healthy()
      s.toolSurfaceRisk = risk
      const sec = score('x', s, 'T').dimensions.find(d => d.id === 'security')!
      expect(typeof sec.score).toBe('number')
    }
    const clean = healthy()
    expect(score('x', clean, 'T').dimensions.find(d => d.id === 'security')!.score).toBe(100)
  })

  // The live defect, reproduced exactly (duaraghav8/MCPJungle, 2026-08-06):
  // health 92/7-of-7, reliability 70/5-of-5, security 100 from 1 of 3,
  // cost 0 from 0 of 2.
  it('a dynamic gateway: security null + cost null, health/reliability untouched and numeric, overall/grade still null', () => {
    const s: Signals = {
      daysSinceLastCommit: 3, daysSinceLastRelease: 20, commitsLast90Days: 40,
      busFactor: 6, medianIssueResponseDays: 1, stars: 5000, weeklyDownloads: 50000,
      archived: false, specEra: 'modern', hasCI: true, hasTests: true, hasLockfile: true,
      schemaExtracted: true, secretsFound: 0,
      notServer: true, notServerReason: 'dynamic', findings: [], errors: [],
    }
    const card = score('duaraghav8/MCPJungle', s, 'T')
    const dim = (id: string) => card.dimensions.find(d => d.id === id)!
    expect(dim('security').score).toBeNull()
    expect(dim('cost').score).toBeNull()
    expect(dim('health').score).toBe(100)
    expect(dim('reliability').score).toBe(100)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
    // all four dimensions are still present, with their coverage denominators
    expect(dim('security').available).toBe(1)
    expect(dim('cost').available).toBe(0)
  })

  // A graded server by definition had a readable tool surface, so Rule B can
  // never fire on one, and Rule A only ever drops a dimension that was
  // already excluded from `overall`. Pinned numbers so a future regression
  // is caught by value, not just by shape.
  it('regression: a fully-graded server is unchanged — all four dimensions numeric, exact pinned values', () => {
    const card = score('x', mixed(), 'T')
    const dim = (id: string) => card.dimensions.find(d => d.id === id)!
    expect(dim('health').score).toBe(77)
    expect(dim('reliability').score).toBe(78)
    expect(dim('security').score).toBe(62)
    expect(dim('cost').score).toBe(47)
    expect(card.overall).toBe(69)
    expect(card.grade).toBe('C+')
    expect(card.insufficientData).toBe(false)
    for (const d of card.dimensions) expect(typeof d.score).toBe('number')
  })
  it('regression: the healthy fixture still scores a perfect 100/A+ with four numeric dimensions', () => {
    const card = score('x', healthy(), 'T')
    expect(card.overall).toBe(100)
    expect(card.grade).toBe('A+')
    for (const d of card.dimensions) expect(d.score).toBe(100)
  })

  // Absence withholds; positive EVIDENCE still speaks. A decode-confirmed
  // hidden payload is a measurement (deliberate concealment), so the D2
  // disqualifying override must still force security to 0 even when the
  // primary signal is missing — otherwise the worst servers hide behind the
  // withhold.
  it('the hidden-payload override still forces security 0 when the primary is absent — evidence beats absence', () => {
    const s = healthy()
    s.toolSurfaceRisk = undefined
    s.hiddenPayloadDecoded = 2
    const card = score('x', s, 'T')
    expect(card.dimensions.find(d => d.id === 'security')!.score).toBe(0)
    expect(card.notes.join(' ')).toMatch(/decode-confirmed hidden payload/i)
  })
})

// W6 (false-published-claim fix): the insufficientData gate is a GRADE-
// WITHHOLDING gate. Before this fix it withheld the grade only in the
// RENDERING (terminal banner / site chip) while `Scorecard.overall` and
// `.grade` stayed populated — so the withheld claim shipped anyway, into
// `trovark --json` and into the committed, publicly served
// `index/results.json`. Measured on the published index (2026-08-06):
// 29 of 29 insufficientData entries carried a numeric overall AND a letter
// grade, several of them "A" (eat-pray-ai/yutu 94/A, ndthanhdev/mcp-browser-kit
// 93/A, sitbon/magg 91/A). notServer and unresolved already nulled both
// fields; this gate did not. A machine consumer reading the public dataset
// saw grade A for a server we explicitly said we could not assess — exactly
// the v1.2 "unreadable repo scores a confident A+" bug, one layer down.
describe('score() — a withheld grade is withheld in the DATA, not just the display', () => {
  // Reproduces the live shape of eat-pray-ai/yutu / sitbon/magg: an active,
  // well-maintained repo whose tool schema could NOT be extracted — so the
  // security PRIMARY is absent and cost has nothing to measure, yet health
  // and reliability are strong enough that the weighted mean over the two
  // surviving dimensions lands at 95/A. That "A" is the false published claim.
  const unreadableToolSurface = (): Signals => ({
    daysSinceLastCommit: 2, daysSinceLastRelease: 15, commitsLast90Days: 60,
    busFactor: 4, medianIssueResponseDays: 1, stars: 1200,
    archived: false,
    specEra: 'modern', hasCI: true, hasTests: true, hasLockfile: true, schemaExtracted: false,
    // security PRIMARY absent — this is what trips the gate
    toolSurfaceRisk: undefined, secretsFound: 0, cveWorst: 'none',
    // cost: no schema was extracted, so there is nothing to measure
    schemaTokenEstimate: undefined, toolCount: undefined,
    findings: [], errors: ['tool schema extraction failed'],
  })

  it('the gate fires AND overall/grade are null — no letter grade escapes into the data', () => {
    const card = score('eat-pray-ai/yutu', unreadableToolSurface(), 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
  })
  it('specifically does not publish the pre-fix 95/"A" for a server whose surface we could not read', () => {
    const card = score('eat-pray-ai/yutu', unreadableToolSurface(), 'T')
    expect(card.grade).not.toBe('A')
    expect(card.overall).not.toBe(95)
    expect(typeof card.overall).not.toBe('number')
    expect(typeof card.grade).not.toBe('string')
  })
  it('notes still explain WHY the grade was withheld', () => {
    const card = score('eat-pray-ai/yutu', unreadableToolSurface(), 'T')
    expect(card.notes.join(' ')).toMatch(/tool surface could not be determined/i)
    expect(card.notes.join(' ')).toMatch(/grade withheld/i)
  })
  it('dimensions remain populated exactly as before — withholding the headline is not withholding the evidence', () => {
    const card = score('eat-pray-ai/yutu', unreadableToolSurface(), 'T')
    const dim = (id: string) => card.dimensions.find(d => d.id === id)!
    expect(card.dimensions).toHaveLength(4)
    expect(dim('health').score).toBe(97)
    expect(dim('reliability').score).toBe(92)
    expect(dim('security').score).toBeNull()   // Rule B — primary absent
    expect(dim('cost').score).toBeNull()       // Rule A — zero signals
    expect(dim('health').available).toBe(7)
    expect(dim('security').available).toBe(2)
    expect(dim('security').confidence).toBe('medium')
  })

  // The gate has three independent trip conditions; all three must null the
  // headline, not just the security-primary one.
  it('trip condition: fewer than 4 signals available → overall/grade null (was 100/"A+")', () => {
    const s = empty()
    s.daysSinceLastCommit = 10 // one signal in the whole card
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
    expect(card.notes.join(' ')).toMatch(/not enough to score/i)
  })
  it('trip condition: two or more dimensions fully dropped → overall/grade null', () => {
    const s = healthy()
    s.specEra = undefined; s.hasCI = undefined; s.hasTests = undefined
    s.hasLockfile = undefined; s.schemaExtracted = undefined
    s.schemaTokenEstimate = undefined; s.toolCount = undefined
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
    expect(card.notes.join(' ')).toMatch(/not enough coverage to score confidently/i)
  })
  it('trip condition: security primary absent on an otherwise perfect card → null, never 100/"A+"', () => {
    const s = healthy(); s.toolSurfaceRisk = undefined
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
  })

  // The whole point of the fix is that it touches ONLY withheld cards.
  it('regression: a fully-graded server is byte-identical — exact pinned overall and grade', () => {
    const card = score('x', healthy(), 'T')
    expect(card.insufficientData).toBe(false)
    expect(card.overall).toBe(100)
    expect(card.grade).toBe('A+')
    for (const d of card.dimensions) expect(d.score).toBe(100)
  })
  it('regression: a mid-range graded server is unchanged — 69/"C+" with four numeric dimensions', () => {
    const s: Signals = {
      daysSinceLastCommit: 45, daysSinceLastRelease: 200, commitsLast90Days: 12,
      busFactor: 3, medianIssueResponseDays: 5, stars: 300, weeklyDownloads: 2000,
      archived: false, specEra: 'modern', hasCI: true, hasTests: false, hasLockfile: true,
      schemaExtracted: true, toolSurfaceRisk: 'medium', secretsFound: 0, cveWorst: 'low',
      schemaTokenEstimate: 12000, toolCount: 30, findings: [], errors: [],
    }
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(false)
    expect(card.overall).toBe(69)
    expect(card.grade).toBe('C+')
  })
  it('regression: a graded server with ONE null dimension (Rule A) still keeps its grade — Rule A does not withhold the headline', () => {
    const s = healthy()
    s.schemaTokenEstimate = undefined; s.toolCount = undefined // cost dropped, only 1 dimension
    const card = score('x', s, 'T')
    expect(card.insufficientData).toBe(false)
    expect(card.overall).toBe(100)
    expect(card.grade).toBe('A+')
  })

  // The other two terminal states already did this correctly — pinned here so
  // the three withholding paths stay identical and can't drift apart.
  it('the three withheld terminal states are indistinguishable in the headline: all null/null', () => {
    const ins = score('x', unreadableToolSurface(), 'T')
    const lib = (() => { const s = empty(); s.notServer = true; s.notServerReason = 'sdk'; return score('x', s, 'T') })()
    const gone = (() => { const s = empty(); s.unresolved = true; return score('x', s, 'T') })()
    for (const card of [ins, lib, gone]) {
      expect(card.overall).toBeNull()
      expect(card.grade).toBeNull()
    }
    // ...but they remain DISTINCT terminal states, each with its own flag
    expect(ins.insufficientData).toBe(true)
    expect(lib.notServer).toBe(true)
    expect(gone.unresolved).toBe(true)
  })
  it('a graded card is the ONLY shape that carries a non-null headline (overall and grade move together)', () => {
    for (const s of [healthy(), unreadableToolSurface(), empty()]) {
      const card = score('x', s, 'T')
      expect(card.overall === null).toBe(card.grade === null)
    }
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

// D2 (integrity-phase2, 2026-08-04-integrity-v1.md "Phase 2"): a decode-
// confirmed hidden payload is a DISQUALIFYING OVERRIDE on the security
// dimension, not a weighted rubric signal — see the rationale comment in
// src/scoring/score.ts. These tests pin: (a) zero effect when absent —
// hiddenPayloadDecoded 0 or undefined, the universal case today — so there
// is provably no dilution of existing scores; (b) decisive effect when
// present; (c) the override cannot be triggered by mere observations
// (bidi/invisible-chars) — only a decode-confirmed count.
describe('score() — hidden-payload disqualifying override (Phase 2)', () => {
  it('hiddenPayloadDecoded: 0 → security score identical to before, no override note', () => {
    const s = healthy(); s.hiddenPayloadDecoded = 0
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.score).toBe(100) // healthy fixture: tool-surface(1)+no-secrets(1)+cve(1) all perfect
    expect(card.notes.join(' ')).not.toMatch(/decode-confirmed/i)
  })
  it('hiddenPayloadDecoded: undefined (not checked) → identical, no override note', () => {
    const s = healthy() // hiddenPayloadDecoded left undefined
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.score).toBe(100)
    expect(card.notes.join(' ')).not.toMatch(/decode-confirmed/i)
  })
  it('hiddenPayloadDecoded: 2 → security forced to exactly 0, note names the count, other dimensions unchanged', () => {
    const baseline = score('x', healthy(), 'T')
    const s = healthy(); s.hiddenPayloadDecoded = 2
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.score).toBe(0)
    expect(card.notes.join(' ')).toMatch(/Security scored 0: 2 decode-confirmed hidden payload/i)
    for (const id of ['health', 'reliability', 'cost'] as const) {
      const before = baseline.dimensions.find(d => d.id === id)!.score
      const after = card.dimensions.find(d => d.id === id)!.score
      expect(after).toBe(before)
    }
  })
  it('does not fire for mere observations (bidi/invisible-chars) — only a decode-confirmed count triggers it', () => {
    const s = healthy()
    s.hiddenPayloadDecoded = 0
    s.findings.push(
      { id: 'security/invisible-chars-observed', dimension: 'security', severity: 'info', message: 'm', evidence: 'e' },
      { id: 'security/bidi-override-observed', dimension: 'security', severity: 'info', message: 'm', evidence: 'e' },
    )
    const card = score('x', s, 'T')
    const sec = card.dimensions.find(d => d.id === 'security')!
    expect(sec.score).toBe(100)
    expect(card.notes.join(' ')).not.toMatch(/decode-confirmed/i)
  })
  it('regression: existing healthy fixture overall/grade unchanged at hiddenPayloadDecoded 0/undefined', () => {
    const base = score('x', healthy(), 'T')
    const zero = healthy(); zero.hiddenPayloadDecoded = 0
    const undef = healthy() // undefined
    expect(score('x', zero, 'T').overall).toBe(base.overall)
    expect(score('x', zero, 'T').grade).toBe(base.grade)
    expect(score('x', undef, 'T').overall).toBe(base.overall)
    expect(score('x', undef, 'T').grade).toBe(base.grade)
    expect(base.overall).toBe(100)
    expect(base.grade).toBe('A+')
  })
})

// Fault hunt 2026-08-08, CRITICAL 2. token-footprint is the dominant cost
// signal (weight 2 of 3) and is withheld for ~95% of the corpus. Letting cost
// renormalize onto tool-count alone REMOVES A PENALTY: absence rendered as a
// favourable measurement, which is the exact fault the null-dimension work
// exists to prevent. The cost fix reintroduced it through the back door.
describe('cost is withheld when its dominant signal is unmeasurable', () => {
  const withTools = (over: Partial<Signals> = {}): Signals => ({
    findings: [], errors: [], toolSurfaceRisk: 'none', toolCount: 12, ...over,
  })
  const cost = (s: Signals) => score('o/r', s, '2026-08-08T00:00:00.000Z').dimensions.find(d => d.id === 'cost')!

  it('withholds the cost score when schemaTokenEstimate is absent (never renormalizes upward)', () => {
    const d = cost(withTools({ schemaTokenEstimate: undefined }))
    expect(d.score).toBeNull()
    expect(d.available).toBeGreaterThan(0)   // tool-count WAS measured; confidence reflects it
  })

  it('scores cost normally when the footprint is genuinely measured', () => {
    const d = cost(withTools({ schemaTokenEstimate: 1500 }))
    expect(typeof d.score).toBe('number')
    expect(d.score).toBeGreaterThan(0)
  })

  it('absence never scores better than a measured expensive server', () => {
    const measured = cost(withTools({ schemaTokenEstimate: 30_000 }))
    const withheld = cost(withTools({ schemaTokenEstimate: undefined }))
    expect(typeof measured.score).toBe('number')
    expect(withheld.score).toBeNull()        // not a number that beats it
  })
})
