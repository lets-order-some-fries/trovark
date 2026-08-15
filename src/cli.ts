#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createHttp, type Http } from './util/http.js'
import { ResolveError, resolve } from './resolver.js'
import { assemble } from './assemble.js'
import { score } from './scoring/score.js'
import { renderTerminal } from './report/terminal.js'
import { renderJson } from './report/json.js'

const GRADE_FLOOR: Record<string, number> = { A: 85, B: 70, C: 55, D: 40 }
const KNOWN_FLAGS = ['--help', '--version', '--json', '--no-color', '--fail-under'] as const

/** Levenshtein distance, capped at 3 — only used to suggest a near-miss flag. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

function nearestFlag(unknown: string): string | undefined {
  let best: string | undefined
  let bestDistance = 3
  for (const flag of KNOWN_FLAGS) {
    const d = editDistance(unknown, flag)
    if (d < bestDistance) { bestDistance = d; best = flag }
  }
  return best
}
const USAGE = `Usage: trovark <ref> [--json] [--fail-under <grade|number>] [--no-color]

<ref>: GitHub URL, owner/repo, npm package, or PyPI package name.
Set GITHUB_TOKEN for higher rate limits and issue-responsiveness signals.
Exit codes: 0 ok · 1 below --fail-under · 2 error`

export interface CliDeps { http: Http; now: Date; log: (s: string) => void; err: (s: string) => void }

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const args = [...argv]
  const has = (f: string) => {
    const i = args.indexOf(f)
    if (i === -1) return false
    args.splice(i, 1)
    return true
  }
  const valueOf = (f: string): string | undefined => {
    const i = args.indexOf(f)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }

  if (has('--help')) { deps.err(USAGE); return 2 }
  if (has('--version')) {
    // Fault hunt 2026-08-08 (MINOR): this was a hardcoded '0.1.0' literal,
    // shipped unchanged in the 0.1.7 package. Read the source of truth.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    deps.log(pkg.version)
    return 0
  }
  const json = has('--json')
  const noColor = has('--no-color')
  const failUnderPresent = args.includes('--fail-under')
  const failUnderRaw = valueOf('--fail-under')
  if (failUnderPresent && (failUnderRaw === undefined || failUnderRaw.trim() === '')) {
    deps.err('--fail-under requires a value: A, B, C, D, or a number.')
    return 2
  }
  // Everything the known-flag readers above did not consume must be a ref.
  // An unrecognized --flag is rejected rather than ignored: silently dropping
  // a mistyped --fail-under turns a CI gate into a permanent pass.
  const escapeIndex = args.indexOf('--')
  const flagCandidates = escapeIndex === -1 ? args : args.slice(0, escapeIndex)
  const unknownFlag = flagCandidates.find(a => a.startsWith('--'))
  if (unknownFlag !== undefined) {
    const suggestion = nearestFlag(unknownFlag)
    deps.err(`Unknown option "${unknownFlag}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}\n${USAGE}`)
    return 2
  }
  if (escapeIndex !== -1) args.splice(escapeIndex, 1)

  const ref = args[0]
  if (!ref) { deps.err(USAGE); return 2 }
  if (args.length > 1) {
    deps.err(`Expected one <ref>, got ${args.length}: ${args.join(', ')}.\n${USAGE}`)
    return 2
  }

  let threshold: number | undefined
  if (failUnderRaw !== undefined) {
    const n = Number(failUnderRaw)
    threshold = Number.isFinite(n) ? n : GRADE_FLOOR[failUnderRaw.toUpperCase().replace(/[+-]$/, '')]
    if (threshold === undefined) { deps.err(`Invalid --fail-under "${failUnderRaw}". Use A/B/C/D or a number.`); return 2 }
  }

  try {
    const identity = await resolve(ref, deps.http)
    const signals = await assemble(identity, deps.http, deps.now, { hasToken: Boolean(process.env.GITHUB_TOKEN) })
    const resolved = {
      ...(identity.npmPackage ? { npmPackage: identity.npmPackage } : {}),
      ...(identity.pypiPackage ? { pypiPackage: identity.pypiPackage } : {}),
      ...(identity.repo ? { repo: identity.repo } : {}),
    }
    const card = score(ref, signals, deps.now.toISOString(), Object.keys(resolved).length > 0 ? resolved : undefined)
    deps.log(json ? renderJson(card) : renderTerminal(card, { color: !noColor }))
    // W1: a repo GitHub 404s (deleted/renamed) — checked before
    // insufficientData (mutually exclusive per score.ts) so the message is
    // specific ("repository not found") rather than the generic
    // insufficient-data wording, and so --fail-under can never turn this
    // into a pass (there is no grade, period).
    if (card.unresolved) {
      deps.err(`repository not found: ${ref}`)
      return 2
    }
    if (card.insufficientData) {
      deps.err('trovark: insufficient data to score this ref')
      for (const e of signals.errors) deps.err(`  - ${e}`)
      return 2
    }
    // Fault hunt 2026-08-08 (IMPORTANT): --fail-under used to be a silent
    // no-op for a notServer/dynamic card, so a CI gate demanding "B or
    // better" PASSED on a library or an unanalyzable gateway — while the
    // sibling ungradeable states (unresolved, insufficientData) exit
    // non-zero above. Without --fail-under, exit 0 stands: notServer is a
    // correct, successful answer. Under a threshold, "no grade" can never
    // satisfy "grade >= threshold".
    if (threshold !== undefined && card.overall === null) {
      deps.err('trovark: no grade to compare against --fail-under (library / dynamic tool surface)')
      return 1
    }
    if (threshold !== undefined && card.overall !== null && card.overall < threshold) return 1
    return 0
  } catch (err) {
    if (err instanceof ResolveError) { deps.err(err.message); return 2 }
    deps.err(`trovark failed: ${(err as Error).message}`)
    return 2
  }
}

// Entry point (skipped under vitest).
if (!process.env.VITEST) {
  const deps: CliDeps = {
    http: createHttp({ githubToken: process.env.GITHUB_TOKEN }),
    now: new Date(),
    log: console.log,
    err: console.error,
  }
  main(process.argv.slice(2), deps).then(code => { process.exitCode = code })
}
