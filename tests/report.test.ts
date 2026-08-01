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

describe('renderJson', () => {
  it('round-trips the scorecard', () => {
    expect(JSON.parse(renderJson(card))).toEqual(card)
  })
})
