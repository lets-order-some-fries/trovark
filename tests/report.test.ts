import { describe, expect, it } from 'vitest'
import { renderTerminal } from '../src/report/terminal.js'
import { renderJson } from '../src/report/json.js'
import type { Scorecard } from '../src/types.js'

const card: Scorecard = {
  ref: 'acme/foo', rubricVersion: '1.0.0', overall: 78, grade: 'B+',
  dimensions: [
    { id: 'health', score: 86, confidence: 'high', available: 7, total: 7, findings: [] },
    { id: 'reliability', score: 74, confidence: 'high', available: 5, total: 5, findings: [] },
    { id: 'security', score: 70, confidence: 'medium', available: 2, total: 3, findings: [
      { id: 'security/committed-secret', dimension: 'security', severity: 'high',
        message: 'Possible AWS access key committed to the repository.', evidence: 'src/config.ts' },
    ] },
    { id: 'cost', score: 80, confidence: 'high', available: 2, total: 2, findings: [] },
  ],
  notes: ['Low confidence in security: only 2/3 signals available.'],
  generatedAt: '2026-07-31T00:00:00Z',
  insufficientData: false,
}

describe('renderTerminal', () => {
  const out = renderTerminal(card, { color: false })
  it('shows overall grade and rubric version', () => {
    expect(out).toContain('78/100 (B+)')
    expect(out).toContain('rubric v1.0.0')
  })
  it('shows every dimension with confidence', () => {
    for (const d of ['health', 'reliability', 'security', 'cost']) expect(out).toContain(d)
    expect(out).toContain('medium confidence')
  })
  it('shows findings with evidence', () => {
    expect(out).toContain('security/committed-secret')
    expect(out).toContain('evidence: src/config.ts')
  })
  it('shows notes', () => {
    expect(out).toContain('Low confidence in security')
  })
  it('color=false output has no ANSI escapes', () => {
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/)
  })
  it('color=true (default) emits ANSI paint codes', () => {
    const painted = renderTerminal(card)
    expect(painted).toMatch(/\x1b\[3[123]m/)
    expect(painted).toMatch(/\x1b\[0m/)
  })
  it('omits Findings and Notes sections when empty', () => {
    const bare: Scorecard = { ...card, notes: [], dimensions: card.dimensions.map(d => ({ ...d, findings: [] })) }
    const output = renderTerminal(bare, { color: false })
    expect(output).not.toContain('Findings:')
    expect(output).not.toContain('Notes:')
  })
  it('renders full and empty bars at the extremes', () => {
    const extremes: Scorecard = { ...card, dimensions: [
      { id: 'health', score: 100, confidence: 'high', available: 7, total: 7, findings: [] },
      { id: 'cost', score: 0, confidence: 'low', available: 1, total: 2, findings: [] },
    ] }
    const output = renderTerminal(extremes, { color: false })
    expect(output).toContain('█'.repeat(10))
    expect(output).toContain('░'.repeat(10))
  })
})

// W6 review remediation item M2 (.superpowers/sdd/w6-review-findings.md): a
// README-sourced tool surface is a maintainer's CLAIM, not verified
// extraction — surfaced explicitly in the terminal report (in addition to
// the existing 'reliability/readme-sourced-tools' info finding) so a human
// reading the CLI output can't miss it.
describe('renderTerminal — readmeSourced (M2)', () => {
  it('prints a distinct line when readmeSourced is true', () => {
    const out = renderTerminal({ ...card, readmeSourced: true }, { color: false })
    expect(out).toMatch(/README catalog.*not verified against source/i)
  })
  it('omits the line when readmeSourced is false or absent', () => {
    const falseOut = renderTerminal({ ...card, readmeSourced: false }, { color: false })
    const absentOut = renderTerminal(card, { color: false })
    expect(falseOut).not.toMatch(/README catalog.*not verified against source/i)
    expect(absentOut).not.toMatch(/README catalog.*not verified against source/i)
  })
})

describe('renderJson', () => {
  it('round-trips the scorecard', () => {
    expect(JSON.parse(renderJson(card))).toEqual(card)
  })
})

// W6 (fabricated-dimension-value fix): a dimension with no measurement
// carries score: null. The terminal report must say so honestly rather than
// printing `null/100`, `0/100`, `NaN`, or an empty bar that reads as a real
// (and terrible) measurement.
describe('renderTerminal — a dimension with no measurement (score: null)', () => {
  const dynamicCard: Scorecard = {
    ...card, overall: null, grade: null, notServer: true, notServerReason: 'dynamic',
    dimensions: [
      { id: 'health', score: 92, confidence: 'high', available: 7, total: 7, findings: [] },
      { id: 'reliability', score: 70, confidence: 'high', available: 5, total: 5, findings: [] },
      { id: 'security', score: null, confidence: 'low', available: 1, total: 3, findings: [] },
      { id: 'cost', score: null, confidence: 'low', available: 0, total: 2, findings: [] },
    ],
    notes: ['No cost signals could be collected; cost is excluded from the overall score.'],
  }
  const out = renderTerminal(dynamicCard, { color: false })

  it('prints an honest label for the unmeasured dimensions, not a number', () => {
    expect(out).toMatch(/security\s+not measured/)
    expect(out).toMatch(/cost\s+not measured/)
  })
  it('never renders a null score as 0, null or NaN', () => {
    expect(out).not.toMatch(/security\s+0\/100/)
    expect(out).not.toMatch(/cost\s+0\/100/)
    expect(out).not.toContain('NaN')
    expect(out).not.toContain('null')
    expect(out).not.toMatch(/security\s+100\/100/)
  })
  it('omits the bar for an unmeasured dimension — an empty bar reads as a measured zero', () => {
    const securityLine = out.split('\n').find(l => l.includes('security'))!
    expect(securityLine).not.toContain('░')
    expect(securityLine).not.toContain('█')
  })
  it('still names the dimension and its confidence', () => {
    expect(out).toMatch(/security\s+not measured\s+low confidence/)
  })
  it('measured dimensions on the same card still render their number and bar', () => {
    expect(out).toMatch(/health\s+92\/100\s+[█░]{10}\s+high confidence/)
    expect(out).toMatch(/reliability\s+70\/100/)
  })
  it('color=true still emits ANSI paint for an unmeasured dimension (no crash on null)', () => {
    const painted = renderTerminal(dynamicCard)
    expect(painted).toMatch(/\x1b\[3[0-9]m/)
    expect(painted).not.toContain('NaN')
  })
  it('renderJson round-trips a null dimension score as null, not 0', () => {
    const round = JSON.parse(renderJson(dynamicCard)) as Scorecard
    expect(round.dimensions.find(d => d.id === 'security')!.score).toBeNull()
    expect(round.dimensions.find(d => d.id === 'cost')!.score).toBeNull()
    expect(round).toEqual(dynamicCard)
  })
})

describe('renderTerminal — notServer (V2): rendered distinctly from INSUFFICIENT DATA', () => {
  const notServerCard: Scorecard = {
    ...card, insufficientData: false, notServer: true, notServerReason: 'sdk',
    notes: ['Library / not an MCP server (sdk): SDK/framework that defines the tool-registration API but registers no tools itself.'],
  }
  it('shows a distinct "LIBRARY — not an MCP server" banner, not INSUFFICIENT DATA and not a fabricated grade', () => {
    const out = renderTerminal(notServerCard, { color: false })
    expect(out).toMatch(/library.*not an mcp server/i)
    expect(out).not.toContain('INSUFFICIENT DATA')
    expect(out).not.toContain(`${notServerCard.overall}/100`)
  })
  it('still shows the reason and notes', () => {
    const out = renderTerminal(notServerCard, { color: false })
    expect(out).toContain('sdk')
    expect(out).toContain('SDK/framework that defines the tool-registration API')
  })
})

// W6 (false-published-claim fix): an insufficientData card now carries
// overall/grade null, exactly like notServer and unresolved already did. The
// human-facing presentation must be UNCHANGED — the same "INSUFFICIENT DATA"
// banner it printed when the fields were still populated — and nothing may
// leak the nulls as `null`, `NaN` or `0`.
describe('renderTerminal — insufficientData with a truly withheld headline (overall/grade null)', () => {
  const withheldCard: Scorecard = {
    ...card, overall: null, grade: null, insufficientData: true,
    dimensions: [
      { id: 'health', score: 97, confidence: 'high', available: 7, total: 7, findings: [] },
      { id: 'reliability', score: 92, confidence: 'high', available: 5, total: 5, findings: [] },
      { id: 'security', score: null, confidence: 'medium', available: 2, total: 3, findings: [] },
      { id: 'cost', score: null, confidence: 'low', available: 0, total: 2, findings: [] },
    ],
    notes: [
      'Security tool surface could not be determined — grade withheld to avoid a false clean bill.',
      'No cost signals could be collected; cost is excluded from the overall score.',
    ],
  }
  const out = renderTerminal(withheldCard, { color: false })

  it('prints the unchanged INSUFFICIENT DATA presentation', () => {
    expect(out).toContain('Trust Score: INSUFFICIENT DATA')
    expect(out).toContain('rubric v1.0.0')
  })
  it('is byte-identical to the pre-fix rendering of the same card with a populated headline', () => {
    // The old shape: identical card that still carried overall 95 / grade 'A'.
    // The banner branch never read those fields, so the human output must not
    // have moved by a single character.
    const prefixShape: Scorecard = { ...withheldCard, overall: 95, grade: 'A' }
    expect(out).toBe(renderTerminal(prefixShape, { color: false }))
  })
  it('leaks no null / NaN / fabricated 0 anywhere in the output', () => {
    expect(out).not.toContain('null')
    expect(out).not.toContain('NaN')
    expect(out).not.toContain('undefined')
    expect(out).not.toMatch(/Trust Score: \d/)
    expect(out).not.toMatch(/0\/100/)
  })
  it('never prints a letter grade for a withheld card', () => {
    expect(out).not.toMatch(/\((?:A|B|C|D|F)[+-]?\)/)
  })
  it('still shows the partial dimensions it does have, and the withholding reason', () => {
    expect(out).toMatch(/health\s+97\/100/)
    expect(out).toMatch(/reliability\s+92\/100/)
    expect(out).toMatch(/security\s+not measured/)
    expect(out).toContain('grade withheld')
  })
  it('color=true does not crash on the null headline', () => {
    const painted = renderTerminal(withheldCard)
    expect(painted).toContain('INSUFFICIENT DATA')
    expect(painted).not.toContain('NaN')
  })
  it('renderJson publishes overall/grade as null — the machine-readable withhold', () => {
    const round = JSON.parse(renderJson(withheldCard)) as Scorecard
    expect(round.overall).toBeNull()
    expect(round.grade).toBeNull()
    expect(round.insufficientData).toBe(true)
    expect(round).toEqual(withheldCard)
    // the JSON must not contain a grade string at the top level at all
    expect(renderJson(withheldCard)).toMatch(/"grade": null/)
    expect(renderJson(withheldCard)).toMatch(/"overall": null/)
  })
})

describe('renderTerminal — unresolved repo (W1): rendered distinctly, never as a graded F', () => {
  const unresolvedCard: Scorecard = {
    ...card, overall: null, grade: null, insufficientData: false, unresolved: true,
    notes: ['Repository could not be resolved on GitHub (404) — no grade to report.'],
  }
  it('shows a distinct "REPO UNAVAILABLE" banner, not INSUFFICIENT DATA and not a Trust Score', () => {
    const out = renderTerminal(unresolvedCard, { color: false })
    expect(out).toMatch(/repo unavailable/i)
    expect(out).not.toContain('INSUFFICIENT DATA')
    expect(out).not.toContain('Trust Score:')
    expect(out).not.toMatch(/\(F\)/)
  })
  it('still shows the explanatory note', () => {
    const out = renderTerminal(unresolvedCard, { color: false })
    expect(out).toContain('could not be resolved')
  })
})
