import { describe, expect, it } from 'vitest'
import { renderSite } from '../index/site.js'

const results = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  rubricVersion: '1.0.0',
  stats: {
    total: 3, scored: 2, failed: 1, insufficient: 0,
    gradeDist: { A: 1, C: 1 }, avgOverall: 79, staleOver180: 1,
    secretsFindings: 1, deprecated: 0, shellExecTools: 0,
  },
  entries: [
    { ref: 'acme/top', ok: true, overall: 96, grade: 'A+', repoUrl: 'https://github.com/acme/top', dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } },
    { ref: 'x/<script>alert(1)</script>', ok: true, overall: 61, grade: 'C', dims: { health: { score: 30, confidence: 'low' }, reliability: { score: 70, confidence: 'high' }, security: { score: 40, confidence: 'high' }, cost: { score: 80, confidence: 'high' } }, topFindings: [{ id: 'security/committed-secret', severity: 'high' }] },
    { ref: 'dead/one', ok: false, error: 'HTTP 404' },
  ],
} as never

describe('renderSite', () => {
  const html = renderSite(results)
  it('is self-contained — no external resource loads', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/url\(https?:/i)
  })
  it('escapes server-derived strings', () => {
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('shows honest stats including failures', () => {
    expect(html).toContain('96')
    expect(html).toMatch(/1[^0-9]*(failed|unreachable)/i)
    expect(html).toContain('rubric v1.0.0')
  })
  it('links rows to their repos', () => {
    expect(html).toContain('https://github.com/acme/top')
  })
})
