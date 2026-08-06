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
  it('sort comparator distinguishes rows by class, not a wrong cell count', () => {
    expect(html).toContain("classList.contains('failed')")
    expect(html).not.toContain('cells.length<8')
  })
  it('shows partial dimensions for grade-withheld servers instead of a blank row', () => {
    const partial = {
      ...results,
      entries: [{
        ref: 'gorm-server/rust-mcp',
        ok: true,
        insufficientData: true,
        repoUrl: 'https://github.com/gorm-server/rust-mcp',
        dims: {
          health: { score: 85, confidence: 'high' },
          reliability: { score: 72, confidence: 'high' },
          security: { score: 50, confidence: 'low' },
          cost: { score: 60, confidence: 'medium' },
        },
      }],
    } as never
    const out = renderSite(partial)
    // health/reliability scores it does have are shown
    expect(out).toContain('85')
    expect(out).toContain('72')
    // grade withheld, not a fabricated letter grade
    expect(out).not.toMatch(/class="chip" style="background:[^"]*">[A-F][+-]?</)
    expect(out).toMatch(/grade withheld/i)
    // no fabricated overall number rendered as the score cell
    expect(out).toContain('<td class="muted">—</td>')
    // security wasn't meaningfully determined (low confidence) → marked not assessed
    expect(out).toMatch(/title="not assessed">\?</)
    // still sortable / sinks below graded rows like other failed/insufficient rows
    expect(out).toMatch(/<tr class="failed" data-overall="-1"[^>]*>[\s\S]*gorm-server\/rust-mcp/)
  })
  it('renders notServer rows distinctly from insufficient-data rows (V2)', () => {
    const withLibrary = {
      ...results,
      entries: [{
        ref: 'modelcontextprotocol/rust-sdk',
        ok: true,
        notServer: true,
        notServerReason: 'sdk',
        repoUrl: 'https://github.com/modelcontextprotocol/rust-sdk',
        dims: {
          health: { score: 90, confidence: 'high' },
          reliability: { score: 65, confidence: 'medium' },
          security: { score: 50, confidence: 'low' },
          cost: { score: 60, confidence: 'medium' },
        },
      }],
    } as never
    const out = renderSite(withLibrary)
    // distinct wording — not the insufficient-data phrasing
    expect(out).toMatch(/library.*not an mcp server/i)
    expect(out).not.toMatch(/insufficient data to score/i)
    expect(out).not.toMatch(/tool surface unreadable/i)
    // no fabricated letter grade or overall number
    expect(out).not.toMatch(/class="chip" style="background:[^"]*">[A-F][+-]?</)
    expect(out).toContain('<td class="muted">—</td>')
    // still sinks below graded rows for sorting, like other withheld outcomes
    expect(out).toMatch(/<tr class="failed" data-overall="-1"[^>]*>[\s\S]*rust-sdk/)
  })
  it('renders unresolved rows distinctly — never as a graded F, never "insufficient data" (W1)', () => {
    const withUnresolved = {
      ...results,
      stats: { ...results.stats, unresolved: 1 },
      entries: [{
        ref: 'pulumi/mcp-server',
        ok: true,
        unresolved: true,
        repoUrl: 'https://github.com/pulumi/mcp-server',
      }],
    } as never
    const out = renderSite(withUnresolved)
    // distinct wording — "repo unavailable", not the insufficient-data or notServer phrasing
    expect(out).toMatch(/repo unavailable/i)
    expect(out).not.toMatch(/insufficient data to score/i)
    expect(out).not.toMatch(/library.*not an mcp server/i)
    // no fabricated letter grade chip (e.g. an "F" chip) anywhere for this row
    expect(out).not.toMatch(/class="chip" style="background:[^"]*">[A-F][+-]?</)
    // still sinks below graded rows for sorting, like other withheld outcomes
    expect(out).toMatch(/<tr class="failed" data-overall="-1"[^>]*>[\s\S]*pulumi\/mcp-server/)
  })
  it('shows an "unresolved" stat tile distinct from insufficient/notServer/failed', () => {
    const withUnresolved = { ...results, stats: { ...results.stats, unresolved: 3 } } as never
    const out = renderSite(withUnresolved)
    expect(out).toMatch(/<b>3<\/b><span>repo unavailable<\/span>/)
  })
  // W6 review remediation item M2 (.superpowers/sdd/w6-review-findings.md):
  // a README-sourced tool surface is a maintainer's CLAIM, not verified
  // extraction — flagged visibly in the table so a human can tell it apart
  // from a code-extracted row.
  it('M2: shows a README-sourced badge for entries with readmeSourced === true, and not for a code-extracted row', () => {
    const withReadme = {
      ...results,
      entries: [
        { ref: 'acme/shim', ok: true, overall: 70, grade: 'B', readmeSourced: true, dims: { health: { score: 70, confidence: 'high' }, reliability: { score: 70, confidence: 'high' }, security: { score: 70, confidence: 'high' }, cost: { score: 70, confidence: 'high' } } },
        { ref: 'acme/coded', ok: true, overall: 80, grade: 'B', readmeSourced: false, dims: { health: { score: 80, confidence: 'high' }, reliability: { score: 80, confidence: 'high' }, security: { score: 80, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } },
      ],
    } as never
    const out = renderSite(withReadme)
    expect(out).toMatch(/acme\/shim[\s\S]{0,120}README<\/span>/)
    expect(out).not.toMatch(/acme\/coded[\s\S]{0,120}README<\/span>/)
  })
  // W6 (fabricated-dimension-value fix): dims[k].score is null when the
  // dimension had no measurement. The card must never print that as 0 (the
  // worst possible score), as the literal string "null", or let it sort as a
  // numeric 0 in the client-side sorter.
  it('renders a null dimension score as an honest blank, never as 0 or "null"', () => {
    const withNulls = {
      ...results,
      stats: { ...results.stats, dynamic: 1 },
      entries: [{
        ref: 'duaraghav8/MCPJungle', ok: true, notServer: true, notServerReason: 'dynamic',
        dims: {
          health: { score: 92, confidence: 'high' },
          reliability: { score: 70, confidence: 'high' },
          security: { score: null, confidence: 'low' },
          cost: { score: null, confidence: 'low' },
        },
      }],
    } as never
    const out = renderSite(withNulls)
    expect(out).toContain('MCPJungle')
    expect(out).not.toContain('>null<')
    expect(out).not.toContain('null<span')
    // the measured dimensions are still shown with their real numbers
    expect(out).toMatch(/<td>92<span class="conf">h<\/span><\/td>/)
    expect(out).toMatch(/<td>70<span class="conf">h<\/span><\/td>/)
    // ...the unmeasured ones are not rendered as a numeric 0 cell
    expect(out).not.toMatch(/<td>0<span class="conf">/)
    expect(out).toMatch(/not measured/i)
  })
  it('a null dimension cell holds no parseable number, so the sorter cannot rank it as 0', () => {
    const withNulls = {
      ...results,
      entries: [{
        ref: 'a/partial', ok: true, overall: 80, grade: 'B',
        dims: {
          health: { score: 80, confidence: 'high' },
          reliability: { score: 80, confidence: 'high' },
          security: { score: 80, confidence: 'high' },
          cost: { score: null, confidence: 'low' },
        },
      }],
    } as never
    const out = renderSite(withNulls)
    const cells = out.match(/<td[^>]*>(?:(?!<\/td>).)*<\/td>/g) ?? []
    const nullCell = cells.find(c => /not measured/i.test(c))!
    expect(nullCell).toBeDefined()
    // the sorter does parseFloat(textContent) || -1 — the cell text must not
    // parse to 0, or an unmeasured dimension would rank as the worst score.
    const text = nullCell.replace(/<[^>]*>/g, '')
    expect(Number.parseFloat(text) || -1).toBe(-1)
  })
  it('a graded row with a null dimension still renders its grade chip and overall (Rule A does not withhold the grade)', () => {
    const withNulls = {
      ...results,
      entries: [{
        ref: 'a/partial', ok: true, overall: 80, grade: 'B',
        dims: {
          health: { score: 80, confidence: 'high' },
          reliability: { score: 80, confidence: 'high' },
          security: { score: 80, confidence: 'high' },
          cost: { score: null, confidence: 'low' },
        },
      }],
    } as never
    const out = renderSite(withNulls)
    expect(out).toMatch(/class="chip" style="background:[^"]*">B</)
    expect(out).toContain('<td>80</td>')
  })
  // W6 (false-published-claim fix): a withheld entry no longer carries
  // overall/grade at all (they are undefined, not a number). The card must
  // render identically to before — grade chip "—", score cell "—", partial
  // dimensions shown — and must never print `undefined`, `null` or `0`, nor
  // let the client-side sorter rank the row as a real 0.
  it('renders a withheld entry with NO overall/grade exactly as it rendered with them — no undefined/null/0 leakage', () => {
    const withheld = {
      ...results,
      stats: { ...results.stats, insufficient: 1 },
      entries: [{
        ref: 'eat-pray-ai/yutu',
        ok: true,
        insufficientData: true,
        repoUrl: 'https://github.com/eat-pray-ai/yutu',
        dims: {
          health: { score: 97, confidence: 'high' },
          reliability: { score: 92, confidence: 'high' },
          security: { score: null, confidence: 'medium' },
          cost: { score: null, confidence: 'low' },
        },
      }],
    } as never
    const out = renderSite(withheld)
    expect(out).toContain('eat-pray-ai/yutu')
    // the withheld presentation is intact
    expect(out).toMatch(/grade withheld/i)
    expect(out).toContain('<td class="muted">—</td>')
    // no fabricated letter-grade chip, and no leaked sentinels in the row
    expect(out).not.toMatch(/class="chip" style="background:[^"]*">[A-F][+-]?</)
    expect(out).not.toContain('>undefined<')
    expect(out).not.toContain('>null<')
    expect(out).not.toMatch(/data-overall="(?:undefined|null|NaN)"/)
    // partial dimensions still published
    expect(out).toMatch(/<td>97<span class="conf">h<\/span><\/td>/)
    expect(out).toMatch(/<td>92<span class="conf">h<\/span><\/td>/)
  })
  it('a withheld row sorts as "no value" (-1), never as a real 0, with or without a stale overall', () => {
    const mk = (extra: Record<string, unknown>) => ({
      ...results,
      entries: [
        { ref: 'a/graded', ok: true, overall: 80, grade: 'B', dims: { health: { score: 80, confidence: 'high' }, reliability: { score: 80, confidence: 'high' }, security: { score: 80, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } },
        { ref: 'w/held', ok: true, insufficientData: true, dims: { health: { score: 97, confidence: 'high' }, reliability: { score: 92, confidence: 'high' }, security: { score: null, confidence: 'medium' }, cost: { score: null, confidence: 'low' } }, ...extra },
      ],
    }) as never
    // post-fix (no overall/grade) and pre-fix (stale 95/'A') must render the same row
    const after = renderSite(mk({}))
    const before = renderSite(mk({ overall: 95, grade: 'A' }))
    expect(after).toBe(before)
    // the withheld row carries the sink sentinel; the graded row keeps its number
    expect(after).toMatch(/<tr class="failed" data-overall="-1"[^>]*>[\s\S]*w\/held/)
    expect(after).toMatch(/<tr data-overall="80">/)
    // exactly one grade chip in the table — the graded row's
    expect(after.match(/class="chip" style="background:/g) ?? []).toHaveLength(1)
  })
  it('a withheld entry with no dims at all still renders its explanatory row', () => {
    const bare = {
      ...results,
      entries: [{ ref: 'w/bare', ok: true, insufficientData: true }],
    } as never
    const out = renderSite(bare)
    expect(out).toMatch(/insufficient data to score/i)
    expect(out).not.toContain('>undefined<')
    expect(out).not.toContain('NaN')
  })
  it('rejects non-http(s) repoUrl schemes', () => {
    const evil = {
      ...results,
      entries: [{ ref: 'a/evil', ok: true, overall: 50, grade: 'D', repoUrl: 'javascript:alert(1)', dims: { health: { score: 50, confidence: 'low' }, reliability: { score: 50, confidence: 'low' }, security: { score: 50, confidence: 'low' }, cost: { score: 50, confidence: 'low' } } }],
    } as never
    const out = renderSite(evil)
    expect(out).not.toContain('javascript:alert')
    expect(out).toContain('a/evil') // still rendered, just unlinked
  })
})
