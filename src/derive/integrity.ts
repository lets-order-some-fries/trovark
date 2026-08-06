// D1 — Metadata Integrity: decode-confirmed invisible-payload detector.
// Pre-registered plan: docs/superpowers/plans/2026-08-04-integrity-v1.md
// Exact algorithms: .superpowers/sdd/threat-spec.md §2 (D1)
//
// PRECISION DISCIPLINE: every finding here is a FACT ("these N codepoints at
// this location decode to this printable ASCII text"), never a VERDICT about
// intent. Thresholds (MIN_VS_RUN, MIN_DECODED, the printable-ASCII set) are
// pre-registered and must not be tuned post-hoc against observed hits — see
// the plan doc. Findings are display-only (score.ts never reads this
// module's output), so this ships with provably zero effect on any grade.
//
// Six implementation traps honored (see threat-spec.md "Six implementation
// traps" and the integrity-v1 plan):
//  1. RepoFile.content is a decoded JS string, not bytes — codepoint ranges only.
//  2. No astral regexes — numeric codePointAt comparisons throughout.
//  3. Astral chars have ch.length === 2 — scanRuns iterates for..of and
//     accumulates ch.length so every line/col offset is correct.
//  4. SIZE_CAP truncates file content upstream — this module makes no
//     completeness claim; scanned{} only ever reports what it was given.
//  5. UPDATED (W6 review remediation item 1, M3 — .superpowers/sdd/
//     w6-review-findings.md): the root README.md/.rst IS fetched by the
//     sampler (RepoSnapshot.readme, see src/collectors/github.ts) and IS
//     scanned here by deliberate choice — it is real fetched content, and
//     this module's scan is offline/deterministic/display-only (score.ts
//     never reads its output), so there is no fabrication risk in scanning
//     it. What changed is HOW it reaches this function: quarantined off
//     RepoSnapshot.files (four of assemble.ts's other five README.md/.rst
//     consumers were written for source code and must never see it) and
//     passed here explicitly as the 3rd `readme` parameter instead, so
//     `scanned.files` stays an honest count of everything actually scanned.
//  6. extractSchema's per-tool `evidence` is threaded through so a
//     tool-surface hit can cite its source file (see schema.ts).

import type { RepoFile } from '../collectors/github.js'
import type { Finding, IntegrityHit, IntegrityEncoding, ToolInfo } from '../types.js'

// ---- PRE-REGISTERED constants — do not tune against observed corpus results ----
const VS_LO = 0xfe00, VS_HI = 0xfe0f // VS1..VS16 (Unicode category Mn)
const VSS_LO = 0xe0100, VSS_HI = 0xe01ef // VS17..VS256 (Unicode category Mn)
const TAG_LO = 0xe0000, TAG_HI = 0xe007f
const CANCEL_TAG = 0xe007f
const WAVING_BLACK_FLAG = 0x1f3f4
const BIDI1_LO = 0x202a, BIDI1_HI = 0x202e // LRE/RLE/PDF/LRO/RLO
const BIDI2_LO = 0x2066, BIDI2_HI = 0x2069 // LRI/RLI/FSI/PDI

const MIN_VS_RUN = 4 // pre-registered: measured 0.00% FPR at run>=4 on 2,133 benign files
const MIN_DECODED = 2 // pre-registered: kills accidental short decodes

const isVS = (c: number): boolean => (c >= VS_LO && c <= VS_HI) || (c >= VSS_LO && c <= VSS_HI)
const isTag = (c: number): boolean => c >= TAG_LO && c <= TAG_HI
const isBidi = (c: number): boolean => (c >= BIDI1_LO && c <= BIDI1_HI) || (c >= BIDI2_LO && c <= BIDI2_HI)
const isPrintableByte = (b: number): boolean => b === 0x09 || b === 0x0a || (b >= 0x20 && b <= 0x7e)

/** Canonical VS byte encoding: VS1..VS16 -> 0x00..0x0F, VS17..VS256 -> 0x10..0xFF. */
const vsToByte = (c: number): number => (c <= VS_HI ? c - VS_LO : c - VSS_LO + 16)

export interface IntegrityScanResult {
  hits: IntegrityHit[]
  findings: Finding[]
  scanned: { files: number; chars: number; tools: number }
}

// ---- run scanning (trap #2/#3: codepoint iteration, never UTF-16 units or regex) ----
interface Run { startUtf16: number; cps: number[]; prevCp?: number }

function scanRuns(text: string, pred: (c: number) => boolean): Run[] {
  const out: Run[] = []
  let cur: Run | null = null
  let i = 0
  let prevCp: number | undefined
  for (const ch of text) { // for..of yields CODEPOINTS, not UTF-16 units
    const c = ch.codePointAt(0)!
    if (pred(c)) {
      if (!cur) cur = { startUtf16: i, cps: [], prevCp }
      cur.cps.push(c)
    } else if (cur) {
      out.push(cur)
      cur = null
    }
    prevCp = c
    i += ch.length // 2 for astral — never assume 1 (trap #3)
  }
  if (cur) out.push(cur)
  return out
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) starts.push(i + 1)
  return starts
}

function lineColFor(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 }
}

const cpHex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`
const bytesToText = (bytes: number[]): string => bytes.map(b => String.fromCharCode(b)).join('')

/** byte decoder, then nibble-pair decoder (tried in that order, per the pre-registered plan). */
function decodeVsRun(cps: number[]): { bytes: number[]; decoded: string } | null {
  const byteBytes = cps.map(vsToByte)
  if (byteBytes.length >= MIN_DECODED && byteBytes.every(isPrintableByte)) {
    return { bytes: byteBytes, decoded: bytesToText(byteBytes) }
  }
  if (cps.length % 2 === 0 && cps.every(c => c >= VS_LO && c <= VS_HI)) {
    const pairBytes: number[] = []
    for (let i = 0; i < cps.length; i += 2) pairBytes.push(((cps[i] - VS_LO) << 4) | (cps[i + 1] - VS_LO))
    if (pairBytes.length >= MIN_DECODED && pairBytes.every(isPrintableByte)) {
      return { bytes: pairBytes, decoded: bytesToText(pairBytes) }
    }
  }
  return null
}

/** byte = cp - TAG_LO (drops the U+E007F cancel-tag terminator, which maps to non-printable 0x7F anyway). */
function decodeTagRun(cps: number[]): { bytes: number[]; decoded: string } | null {
  const bytes = cps.filter(c => c !== CANCEL_TAG).map(c => c - TAG_LO)
  if (bytes.length >= MIN_DECODED && bytes.every(isPrintableByte)) return { bytes, decoded: bytesToText(bytes) }
  return null
}

// D1b mandatory structural guard — RGI emoji tag sequences (subdivision
// flags) are the ONLY legitimate tag-block use, and exactly three exist:
// England (gbeng), Scotland (gbsct), Wales (gbwls). A structurally-shaped
// run (black flag + 3-7 tag chars + cancel tag) that does NOT decode to one
// of these three codes is not a real flag — it is a decode-confirmed hidden
// payload wearing a flag costume, and must fall through to the normal
// decode/finding path (Defect 2: the previous version suppressed ANY
// structural match, which is trivially evadable — encode an arbitrary
// <=6-char payload as tag chars, wrap it in the black flag + cancel tag,
// and it vanished with zero hits).
const RGI_SUBDIVISION_TAG_CODES = new Set(['gbeng', 'gbsct', 'gbwls'])

function isEmojiTagSequence(run: Run): boolean {
  if (run.prevCp !== WAVING_BLACK_FLAG) return false
  if (run.cps.length < 3 || run.cps.length > 7) return false
  const last = run.cps[run.cps.length - 1]
  if (last !== CANCEL_TAG) return false
  const interior = run.cps.slice(0, -1)
  if (!interior.every(c => c >= 0xe0020 && c <= 0xe007e)) return false
  const decoded = interior.map(c => String.fromCharCode(c - TAG_LO)).join('')
  return RGI_SUBDIVISION_TAG_CODES.has(decoded)
}

const BANNED_WORDS = /malicious|backdoor|attack|poisoned|typosquat/i

// Dev-time template lint ONLY. This must be called exclusively on STATIC
// message-template text authored by us in this file — NEVER on interpolated
// scan output (decoded payloads, tool names, surfaces, paths). Those come
// from attacker-controlled content and this scanner's entire purpose is to
// catch attacker-controlled content that says things like "attack" —
// running this assertion against it turns the detector into a self-inflicted
// denial of service (Defect 1: a payload decoding to "attack now" used to
// throw, discarding every other finding accumulated in the same scanIntegrity
// call, and the caller's catch-block then reported "not checked").
function assertNoVerdictLanguage(template: string): string {
  if (BANNED_WORDS.test(template)) throw new Error(`integrity.ts: finding message template must state fact only, not a verdict: "${template}"`)
  return template
}

function payloadFinding(encoding: IntegrityEncoding, surface: string, path: string, line: number, col: number, cps: number[], decoded: string): Finding {
  const kind = encoding === 'variation-selector' ? 'variation-selector' : 'tag-block'
  // The lint runs ONLY on this static prefix/suffix (kind and cps.length are
  // internal values, never attacker-controlled). `surface` and `decoded` are
  // concatenated in afterward, clearly delimited in quotes, and are exempt
  // from the lint by construction — they can never reach assertNoVerdictLanguage.
  const prefix = assertNoVerdictLanguage(`contains a ${cps.length}-character ${kind} sequence that renders as nothing but decodes to printable ASCII: `)
  const suffix = assertNoVerdictLanguage(
    '. This is a decode-confirmed invisible-payload encoding — codepoints at a location that decode to text, never a judgement about intent.',
  )
  const message = `${surface} ${prefix}"${decoded}"${suffix}`
  return {
    id: 'security/hidden-payload', dimension: 'security', severity: 'high', message,
    evidence: `${path}:${line}:${col} — ${cps.map(cpHex).join(',')} (${cps.length} cps) → "${decoded}"`,
  }
}

function observedFinding(encoding: IntegrityEncoding, surface: string, path: string, line: number, col: number, cps: number[]): Finding {
  const kind = encoding === 'variation-selector' ? 'variation-selector' : 'tag-block'
  return {
    id: 'security/invisible-chars-observed', dimension: 'security', severity: 'info',
    message: `${surface} contains a run of ${cps.length} ${kind} codepoints that does not decode to printable ASCII. This is an observation, not a payload.`,
    evidence: `${path}:${line}:${col} — ${cps.map(cpHex).join(',')} (${cps.length} cps)`,
  }
}

function bidiFinding(surface: string, path: string, line: number, col: number, cps: number[]): Finding {
  return {
    id: 'security/bidi-override-observed', dimension: 'security', severity: 'info',
    message: `${surface} contains ${cps.length} bidirectional text-override codepoint(s) (U+202A-202E / U+2066-2069). `
      + 'This is an observation, not a payload — bidi overrides can change how text renders but carry no decoded payload.',
    evidence: `${path}:${line}:${col} — ${cps.map(cpHex).join(',')} (${cps.length} cps)`,
  }
}

function scanText(text: string, path: string, surface: string): { hits: IntegrityHit[]; findings: Finding[] } {
  const hits: IntegrityHit[] = []
  const findings: Finding[] = []
  const starts = lineStarts(text)

  for (const run of scanRuns(text, isVS)) {
    if (run.cps.length < MIN_VS_RUN) continue // below threshold: emit nothing at all, not even an observation
    const { line, col } = lineColFor(starts, run.startUtf16)
    const decoded = decodeVsRun(run.cps)
    if (decoded) {
      hits.push({ kind: 'hidden-payload', encoding: 'variation-selector', surface, path, line, col, runLength: run.cps.length, codepoints: run.cps, decoded: decoded.decoded })
      findings.push(payloadFinding('variation-selector', surface, path, line, col, run.cps, decoded.decoded))
    } else {
      hits.push({ kind: 'invisible-chars-observed', encoding: 'variation-selector', surface, path, line, col, runLength: run.cps.length, codepoints: run.cps })
      findings.push(observedFinding('variation-selector', surface, path, line, col, run.cps))
    }
  }

  for (const run of scanRuns(text, isTag)) {
    if (run.cps.length < MIN_VS_RUN) continue
    if (isEmojiTagSequence(run)) continue // legitimate RGI emoji tag sequence flag — must never fire
    const { line, col } = lineColFor(starts, run.startUtf16)
    const decoded = decodeTagRun(run.cps)
    if (decoded) {
      hits.push({ kind: 'hidden-payload', encoding: 'tag-block', surface, path, line, col, runLength: run.cps.length, codepoints: run.cps, decoded: decoded.decoded })
      findings.push(payloadFinding('tag-block', surface, path, line, col, run.cps, decoded.decoded))
    } else {
      hits.push({ kind: 'invisible-chars-observed', encoding: 'tag-block', surface, path, line, col, runLength: run.cps.length, codepoints: run.cps })
      findings.push(observedFinding('tag-block', surface, path, line, col, run.cps))
    }
  }

  // D1c: bidi overrides are ALWAYS an observation, never a payload — no
  // decode step, no run-length threshold (a single override is already a
  // structurally meaningful fact, e.g. the classic RLO filename spoof).
  for (const run of scanRuns(text, isBidi)) {
    const { line, col } = lineColFor(starts, run.startUtf16)
    hits.push({ kind: 'bidi-override-observed', encoding: 'bidi-override', surface, path, line, col, runLength: run.cps.length, codepoints: run.cps })
    findings.push(bidiFinding(surface, path, line, col, run.cps))
  }

  return { hits, findings }
}

// Defense-in-depth for Defect 1: scanIntegrity is called inside assemble()
// alongside other collectors, and a thrown error there is swallowed into
// s.errors, discarding every finding accumulated in the SAME call and making
// the report falsely claim "not checked". The root cause (the verdict-
// language lint touching attacker-controlled text) is fixed above, but this
// module's entire reason to exist is processing attacker-controlled input —
// so scanning one field/file must never be able to take the whole scan down.
// On any unexpected error, that one field/file simply contributes zero hits.
function safeScanText(text: string, path: string, surface: string): { hits: IntegrityHit[]; findings: Finding[] } {
  try {
    return scanText(text, path, surface)
  } catch {
    return { hits: [], findings: [] }
  }
}

type ToolField = 'name' | 'description' | 'schemaText'

function toolFieldLocator(tool: ToolInfo & { evidence?: string }, field: ToolField): { path: string; surface: string } {
  const label = field === 'schemaText' ? 'schema' : field
  const path = tool.evidence ? `${tool.evidence}#${field}` : `tool:${tool.name}#${field}`
  return { path, surface: `Tool "${tool.name}" ${label}` }
}

/**
 * scanIntegrity — pure, offline, deterministic. Scans four surfaces per the
 * pre-registered plan: each tool's name/description/schemaText, plus every
 * fetched file's content (including the root README, when the caller passes
 * one — see trap #5 above). Never claims completeness: `files`/`tools`/
 * `readme` are exactly what the caller fetched/extracted (see SIZE_CAP and
 * selectRepoFiles in src/collectors/github.ts — this module has no
 * knowledge of what was skipped).
 */
export function scanIntegrity(
  files: RepoFile[], tools: Array<ToolInfo & { evidence?: string }>,
  // W6 review remediation item 1: the quarantined root README, passed
  // EXPLICITLY (never implicitly via `files`) so this module's own
  // `scanned.files` denominator can count it honestly when present, the
  // same discipline assemble.ts's README rung already applies to
  // extractSchema's 4th parameter.
  readme?: RepoFile,
): IntegrityScanResult {
  const hits: IntegrityHit[] = []
  const findings: Finding[] = []
  let chars = 0

  for (const tool of tools) {
    const fields: Array<[ToolField, string | undefined]> = [
      ['name', tool.name], ['description', tool.description], ['schemaText', tool.schemaText],
    ]
    for (const [field, text] of fields) {
      if (!text) continue
      chars += text.length
      const { path, surface } = toolFieldLocator(tool, field)
      const r = safeScanText(text, path, surface)
      hits.push(...r.hits)
      findings.push(...r.findings)
    }
  }

  const scannedFiles = readme ? [...files, readme] : files
  for (const f of scannedFiles) {
    chars += f.content.length
    const r = safeScanText(f.content, f.path, `File "${f.path}"`)
    hits.push(...r.hits)
    findings.push(...r.findings)
  }

  return { hits, findings, scanned: { files: scannedFiles.length, chars, tools: tools.length } }
}

// ---- exported for index/audit.ts (corpus-measurement harness only) ----
// Pure re-exports of the constants/primitives already defined above — no new
// logic, no threshold change. The audit harness needs to record EVERY run at
// length >= 1 (not just the >= MIN_VS_RUN hits scanText emits) for ship-gate
// G3's near-miss review, and to explain guarded run >= MIN_VS_RUN sequences
// (e.g. RGI emoji tag-sequence flags) for ship-gate G1 — reusing these exact
// functions guarantees zero drift between what ships and what's measured.
export const AUDIT_THRESHOLDS = {
  minVsRun: MIN_VS_RUN,
  minDecoded: MIN_DECODED,
  vsRanges: [[VS_LO, VS_HI], [VSS_LO, VSS_HI]] as const,
  tagRange: [TAG_LO, TAG_HI] as const,
  cancelTag: CANCEL_TAG,
  bidiRanges: [[BIDI1_LO, BIDI1_HI], [BIDI2_LO, BIDI2_HI]] as const,
  printableSet: '0x09, 0x0A, 0x20-0x7E',
  decoders: ['byte', 'nibble-pair'] as const,
}
export { isVS, isTag, isBidi, scanRuns, lineStarts, lineColFor, decodeVsRun, decodeTagRun, isEmojiTagSequence, cpHex, assertNoVerdictLanguage }
export type { Run }
