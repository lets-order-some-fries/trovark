// results.json → one self-contained static page (docs/index.html)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatDriftEvent } from '../src/derive/surface.js'
import type { IndexEntry, IndexStats } from './scan.js'
import type { DriftLog } from './surfaceStore.js'

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
  const safeUrl = e.repoUrl && /^https?:\/\//.test(e.repoUrl) ? e.repoUrl : undefined
  const name = safeUrl ? `<a href="${esc(safeUrl)}">${esc(e.ref)}</a>` : esc(e.ref)
  if (!e.ok) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">unreachable — ${esc(e.error ?? 'unknown error')}</td></tr>`
  // W1: a repo GitHub 404s (deleted/renamed) — rendered distinctly from both
  // insufficientData ("we read it, couldn't score it") and notServer ("we
  // read it, it's a library"). Checked first: there is nothing else to show,
  // not even partial dimensions, since nothing was ever fetched.
  if (e.unresolved) {
    return `<tr class="failed" data-overall="-1" title="repo unavailable — not found on GitHub (renamed or deleted)"><td>${name}</td><td colspan="6" class="muted">repo unavailable — not found on GitHub (renamed or deleted)</td></tr>`
  }
  const d = e.dims
  // W6 (fabricated-dimension-value fix): dims[k].score is null when the
  // dimension had no measurement. Render it as a muted em dash with a
  // "not measured" title — never as `0` (the worst possible score, published
  // as a fact) and never as the literal string "null". This also keeps the
  // client-side sorter honest: it maps a non-numeric cell (the em dash)
  // to -1, BELOW every measured value including a genuine 0 — `|| -1` would
  // have collapsed a measured 0 into the same bucket as never-measured.
  const dim = (k: 'health' | 'reliability' | 'security' | 'cost') => {
    const v = d?.[k]
    if (!v) return '<td>—</td>'
    if (v.score === null || v.score === undefined) {
      // Fault hunt MINOR: the old tooltip claimed "no signals could be
      // collected", which is FALSE for a primary-withheld dimension (signals
      // were collected; the primary was unmeasurable) — and it still
      // advertised a confidence letter for a score we refuse to publish.
      return '<td class="muted" title="not measured — the score is withheld rather than estimated; see the server\'s notes">—</td>'
    }
    return `<td>${v.score}<span class="conf">${esc(v.confidence[0])}</span></td>`
  }
  // W6 (coverage-v1.5, Task W6 Part B): rendered distinctly from the generic
  // notServer/"LIB" branch below — this IS a real MCP server, just one whose
  // tool list is built at runtime from upstream servers/a DB and therefore
  // has no static surface (src/derive/dynamic.ts). Checked BEFORE the
  // general notServer branch since Scorecard reuses notServer:true for this
  // reason too (see src/scoring/score.ts). Unlike the library branch, the
  // security cell is rendered normally (not "not applicable") — dimensions
  // are still shown and security is NOT renormalized away, per the plan's
  // explicit "highest-risk shape in the corpus" note.
  if (e.notServer && e.notServerReason === 'dynamic') {
    if (!d) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">dynamic tool surface — not statically analyzable</td></tr>`
    return `<tr class="failed" data-overall="-1" title="dynamic tool surface — tools registered at runtime from upstream; no static list exists"><td>${name}</td>` +
      `<td><span class="chip muted-chip" title="dynamic tool surface — not statically analyzable">DYN</span></td>` +
      `<td class="muted">—</td>${dim('health')}${dim('reliability')}${dim('security')}${dim('cost')}</tr>`
  }
  // V2: rendered distinctly from insufficientData — this is a library/SDK/
  // proxy/stub repo (correctly classified as having no tools to grade), not
  // a server the scanner failed to check. Mutually exclusive with
  // insufficientData by construction (see src/scoring/score.ts), checked
  // first for clarity.
  if (e.notServer) {
    const reasonLabel = esc(e.notServerReason ?? 'library')
    if (!d) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">library — not an MCP server, no tools to grade (${reasonLabel})</td></tr>`
    return `<tr class="failed" data-overall="-1" title="library — not an MCP server, no tools to grade (${reasonLabel})"><td>${name}</td>` +
      `<td><span class="chip muted-chip" title="library — not an MCP server (${reasonLabel})">LIB</span></td>` +
      `<td class="muted">—</td>${dim('health')}${dim('reliability')}<td class="muted" title="not applicable — not a server">—</td>${dim('cost')}</tr>`
  }
  if (e.insufficientData) {
    if (!d) return `<tr class="failed" data-overall="-1"><td>${name}</td><td colspan="6" class="muted">insufficient data to score</td></tr>`
    const securityCell = d.security.confidence === 'low' ? '<td class="muted" title="not assessed">?</td>' : dim('security')
    return `<tr class="failed" data-overall="-1" title="grade withheld — tool surface unreadable"><td>${name}</td>` +
      `<td><span class="chip muted-chip" title="grade withheld — tool surface unreadable">—</span></td>` +
      `<td class="muted">—</td>${dim('health')}${dim('reliability')}${securityCell}${dim('cost')}</tr>`
  }
  const flags = (e.topFindings ?? []).map(f => `<span class="flag ${esc(f.severity)}" title="${esc(f.id)}">⚑</span>`).join('')
  // W6 review remediation item M2: a README-sourced tool surface is a
  // maintainer's CLAIM, not verified extraction (see src/types.ts) — flagged
  // structurally here so a human scanning the table can tell it apart from
  // extracted-from-code, distinct from (and in addition to) the info finding
  // already carried in topFindings.
  const readmeBadge = e.readmeSourced
    ? '<span class="chip muted-chip" title="tool surface read from README catalog — not verified against source">README</span> '
    : ''
  return `<tr data-overall="${e.overall}"><td>${name} ${readmeBadge}${flags}</td>` +
    `<td><span class="chip" style="background:${gradeColor(e.grade)}">${esc(e.grade ?? '?')}</span></td>` +
    `<td>${e.overall}</td>${dim('health')}${dim('reliability')}${dim('security')}${dim('cost')}</tr>`
}

// D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md
// Task 6): the drift feed. An artifact, not a detector — facts only (counts,
// names, dates), never characterizations. The postmark-mcp scope note is
// mandated verbatim wherever the feed is published and is the ONLY sanctioned
// use of the word "malicious" on the page (tests/site.test.ts lints the rest
// of the page against verdict language with that one sentence removed).
function driftSection(r: Results, drift: DriftLog): string {
  const body = drift.events.length === 0
    ? `<p>Baseline recorded ${esc(r.generatedAt.slice(0, 10))}. Drift reporting begins with the next scan.</p>`
    : `<ul class="drift">\n${drift.events.slice(-50).reverse()
        .map(e => `<li>${esc(e.ref)} — ${esc(formatDriftEvent(e))}</li>`).join('\n')}\n</ul>`
  return `<h2>Tool-surface drift</h2>
<p class="tag">The index remembers what every server's tool surface looked like on each scan. Changes between scans of the same extractor version are listed here as facts — counts and dates, nothing more.</p>
${body}
<p class="muted">Scope note: The one confirmed in-the-wild malicious MCP server (postmark-mcp v1.0.16) added a BCC line in implementation code. Tool-surface diffing would not have caught it.</p>`
}

export function renderSite(r: Results, drift: DriftLog = { events: [] }): string {
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
.chip.muted-chip{background:#30363d;color:#8b949e;font-weight:500}
.conf{color:#8b949e;font-size:10px;margin-left:3px;vertical-align:super}
.flag{margin-left:4px}.flag.high{color:#f85149}.flag.medium{color:#c9a227}.flag.low{color:#8b949e}.flag.info{color:#6e7681}
.failed td{color:#8b949e}.muted{color:#8b949e}
h2{font-size:20px;margin:32px 0 4px}
ul.drift{list-style:none;padding:0;margin:8px 0}ul.drift li{padding:4px 0;border-bottom:1px solid #21262d}
footer{margin:28px 0;color:#8b949e;font-size:13px}
@media(prefers-color-scheme:light){body{background:#fff;color:#1f2328}.stat,code{background:#f6f8fa;border-color:#d0d7de}th,td,ul.drift li{border-color:#d0d7de}.chip.muted-chip{background:#eaeef2;color:#57606a}}
</style></head><body><main>
<h1>Trovark</h1>
<p class="tag">Trust scores for MCP servers — evidence-linked grades from static public signals. <code>npx trovark &lt;server&gt;</code></p>
<div class="stats">
${stat(s.total, 'servers scanned')}${stat(s.scored - s.insufficient - (s.notServer ?? 0) - (s.dynamic ?? 0) - (s.unresolved ?? 0), 'graded')}${stat(s.avgOverall, 'avg score')}${stat(s.gradeDist['A'] ?? 0, 'A grades')}${stat(s.staleOver180, 'stale / abandoned')}${stat(s.shellExecTools, 'expose exec/shell tools')}${stat(s.insufficient, 'insufficient data')}${stat(s.notServer ?? 0, 'library / not a server')}${stat(s.dynamic ?? 0, 'dynamic tool surface')}${stat(s.unresolved ?? 0, 'repo unavailable')}${stat(s.failed, 'failed / unreachable')}
</div>
<table id="t"><thead><tr>
<th data-k="0">server</th><th data-k="1">grade</th><th data-k="2">score</th><th data-k="3">health</th><th data-k="4">reliability</th><th data-k="5">security</th><th data-k="6">cost</th>
</tr></thead><tbody>
${r.entries.map(row).join('\n')}
</tbody></table>
${driftSection(r, drift)}
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
    const g=r=>{if(r.classList.contains('failed'))return -1;if(k<=2)return +r.dataset.overall;const v=parseFloat(r.cells[k].textContent);return Number.isNaN(v)?-1:v}
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
  const inPath = arg('--in', 'index/results.json')
  const results = JSON.parse(readFileSync(inPath, 'utf8')) as Results
  let drift: DriftLog = { events: [] }
  try { drift = JSON.parse(readFileSync(join(dirname(inPath), 'drift.json'), 'utf8')) as DriftLog } catch { /* no log yet: baseline state */ }
  const out = arg('--out', 'docs/index.html')
  writeFileSync(out, renderSite(results, drift))
  console.error(`wrote ${out} (${results.entries.length} rows, ${drift.events.length} drift events)`)
}
