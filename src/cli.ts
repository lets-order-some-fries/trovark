#!/usr/bin/env node
import { createHttp, type Http } from './util/http.js'
import { ResolveError, resolve } from './resolver.js'
import { assemble } from './assemble.js'
import { score } from './scoring/score.js'
import { renderTerminal } from './report/terminal.js'
import { renderJson } from './report/json.js'

const GRADE_FLOOR: Record<string, number> = { A: 85, B: 70, C: 55, D: 40 }
const USAGE = `Usage: mcpscore <ref> [--json] [--fail-under <grade|number>] [--no-color]

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
  if (has('--version')) { deps.log('0.1.0'); return 0 }
  const json = has('--json')
  const noColor = has('--no-color')
  const failUnderRaw = valueOf('--fail-under')
  const ref = args[0]
  if (!ref) { deps.err(USAGE); return 2 }

  let threshold: number | undefined
  if (failUnderRaw !== undefined) {
    const n = Number(failUnderRaw)
    threshold = Number.isFinite(n) ? n : GRADE_FLOOR[failUnderRaw.toUpperCase().replace(/[+-]$/, '')]
    if (threshold === undefined) { deps.err(`Invalid --fail-under "${failUnderRaw}". Use A/B/C/D or a number.`); return 2 }
  }

  try {
    const identity = await resolve(ref, deps.http)
    const signals = await assemble(identity, deps.http, deps.now, { hasToken: Boolean(process.env.GITHUB_TOKEN) })
    const parts: string[] = []
    if (identity.npmPackage) parts.push(`npm:${identity.npmPackage}`)
    if (identity.pypiPackage) parts.push(`pypi:${identity.pypiPackage}`)
    if (identity.repo) parts.push(`github.com/${identity.repo.owner}/${identity.repo.name}`)
    const displayRef = parts.length > 0 ? `${ref}  →  ${parts.join(' · ')}` : ref
    const card = score(displayRef, signals, deps.now.toISOString())
    deps.log(json ? renderJson(card) : renderTerminal(card, { color: !noColor }))
    if (threshold !== undefined && card.overall < threshold) return 1
    return 0
  } catch (err) {
    if (err instanceof ResolveError) { deps.err(err.message); return 2 }
    deps.err(`mcpscore failed: ${(err as Error).message}`)
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
