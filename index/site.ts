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
  const dim = (k: 'health' | 'reliability' | 'security' | 'cost') =>
    d ? `<td>${d[k].score}<span class="conf">${esc(d[k].confidence[0])}</span></td>` : '<td>—</td>'
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
.chip.muted-chip{background:#30363d;color:#8b949e;font-weight:500}
.conf{color:#8b949e;font-size:10px;margin-left:3px;vertical-align:super}
.flag{margin-left:4px}.flag.high{color:#f85149}.flag.medium{color:#c9a227}.flag.low{color:#8b949e}
.failed td{color:#8b949e}.muted{color:#8b949e}
footer{margin:28px 0;color:#8b949e;font-size:13px}
@media(prefers-color-scheme:light){body{background:#fff;color:#1f2328}.stat,code{background:#f6f8fa;border-color:#d0d7de}th,td{border-color:#d0d7de}.chip.muted-chip{background:#eaeef2;color:#57606a}}
</style></head><body><main>
<h1>Trovark</h1>
<p class="tag">Trust scores for MCP servers — evidence-linked grades from static public signals. <code>npx trovark &lt;server&gt;</code></p>
<div class="stats">
${stat(s.total, 'servers scanned')}${stat(s.scored - s.insufficient - (s.notServer ?? 0) - (s.unresolved ?? 0), 'graded')}${stat(s.avgOverall, 'avg score')}${stat(s.gradeDist['A'] ?? 0, 'A grades')}${stat(s.staleOver180, 'stale / abandoned')}${stat(s.shellExecTools, 'expose exec/shell tools')}${stat(s.insufficient, 'insufficient data')}${stat(s.notServer ?? 0, 'library / not a server')}${stat(s.unresolved ?? 0, 'repo unavailable')}${stat(s.failed, 'failed / unreachable')}
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
    const g=r=>r.classList.contains('failed')?-1:(k<=2?+r.dataset.overall:parseFloat(r.cells[k].textContent)||-1)
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
