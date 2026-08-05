import type { Scorecard } from '../types.js'

const ESC = '\x1b['
const paint = (code: number, text: string, on: boolean) => (on ? `${ESC}${code}m${text}${ESC}0m` : text)
const colorFor = (score: number): number => (score >= 85 ? 32 : score >= 55 ? 33 : 31) // green/yellow/red

function bar(score: number): string {
  const full = Math.round(score / 10)
  return '█'.repeat(full) + '░'.repeat(10 - full)
}

export function renderTerminal(card: Scorecard, opts: { color?: boolean } = {}): string {
  const c = opts.color ?? true
  const lines: string[] = []
  lines.push(`trovark  ·  ${card.ref}`)
  if (card.resolved) {
    const parts: string[] = []
    if (card.resolved.npmPackage) parts.push(`npm:${card.resolved.npmPackage}`)
    if (card.resolved.pypiPackage) parts.push(`pypi:${card.resolved.pypiPackage}`)
    if (card.resolved.repo) parts.push(`github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}`)
    if (parts.length > 0) lines.push(`  resolved: ${parts.join(' · ')}`)
  }
  if (card.unresolved) {
    // W1: a DISTINCT terminal state from both notServer and INSUFFICIENT
    // DATA — the GitHub repo 404s (deleted/renamed/never existed), so there
    // is nothing to grade. Must never render as a Trust Score / F card (the
    // 18-false-F-card bug this fixes).
    lines.push(paint(31, 'REPO UNAVAILABLE — not found on GitHub (renamed or deleted)', c) + `   rubric v${card.rubricVersion}`)
  } else if (card.notServer && card.notServerReason === 'dynamic') {
    // W6 (coverage-v1.5, Task W6 Part B): a DISTINCT label from "LIBRARY" —
    // this IS a real MCP server, just one whose tool list is built at
    // runtime from upstream servers/a DB and therefore has no static
    // surface. See src/derive/dynamic.ts.
    lines.push(paint(33, 'DYNAMIC TOOL SURFACE — not statically analyzable', c) + `   rubric v${card.rubricVersion}`)
  } else if (card.notServer) {
    // V2: a DISTINCT terminal state from INSUFFICIENT DATA — this repo was
    // never going to have tools to grade (library/SDK/proxy/stub), not a
    // server we failed to check. See src/derive/classify.ts.
    const reasonPart = card.notServerReason ? ` (${card.notServerReason})` : ''
    lines.push(paint(33, `LIBRARY — not an MCP server${reasonPart}`, c) + `   rubric v${card.rubricVersion}`)
  } else if (card.insufficientData) {
    lines.push(paint(31, 'Trust Score: INSUFFICIENT DATA', c) + `   rubric v${card.rubricVersion}`)
  } else {
    // I9: overall/grade are only ever null when notServer (handled above) —
    // this branch always has real values, but the type is nullable to
    // reflect that case, so fall back defensively rather than asserting.
    const overall = card.overall ?? 0
    lines.push(paint(colorFor(overall), `Trust Score: ${overall}/100 (${card.grade ?? '?'})`, c) + `   rubric v${card.rubricVersion}`)
  }
  // W6 review remediation item M2: a README-sourced tool surface is a
  // maintainer's CLAIM, not verified extraction — surfaced explicitly here
  // (in addition to the existing 'reliability/readme-sourced-tools' info
  // finding below) so a human reading the report can't miss it.
  if (card.readmeSourced) {
    lines.push(paint(33, 'Tool surface read from README catalog — not verified against source', c))
  }
  lines.push('')
  for (const d of card.dimensions) {
    // W6 (fabricated-dimension-value fix): a dimension with no measurement
    // carries score: null (see src/types.ts). Print that honestly — no
    // number, and NO BAR: an all-empty bar is visually indistinguishable
    // from a measured 0/100, which is the worst possible score, not
    // "unknown". Painted with the same amber this file already uses for
    // withheld outcomes (LIBRARY / DYNAMIC TOOL SURFACE banners above), and
    // padded to the numeric column width so the confidence column still
    // lines up.
    const body = d.score === null
      ? paint(33, `${d.id.padEnd(13)} ${'not measured'.padEnd(20)}`, c)
      : paint(colorFor(d.score), `${d.id.padEnd(13)} ${String(d.score).padStart(3)}/100  ${bar(d.score)}`, c)
    lines.push('  ' + body + `  ${d.confidence} confidence`)
  }
  const findings = card.dimensions.flatMap(d => d.findings)
  if (findings.length > 0) {
    lines.push('', 'Findings:')
    for (const f of findings) {
      lines.push(`  [${f.severity}] ${f.id} — ${f.message}`)
      lines.push(`         evidence: ${f.evidence}`)
    }
  }
  // D1 (integrity-v1): absence != clean. When no files were fetched,
  // integrityHits is undefined and we say so explicitly rather than
  // rendering nothing (which would read as "nothing to report" = clean).
  // A real scan — even a zero-hit one — always prints its denominators, so
  // "0 findings" is legible as a measurement, not a missing check.
  if (card.integrityHits === undefined) {
    lines.push('', 'Metadata Integrity: not checked — no files fetched')
  } else {
    const scanned = card.integrityScanned
    const denom = scanned ? `${scanned.files} files / ${scanned.chars} characters / ${scanned.tools} tool descriptions` : `${card.integrityHits.length} hits`
    if (card.integrityHits.length === 0) {
      lines.push('', `Metadata Integrity: 0 findings across ${denom}.`)
    } else {
      const payloads = card.integrityHits.filter(h => h.kind === 'hidden-payload')
      const observations = card.integrityHits.filter(h => h.kind !== 'hidden-payload')
      lines.push('', `Metadata Integrity: ${payloads.length} decode-confirmed payload(s), ${observations.length} observation(s) across ${denom}.`)
      for (const h of card.integrityHits) {
        const decodedPart = h.decoded ? ` → "${h.decoded}"` : ''
        lines.push(`  [${h.kind}] ${h.surface} — ${h.path}:${h.line}:${h.col} (${h.runLength} cps)${decodedPart}`)
      }
    }
  }
  if (card.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const n of card.notes) lines.push(`  - ${n}`)
  }
  lines.push('')
  return lines.join('\n')
}
