# Trovark Phase 2 — Trust Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch-scan the public MCP-server ecosystem with the existing Trovark engine and publish a static, self-contained **Trust Index** page (GitHub Pages, `docs/index.html`) with first-party ecosystem statistics — the launch artifact.

**Architecture:** Three thin scripts under `index/` reusing the v1 engine unchanged: `discover.ts` (collect owner/repo refs from curated seed + public server lists) → `scan.ts` (concurrency-limited resolve→assemble→score, compact `results.json` + summary stats) → `site.ts` (results.json → one self-contained `docs/index.html`, zero external assets). Live run + Pages enablement + launch draft are controller-executed (Task 4).

**Tech Stack:** Existing project only — TypeScript NodeNext ESM, no new dependencies. Scripts run via `npx tsx`.

## Global Constraints

- No new dependencies. Reuse `src/` modules via relative `.js`-suffixed imports.
- Never execute scanned code; static/public signals only (unchanged v1 promise).
- Honest data: failed scans are recorded as failures, insufficient-data cards flagged — never dropped silently; the site must show these numbers.
- `docs/index.html` must be fully self-contained (inline CSS/JS, no CDN/fonts/images) and must escape all server-derived strings (ref names are attacker-influenced input).
- Scripts accept `--in/--out/--limit` style flags; deterministic output ordering (sort by overall desc, then ref) for stable diffs.
- All tests offline (fixtures); live network only in Task 4.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- TDD: failing test → verify → implement → verify. Full `npm test` + `npm run build` green before each commit. (tsconfig `include` stays `["src"]` — `index/` runs via tsx and is type-checked by the vitest/tsx toolchain, not the publish build.)

## File Map

```
index/seed.txt          curated known-server refs (checked in)
index/discover.ts       seed + public lists → index/servers.json
index/scan.ts           servers.json → index/results.json (cards + stats)
index/site.ts           results.json → docs/index.html
tests/discover.test.ts  extraction unit tests
tests/scan.test.ts      summarize() unit tests
tests/site.test.ts      generator output assertions
docs/launch/show-hn.md  launch draft (Task 4, controller)
```

---

### Task 1: Discovery — `index/discover.ts`

**Files:**
- Create: `index/seed.txt`, `index/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `createHttp` from `../src/util/http.js`.
- Produces: `extractRepoRefs(markdown: string): string[]` (exported, pure) and CLI `npx tsx index/discover.ts [--limit N] [--out index/servers.json]` writing `{ generatedAt: string, count: number, refs: string[] }`. Task 2 reads that shape.

- [ ] **Step 1: Write `index/seed.txt`** (curated, one ref per line — known servers incl. the smoke list)

```
github/github-mcp-server
microsoft/playwright-mcp
cloudflare/mcp-server-cloudflare
awslabs/mcp
supabase-community/supabase-mcp
stripe/agent-toolkit
upstash/context7
exa-labs/exa-mcp-server
makenotion/notion-mcp-server
browserbase/mcp-server-browserbase
tavily-ai/tavily-mcp
modelcontextprotocol/servers
elastic/mcp-server-elasticsearch
grafana/mcp-grafana
mongodb-js/mongodb-mcp-server
redis/mcp-redis
neo4j-contrib/mcp-neo4j
qdrant/mcp-server-qdrant
chroma-core/chroma-mcp
firecrawl/firecrawl-mcp-server
mendableai/firecrawl-mcp-server
docker/mcp-servers
kubernetes-mcp-server/kubernetes-mcp-server
Azure/azure-mcp
googleapis/genai-toolbox
aws-samples/sample-mcp-server-s3
slackapi/slack-mcp-server
sentry-mcp/sentry-mcp
getsentry/sentry-mcp
heroku/heroku-mcp-server
hashicorp/terraform-mcp-server
pulumi/mcp-server
vercel/mcp-adapter
netlify/netlify-mcp
oraios/serena
```

- [ ] **Step 2: Write the failing tests** — `tests/discover.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { extractRepoRefs } from '../index/discover.js'

describe('extractRepoRefs', () => {
  it('extracts owner/repo from github links in markdown', () => {
    const md = `
- [Foo](https://github.com/acme/foo-mcp) — does foo
- [Bar](https://github.com/beta/bar-mcp/) trailing slash
- deep link https://github.com/acme/foo-mcp/blob/main/README.md (same repo)
`
    expect(extractRepoRefs(md).sort()).toEqual(['acme/foo-mcp', 'beta/bar-mcp'])
  })
  it('strips .git, query strings and anchors', () => {
    const md = 'https://github.com/a/b.git https://github.com/c/d?tab=readme #x https://github.com/e/f#section'
    expect(extractRepoRefs(md).sort()).toEqual(['a/b', 'c/d', 'e/f'])
  })
  it('ignores non-repo github paths and awesome-list repos', () => {
    const md = `
https://github.com/topics/mcp
https://github.com/sponsors/whoever
https://github.com/features/actions
https://github.com/punkpeye/awesome-mcp-servers
https://github.com/acme/real-server
`
    expect(extractRepoRefs(md)).toEqual(['acme/real-server'])
  })
  it('dedupes case-insensitively, keeps first casing', () => {
    const md = 'https://github.com/Acme/Foo https://github.com/acme/foo'
    expect(extractRepoRefs(md)).toEqual(['Acme/Foo'])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — cannot find module `../index/discover.js`.

- [ ] **Step 4: Write `index/discover.ts`**

```ts
// Discover public MCP server repos: curated seed + linked lists → servers.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'

const BAD_OWNERS = new Set([
  'topics', 'sponsors', 'features', 'orgs', 'marketplace', 'search', 'about',
  'pricing', 'collections', 'login', 'contact', 'enterprise', 'apps', 'settings',
  'readme', 'trending', 'site', 'security', 'customer-stories', 'team',
])

/** Pure: pull owner/repo refs out of markdown. Skips non-repo paths and awesome-lists. */
export function extractRepoRefs(markdown: string): string[] {
  const seen = new Map<string, string>() // lower → original
  for (const m of markdown.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/, '')
    if (BAD_OWNERS.has(owner.toLowerCase())) continue
    if (/awesome/i.test(repo)) continue
    const ref = `${owner}/${repo}`
    const key = ref.toLowerCase()
    if (!seen.has(key)) seen.set(key, ref)
  }
  return [...seen.values()]
}

// Public list sources (fetched as raw markdown; no auth needed).
const LIST_SOURCES = [
  'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md',
  'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
]

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main(): Promise<void> {
  const limit = Number(arg('--limit', '400'))
  const out = arg('--out', 'index/servers.json')
  const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })

  const seed = readFileSync(new URL('./seed.txt', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

  const fromLists: string[] = []
  for (const url of LIST_SOURCES) {
    try {
      fromLists.push(...extractRepoRefs(await http.text(url)))
      console.error(`fetched ${url}`)
    } catch (err) {
      console.error(`WARN: list source failed, continuing: ${url} (${(err as Error).message})`)
    }
  }

  const seen = new Map<string, string>()
  for (const ref of [...seed, ...fromLists]) {
    const key = ref.toLowerCase()
    if (!seen.has(key)) seen.set(key, ref)
  }
  const refs = [...seen.values()].slice(0, limit)
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), count: refs.length, refs }, null, 2))
  console.error(`wrote ${out}: ${refs.length} refs (seed ${seed.length}, lists ${fromLists.length})`)
}

if (process.argv[1]?.endsWith('discover.ts')) await main()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/discover.test.ts` then full `npm test` and `npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(index): discovery — seed + public lists → servers.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Batch scanner — `index/scan.ts`

**Files:**
- Create: `index/scan.ts`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `servers.json` (Task 1 shape); `resolve`, `assemble`, `score`, `createHttp` from `src/`.
- Produces (Task 3 reads this exactly):

```ts
export interface IndexEntry {
  ref: string
  ok: boolean
  error?: string            // when !ok
  overall?: number
  grade?: string
  insufficientData?: boolean
  repoUrl?: string
  dims?: Record<'health' | 'reliability' | 'security' | 'cost', { score: number; confidence: string }>
  topFindings?: Array<{ id: string; severity: string }>  // cap 3
}
export interface IndexStats {
  total: number; scored: number; failed: number; insufficient: number
  gradeDist: Record<string, number>          // letter (modifiers stripped) → count, of scored & sufficient
  avgOverall: number                          // of scored & sufficient
  staleOver180: number                        // health signal daysSinceLastCommit > 180 — approximated as health.score < 40
  secretsFindings: number                     // entries with a security/committed-secret finding
  deprecated: number                          // entries with health/deprecated-package finding
  shellExecTools: number                      // entries with security/shell-exec-tool finding
}
export function summarize(entries: IndexEntry[]): IndexStats
```

`results.json` = `{ generatedAt, rubricVersion, stats: IndexStats, entries: IndexEntry[] }`, entries sorted by `overall` desc (failures last, then by ref asc).

- [ ] **Step 1: Write the failing tests** — `tests/scan.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { summarize, type IndexEntry } from '../index/scan.js'

const e = (over: Partial<IndexEntry>): IndexEntry => ({ ref: 'a/b', ok: true, ...over })

describe('summarize', () => {
  it('computes counts, grade distribution and average', () => {
    const entries: IndexEntry[] = [
      e({ ref: 'a/one', overall: 96, grade: 'A+', dims: { health: { score: 100, confidence: 'high' }, reliability: { score: 90, confidence: 'high' }, security: { score: 100, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
      e({ ref: 'a/two', overall: 61, grade: 'C', topFindings: [{ id: 'security/committed-secret', severity: 'high' }], dims: { health: { score: 30, confidence: 'high' }, reliability: { score: 70, confidence: 'high' }, security: { score: 40, confidence: 'high' }, cost: { score: 80, confidence: 'high' } } }),
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
    expect(s.staleOver180).toBe(1)                    // health 30 < 40
    expect(s.secretsFindings).toBe(1)
    expect(s.deprecated).toBe(0)
    expect(s.shellExecTools).toBe(0)
  })
  it('empty input → zeroed stats, no NaN', () => {
    const s = summarize([])
    expect(s.total).toBe(0)
    expect(s.avgOverall).toBe(0)
    expect(s.gradeDist).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `index/scan.ts`**

```ts
// Batch-score discovered servers → results.json (compact cards + first-party stats)
import { readFileSync, writeFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'
import { resolve } from '../src/resolver.js'
import { assemble } from '../src/assemble.js'
import { score } from '../src/scoring/score.js'
import { RUBRIC_VERSION } from '../src/scoring/rubric.js'
import type { Scorecard } from '../src/types.js'

export interface IndexEntry {
  ref: string
  ok: boolean
  error?: string
  overall?: number
  grade?: string
  insufficientData?: boolean
  repoUrl?: string
  dims?: Record<'health' | 'reliability' | 'security' | 'cost', { score: number; confidence: string }>
  topFindings?: Array<{ id: string; severity: string }>
}

export interface IndexStats {
  total: number; scored: number; failed: number; insufficient: number
  gradeDist: Record<string, number>
  avgOverall: number
  staleOver180: number
  secretsFindings: number
  deprecated: number
  shellExecTools: number
}

export function summarize(entries: IndexEntry[]): IndexStats {
  const scoredOk = entries.filter(e => e.ok)
  const graded = scoredOk.filter(e => !e.insufficientData && typeof e.overall === 'number')
  const gradeDist: Record<string, number> = {}
  for (const g of graded) {
    const letter = (g.grade ?? '').replace(/[+-]$/, '')
    if (letter) gradeDist[letter] = (gradeDist[letter] ?? 0) + 1
  }
  const has = (e: IndexEntry, id: string) => (e.topFindings ?? []).some(f => f.id === id)
  return {
    total: entries.length,
    scored: scoredOk.length,
    failed: entries.length - scoredOk.length,
    insufficient: scoredOk.filter(e => e.insufficientData).length,
    gradeDist,
    avgOverall: graded.length === 0 ? 0 : Math.round(graded.reduce((a, e) => a + (e.overall ?? 0), 0) / graded.length),
    staleOver180: graded.filter(e => (e.dims?.health.score ?? 100) < 40).length,
    secretsFindings: scoredOk.filter(e => has(e, 'security/committed-secret')).length,
    deprecated: scoredOk.filter(e => has(e, 'health/deprecated-package')).length,
    shellExecTools: scoredOk.filter(e => has(e, 'security/shell-exec-tool')).length,
  }
}

function toEntry(ref: string, card: Scorecard): IndexEntry {
  const dims = Object.fromEntries(card.dimensions.map(d => [d.id, { score: d.score, confidence: d.confidence }])) as IndexEntry['dims']
  const findings = card.dimensions.flatMap(d => d.findings)
    .sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity))
    .slice(0, 3).map(f => ({ id: f.id, severity: f.severity }))
  return {
    ref, ok: true, overall: card.overall, grade: card.grade,
    insufficientData: card.insufficientData || undefined,
    repoUrl: card.resolved?.repo ? `https://github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}` : undefined,
    dims, topFindings: findings.length > 0 ? findings : undefined,
  }
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
  const entries = await pool(refs, concurrency, async (ref): Promise<IndexEntry> => {
    try {
      const identity = await resolve(ref, http)
      const signals = await assemble(identity, http, now, { hasToken })
      const card = score(ref, signals, now.toISOString(), {
        ...(identity.npmPackage ? { npmPackage: identity.npmPackage } : {}),
        ...(identity.pypiPackage ? { pypiPackage: identity.pypiPackage } : {}),
        ...(identity.repo ? { repo: identity.repo } : {}),
      })
      return toEntry(ref, card)
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

  const payload = { generatedAt: now.toISOString(), rubricVersion: RUBRIC_VERSION, stats: summarize(entries), entries }
  writeFileSync(outFile, JSON.stringify(payload, null, 2))
  console.error(`wrote ${outFile}: ${payload.stats.scored}/${payload.stats.total} scored, avg ${payload.stats.avgOverall}`)
}

if (process.argv[1]?.endsWith('scan.ts')) await main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scan.test.ts` then `npm test` and `npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(index): concurrency-limited batch scanner → results.json + first-party stats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Site generator — `index/site.ts`

**Files:**
- Create: `index/site.ts`
- Test: `tests/site.test.ts`

**Interfaces:**
- Consumes: `results.json` (Task 2 shape).
- Produces: `renderSite(results: Results): string` (exported, pure) and CLI `npx tsx index/site.ts [--in index/results.json] [--out docs/index.html]`.

**Hard requirements:** fully self-contained HTML (inline CSS + JS, zero external requests); every server-derived string HTML-escaped; sortable columns via vanilla JS; shows the honest numbers (failed + insufficient counts visible); links: repo per row, GitHub repo, npm package, methodology (GitHub blob URL); footer `generated <ISO date> · rubric v<version> · trovark`.

- [ ] **Step 1: Write the failing tests** — `tests/site.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/site.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `index/site.ts`**

```ts
// results.json → one self-contained static page (docs/index.html)
import { readFileSync, writeFileSync } from 'node:fs'
import type { IndexEntry, IndexStats } from './scan.js'

export interface Results {
  generatedAt: string
  rubricVersion: string
  stats: IndexStats
  entries: IndexEntry[]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const gradeColor = (grade: string | undefined) =>
  !grade ? '#666' : grade.startsWith('A') ? '#22a06b' : grade.startsWith('B') ? '#7fa32a' : grade.startsWith('C') ? '#c9a227' : '#c0392b'

function row(e: IndexEntry): string {
  const name = e.repoUrl ? `<a href="${esc(e.repoUrl)}">${esc(e.ref)}</a>` : esc(e.ref)
  if (!e.ok) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">unreachable — ${esc(e.error ?? 'unknown error')}</td></tr>`
  if (e.insufficientData) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">insufficient data to score</td></tr>`
  const d = e.dims
  const dim = (k: 'health' | 'reliability' | 'security' | 'cost') =>
    d ? `<td>${d[k].score}<span class="conf">${esc(d[k].confidence[0])}</span></td>` : '<td>—</td>'
  const flags = (e.topFindings ?? []).map(f => `<span class="flag ${esc(f.severity)}" title="${esc(f.id)}">⚑</span>`).join('')
  return `<tr data-overall="${e.overall}"><td>${name} ${flags}</td>` +
    `<td><span class="chip" style="background:${gradeColor(e.grade)}">${esc(e.grade ?? '?')}</span></td>` +
    `<td>${e.overall}</td>${dim('health')}${dim('reliability')}${dim('security')}${dim('cost')}</tr>`
}

export function renderSite(r: Results): string {
  const s = r.stats
  const stat = (n: string | number, label: string) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trovark — MCP Server Trust Index</title>
<style>
:root{color-scheme:dark light}
body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
main{max-width:1080px;margin:0 auto;padding:32px 16px}
h1{font-size:28px;margin:0}
.tag{color:#8b949e;margin:4px 0 20px}
code{background:#161b22;padding:2px 8px;border-radius:6px}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
.stat{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px 18px;min-width:110px}
.stat b{display:block;font-size:22px}.stat span{color:#8b949e;font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #21262d}
th{cursor:pointer;color:#8b949e;user-select:none;white-space:nowrap}
a{color:#58a6ff;text-decoration:none}
.chip{color:#fff;border-radius:6px;padding:1px 8px;font-weight:600}
.conf{color:#8b949e;font-size:10px;margin-left:3px;vertical-align:super}
.flag{margin-left:4px}.flag.high{color:#f85149}.flag.medium{color:#c9a227}.flag.low{color:#8b949e}
.failed td{color:#8b949e}.muted{color:#8b949e}
footer{margin:28px 0;color:#8b949e;font-size:13px}
@media(prefers-color-scheme:light){body{background:#fff;color:#1f2328}.stat,code{background:#f6f8fa;border-color:#d0d7de}th,td{border-color:#d0d7de}}
</style></head><body><main>
<h1>Trovark</h1>
<p class="tag">Trust scores for MCP servers — evidence-linked grades from static public signals. <code>npx trovark &lt;server&gt;</code></p>
<div class="stats">
${stat(s.total, 'servers scanned')}${stat(s.scored - s.insufficient, 'graded')}${stat(s.avgOverall, 'avg score')}${stat(s.gradeDist['A'] ?? 0, 'A grades')}${stat(s.staleOver180, 'poor health')}${stat(s.secretsFindings, 'possible committed secrets')}${stat(s.insufficient, 'insufficient data')}${stat(s.failed, 'failed / unreachable')}
</div>
<table id="t"><thead><tr>
<th data-k="0">server</th><th data-k="1">grade</th><th data-k="2">score</th><th data-k="3">health</th><th data-k="4">reliability</th><th data-k="5">security</th><th data-k="6">cost</th>
</tr></thead><tbody>
${r.entries.map(row).join('\n')}
</tbody></table>
<footer>generated ${esc(r.generatedAt)} · rubric v${esc(r.rubricVersion)} ·
<a href="https://github.com/lets-order-some-fries/trovark">github</a> ·
<a href="https://www.npmjs.com/package/trovark">npm</a> ·
<a href="https://github.com/lets-order-some-fries/trovark/blob/main/docs/methodology.md">methodology</a> ·
grades are evidence-linked heuristics, not audits — run <code>npx trovark &lt;server&gt;</code> for the full evidence</footer>
<script>
document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{
  const k=+th.dataset.k, tb=document.querySelector('#t tbody'), rows=[...tb.rows]
  const dir=th.dataset.d==='a'?-1:1; th.dataset.d=dir===1?'a':'d'
  rows.sort((x,y)=>{
    if(k===0)return dir*x.cells[0].textContent.localeCompare(y.cells[0].textContent)
    const g=r=>r.cells.length<8?(k===2?+r.dataset.overall:-1):(k===1?+r.dataset.overall:parseFloat(r.cells[k].textContent)||-1)
    return dir*(g(y)-g(x))
  })
  rows.forEach(r=>tb.appendChild(r))
}))
</script>
</main></body></html>`
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

if (process.argv[1]?.endsWith('site.ts')) {
  const results = JSON.parse(readFileSync(arg('--in', 'index/results.json'), 'utf8')) as Results
  const out = arg('--out', 'docs/index.html')
  writeFileSync(out, renderSite(results))
  console.error(`wrote ${out} (${results.entries.length} rows)`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/site.test.ts` then `npm test` and `npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(index): self-contained static Trust Index page generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Live index run + Pages + launch draft (controller-executed)

- [ ] Run `GITHUB_TOKEN=$(gh auth token) npx tsx index/discover.ts --limit 400` → sanity-check `servers.json` count.
- [ ] Run `GITHUB_TOKEN=$(gh auth token) npx tsx index/scan.ts` (expect 20-50 min at concurrency 4 within API limits) → sanity-check stats (failed rate, insufficient rate, grade spread).
- [ ] Run `npx tsx index/site.ts` → open/inspect `docs/index.html`.
- [ ] Commit `index/servers.json`, `index/results.json`, `docs/index.html`.
- [ ] After the repo is public (owner action): enable GitHub Pages (main, `/docs`) → verify the live URL.
- [ ] Draft `docs/launch/show-hn.md` from the real stats. No posting — owner's call.

## Plan Self-Review (completed)

- **Coverage:** discovery/scан/site/live-run map 1:1 to the Phase 2 spec outline; honest-data constraint carried into stats + site (failed/insufficient shown). No badges/Action in this wave (deferred, YAGNI).
- **Placeholders:** none; all code complete.
- **Type consistency:** `IndexEntry`/`IndexStats`/`Results` shapes identical across Tasks 2–3; `score()`'s optional `resolved` param matches v1's current signature; `Scorecard.insufficientData`/`resolved` fields exist in v1 as shipped.
