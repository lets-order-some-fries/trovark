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
  lines.push(`mcpscore  ·  ${card.ref}`)
  if (card.resolved) {
    const parts: string[] = []
    if (card.resolved.npmPackage) parts.push(`npm:${card.resolved.npmPackage}`)
    if (card.resolved.pypiPackage) parts.push(`pypi:${card.resolved.pypiPackage}`)
    if (card.resolved.repo) parts.push(`github.com/${card.resolved.repo.owner}/${card.resolved.repo.name}`)
    if (parts.length > 0) lines.push(`  resolved: ${parts.join(' · ')}`)
  }
  if (card.insufficientData) {
    lines.push(paint(31, 'Trust Score: INSUFFICIENT DATA', c) + `   rubric v${card.rubricVersion}`)
  } else {
    lines.push(paint(colorFor(card.overall), `Trust Score: ${card.overall}/100 (${card.grade})`, c) + `   rubric v${card.rubricVersion}`)
  }
  lines.push('')
  for (const d of card.dimensions) {
    lines.push(
      '  ' + paint(colorFor(d.score), `${d.id.padEnd(13)} ${String(d.score).padStart(3)}/100  ${bar(d.score)}`, c)
      + `  ${d.confidence} confidence`,
    )
  }
  const findings = card.dimensions.flatMap(d => d.findings)
  if (findings.length > 0) {
    lines.push('', 'Findings:')
    for (const f of findings) {
      lines.push(`  [${f.severity}] ${f.id} — ${f.message}`)
      lines.push(`         evidence: ${f.evidence}`)
    }
  }
  if (card.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const n of card.notes) lines.push(`  - ${n}`)
  }
  lines.push('')
  return lines.join('\n')
}
