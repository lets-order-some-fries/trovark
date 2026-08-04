// index/audit.ts — corpus-wide MEASUREMENT harness for the D1 metadata-
// integrity detector (src/derive/integrity.ts). NO SCORING: this tool only
// measures and records; ship gates (G1/G3/G5) are evaluated by a human from
// its output. See docs/superpowers/plans/2026-08-04-integrity-v1.md and
// .superpowers/sdd/threat-spec.md §4 (measurement plan).
//
// Pipeline per ref (mirrors index/scan.ts's pool()/ref-loading, minus
// scoring): resolve -> collectGithub -> extractSchema -> scanIntegrity.
//
// scanIntegrity's own MIN_VS_RUN gate only emits hits at run >= 4. This
// harness ALSO records every run at length >= 1 (the near-miss data ship
// gate G3 requires), reusing integrity.ts's exact exported primitives
// (scanRuns/isVS/isTag/isBidi/decode*/isEmojiTagSequence) so there is zero
// drift between what ships and what's measured here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'
import { resolve, ResolveError } from '../src/resolver.js'
import { collectGithub, RepoNotFoundError, type RepoFile } from '../src/collectors/github.js'
import { extractSchema } from '../src/derive/schema.js'
import {
  scanIntegrity, AUDIT_THRESHOLDS, isVS, isTag, isBidi, scanRuns, lineStarts, lineColFor,
  decodeVsRun, decodeTagRun, isEmojiTagSequence, cpHex,
} from '../src/derive/integrity.js'
import type { ToolInfo } from '../src/types.js'

const CONTEXT_RADIUS = 120

// ---- context escaping: render invisible/format/control codepoints as \u{...} escapes so ±120-char context stays human-readable ----
const CF_RE = /\p{Cf}/u
const CC_RE = /\p{Cc}/u

function escapeInvisibles(text: string): string {
  let out = ''
  for (const ch of text) { // for..of yields codepoints, not UTF-16 units (astral-safe, per integrity.ts trap #2/#3)
    const c = ch.codePointAt(0)!
    const isTargetInvisible = isVS(c) || isTag(c) || isBidi(c)
    const isFormatOrControl = CF_RE.test(ch) || (CC_RE.test(ch) && c !== 0x09 && c !== 0x0a && c !== 0x0d)
    out += isTargetInvisible || isFormatOrControl ? `\\u{${c.toString(16).toUpperCase()}}` : ch
  }
  return out
}

function utf16Length(cps: number[]): number {
  return cps.reduce((n, c) => n + (c > 0xffff ? 2 : 1), 0) // astral cps are 2 UTF-16 units (trap #3)
}

function contextAround(text: string, startUtf16: number, cps: number[]): string {
  const from = Math.max(0, startUtf16 - CONTEXT_RADIUS)
  const to = Math.min(text.length, startUtf16 + utf16Length(cps) + CONTEXT_RADIUS)
  return escapeInvisibles(text.slice(from, to))
}

// ---- Cf-category histogram: what a blanket Cf/Cc rule WOULD have flagged — methodology-page evidence, never a finding ----
function tallyCfHits(text: string, tally: Map<string, number>): void {
  for (const ch of text) {
    if (CF_RE.test(ch)) {
      const key = cpHex(ch.codePointAt(0)!)
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
  }
}

interface AuditHit {
  ref: string
  surface: string
  path: string
  line: number
  col: number
  runLength: number
  codepoints: string[] // hex list, e.g. ["U+FE00", ...]
  decoded: string | null
  decodeOk: boolean
  kind: 'vs' | 'tag' | 'bidi'
  // tag runs only: true if the SHIPPED detector's isEmojiTagSequence guard
  // would exclude this exact run (RGI emoji subdivision-flag tag sequence) —
  // load-bearing context for G1: a run>=4 decode-confirmed hit with this
  // true is explained-by-construction, not "unexplained".
  emojiTagGuard?: boolean
  context: string // +/-120 chars around the run, invisible codepoints rendered as \u{...} escapes
}

function auditRunsFor(text: string, path: string, surface: string, ref: string, cfTally: Map<string, number>): AuditHit[] {
  const hits: AuditHit[] = []
  const starts = lineStarts(text)
  tallyCfHits(text, cfTally)

  for (const run of scanRuns(text, isVS)) {
    const { line, col } = lineColFor(starts, run.startUtf16)
    const decoded = decodeVsRun(run.cps)
    hits.push({
      ref, surface, path, line, col, runLength: run.cps.length,
      codepoints: run.cps.map(cpHex), decoded: decoded?.decoded ?? null, decodeOk: decoded !== null,
      kind: 'vs', context: contextAround(text, run.startUtf16, run.cps),
    })
  }

  for (const run of scanRuns(text, isTag)) {
    const { line, col } = lineColFor(starts, run.startUtf16)
    const decoded = decodeTagRun(run.cps)
    hits.push({
      ref, surface, path, line, col, runLength: run.cps.length,
      codepoints: run.cps.map(cpHex), decoded: decoded?.decoded ?? null, decodeOk: decoded !== null,
      kind: 'tag', emojiTagGuard: isEmojiTagSequence(run), context: contextAround(text, run.startUtf16, run.cps),
    })
  }

  // D1c mirror: bidi overrides carry no decode step and no run-length floor
  // in the shipped detector either — every run (including a single
  // override) is already "run >= 1" by construction.
  for (const run of scanRuns(text, isBidi)) {
    const { line, col } = lineColFor(starts, run.startUtf16)
    hits.push({
      ref, surface, path, line, col, runLength: run.cps.length,
      codepoints: run.cps.map(cpHex), decoded: null, decodeOk: false,
      kind: 'bidi', context: contextAround(text, run.startUtf16, run.cps),
    })
  }

  return hits
}

type ToolField = 'name' | 'description' | 'schemaText'

// Mirrors integrity.ts's private toolFieldLocator exactly (path/surface
// formatting only — no detection logic — so duplicating it here carries no
// drift risk).
function toolFieldLocator(tool: ToolInfo & { evidence?: string }, field: ToolField): { path: string; surface: string } {
  const label = field === 'schemaText' ? 'schema' : field
  const path = tool.evidence ? `${tool.evidence}#${field}` : `tool:${tool.name}#${field}`
  return { path, surface: `Tool "${tool.name}" ${label}` }
}

function auditRef(ref: string, files: RepoFile[], tools: Array<ToolInfo & { evidence?: string }>, cfTally: Map<string, number>): AuditHit[] {
  const hits: AuditHit[] = []
  for (const tool of tools) {
    const fields: Array<[ToolField, string | undefined]> = [
      ['name', tool.name], ['description', tool.description], ['schemaText', tool.schemaText],
    ]
    for (const [field, text] of fields) {
      if (!text) continue
      const { path, surface } = toolFieldLocator(tool, field)
      hits.push(...auditRunsFor(text, path, surface, ref, cfTally))
    }
  }
  for (const f of files) hits.push(...auditRunsFor(f.content, f.path, `File "${f.path}"`, ref, cfTally))
  return hits
}

// ---- histograms ----
type RunBucket = '1' | '2' | '3' | '4+'
const bucketOf = (n: number): RunBucket => (n >= 4 ? '4+' : (String(n) as RunBucket))

interface Histograms {
  runLength: Record<'vs' | 'tag' | 'bidi', Record<RunBucket, number>>
  cfCodepoints: Record<string, number> // Cf-category codepoint -> occurrence count across the full corpus (methodology evidence; never a finding)
}

function buildHistograms(hits: AuditHit[], cfTally: Map<string, number>): Histograms {
  const empty = (): Record<RunBucket, number> => ({ '1': 0, '2': 0, '3': 0, '4+': 0 })
  const runLength = { vs: empty(), tag: empty(), bidi: empty() }
  for (const h of hits) runLength[h.kind][bucketOf(h.runLength)]++
  const cfCodepoints = Object.fromEntries([...cfTally.entries()].sort((a, b) => b[1] - a[1]))
  return { runLength, cfCodepoints }
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

type RefStatus = 'ok' | 'no-files' | 'unresolved' | 'error'

interface RefResult {
  ref: string
  status: RefStatus
  error?: string
  hits: AuditHit[]
  scanned: { files: number; chars: number; tools: number }
}

const zeroScanned = { files: 0, chars: 0, tools: 0 }

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const inFile = arg('--in', 'index/servers.json')
  const outFile = arg('--out', `index/audit/integrity-${today}.json`)
  const limit = Number(arg('--limit', '0'))
  const concurrency = Number(arg('--concurrency', '4'))
  const hasToken = Boolean(process.env.GITHUB_TOKEN)
  const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })
  const now = new Date()

  let refs: string[] = (JSON.parse(readFileSync(inFile, 'utf8')) as { refs: string[] }).refs
  if (limit > 0) refs = refs.slice(0, limit)

  const cfTally = new Map<string, number>()
  let done = 0
  const results = await pool(refs, concurrency, async (ref): Promise<RefResult> => {
    try {
      const identity = await resolve(ref, http)
      if (!identity.repo) return { ref, status: 'no-files', hits: [], scanned: zeroScanned }

      const snap = await collectGithub(identity, http, now, { hasToken })
      if (!snap.treePaths) return { ref, status: 'no-files', hits: [], scanned: zeroScanned } // absence != clean, same discipline as assemble.ts

      const schema = extractSchema(snap.files, snap.treePaths, snap.toolFanoutCount)
      // "official" run>=4-gated scan — reused ONLY for its scanned{} denominators (files/chars/tools),
      // guaranteeing they match exactly what the shipped detector would report for this repo.
      const official = scanIntegrity(snap.files, schema.tools)
      const hits = auditRef(ref, snap.files, schema.tools, cfTally)
      return { ref, status: 'ok', hits, scanned: official.scanned }
    } catch (err) {
      if (err instanceof RepoNotFoundError || err instanceof ResolveError) {
        return { ref, status: 'unresolved', error: (err as Error).message, hits: [], scanned: zeroScanned }
      }
      return { ref, status: 'error', error: (err as Error).message, hits: [], scanned: zeroScanned }
    } finally {
      done++
      if (done % 10 === 0 || done === refs.length) console.error(`audited ${done}/${refs.length}`)
    }
  })

  const allHits = results.flatMap(r => r.hits)
  const histograms = buildHistograms(allHits, cfTally)

  const reposScanned = results.length
  const reposWithFiles = results.filter(r => r.status === 'ok').length
  const filesScanned = results.reduce((n, r) => n + r.scanned.files, 0)
  const charsScanned = results.reduce((n, r) => n + r.scanned.chars, 0)
  const toolsScanned = results.reduce((n, r) => n + r.scanned.tools, 0)

  const unresolvedRefs = results.filter(r => r.status === 'unresolved').map(r => ({ ref: r.ref, error: r.error }))
  const noFilesRefs = results.filter(r => r.status === 'no-files').map(r => r.ref)
  const errorRefs = results.filter(r => r.status === 'error').map(r => ({ ref: r.ref, error: r.error }))

  const payload = {
    generatedAt: now.toISOString(),
    // src/scoring/score.ts's Scorecard.checksVersion for this detector generation — kept in sync manually (D1 ships as 1.0.0).
    checksVersion: '1.0.0',
    thresholds: AUDIT_THRESHOLDS, // self-describing: the exact constants in force for this run (re-exported from src/derive/integrity.ts, not duplicated)
    denominators: { reposScanned, reposWithFiles, filesScanned, charsScanned, toolsScanned },
    counts: {
      unresolved: unresolvedRefs.length,
      noFiles: noFilesRefs.length,
      errors: errorRefs.length,
      hitsTotal: allHits.length,
      hitsAtRunGte4: allHits.filter(h => h.runLength >= 4).length,
      decodeConfirmedAtRunGte4: allHits.filter(h => h.runLength >= 4 && h.decodeOk).length,
    },
    histograms,
    unresolvedRefs,
    noFilesRefs,
    errorRefs,
    hits: allHits,
  }

  mkdirSync('index/audit', { recursive: true })
  writeFileSync(outFile, JSON.stringify(payload, null, 2))
  console.error(
    `wrote ${outFile}: ${reposScanned} refs (${reposWithFiles} with files), ${filesScanned} files, `
    + `${charsScanned} chars, ${toolsScanned} tools scanned; ${allHits.length} hits at run>=1, `
    + `${payload.counts.decodeConfirmedAtRunGte4} decode-confirmed at run>=4; `
    + `${unresolvedRefs.length} unresolved, ${errorRefs.length} errors`,
  )
}

if (process.argv[1]?.endsWith('audit.ts')) await main()
