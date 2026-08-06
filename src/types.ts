export type DimensionId = 'health' | 'reliability' | 'security' | 'cost'
export type Confidence = 'high' | 'medium' | 'low'
export type Severity = 'info' | 'low' | 'medium' | 'high'
// v1.3 (V2 — library/SDK/proxy classifier, coverage-spec §3.1 + §3.6): the
// zero-tools outcome is not monolithic — a repo can be a genuine coverage
// miss (insufficientData, unchanged) OR a library/SDK ('sdk'), a repo with no
// MCP surface at all ('not-server'), a remote-proxy that registers tools only
// at runtime ('proxy'), or a distribution stub pointing at an external
// package ('stub'). See src/derive/classify.ts for the detector.
// W6 (coverage-v1.5, wave2-spec §1a): 'dynamic' added — a REAL MCP server
// (not a library, not a stub) whose tool list is built at runtime from
// upstream servers or a DB and therefore has no static surface to grade
// (duaraghav8/MCPJungle). Distinct from every reason above: those describe
// "there is nothing here to check"; 'dynamic' describes "there is a real
// server here, but its surface is unknowable from source alone" — see
// src/derive/dynamic.ts. Reuses the SAME notServer/notServerReason plumbing
// (score.ts nulls overall/grade for it exactly like the others) but is
// rendered with its own distinct label everywhere a human reads it
// (report/terminal.ts, index/site.ts) and counted in its own IndexStats
// counter (index/scan.ts) rather than folded into "library / not a server".
export type NotServerReason = 'sdk' | 'not-server' | 'proxy' | 'stub' | 'dynamic'

export interface Finding {
  id: string            // e.g. 'security/shell-exec-tool'
  dimension: DimensionId
  severity: Severity
  message: string       // one plain sentence
  evidence: string      // URL or repo-relative path a skeptic can check
}

export interface ToolInfo {
  name: string
  description?: string
  schemaText: string    // raw extracted source/manifest slice for this tool
}

// D1 (integrity-v1, docs/superpowers/plans/2026-08-04-integrity-v1.md): a
// decode-confirmed invisible-payload hit, or a lower-severity observation (a
// qualifying run that didn't decode, or a bidi override — never called a
// payload). Every field exists so a third party can independently re-derive
// the finding from published evidence alone (ship gate G2).
export type IntegrityKind = 'hidden-payload' | 'invisible-chars-observed' | 'bidi-override-observed'
export type IntegrityEncoding = 'variation-selector' | 'tag-block' | 'bidi-override'

export interface IntegrityHit {
  kind: IntegrityKind
  encoding: IntegrityEncoding
  surface: string          // human label: which tool/field, or which file
  path: string              // evidence locator: file path, or '<sourceFile-or-tool>#<field>'
  line: number               // 1-based, within the scanned text (see src/derive/integrity.ts)
  col: number                 // 1-based UTF-16 column of the run's first codepoint
  runLength: number
  codepoints: number[]
  decoded?: string            // present only when kind === 'hidden-payload'
}

export interface Signals {
  // health
  daysSinceLastCommit?: number
  daysSinceLastRelease?: number
  commitsLast90Days?: number
  busFactor?: number
  medianIssueResponseDays?: number
  stars?: number
  weeklyDownloads?: number
  archived?: boolean
  // reliability
  specEra?: 'modern' | 'legacy'
  hasCI?: boolean
  hasTests?: boolean
  hasLockfile?: boolean
  schemaExtracted?: boolean
  // W6 review remediation item M2 (.superpowers/sdd/w6-review-findings.md):
  // a README-sourced tool surface is a maintainer's CLAIM, not verified
  // extraction — previously carried only by `schemaExtracted=false`
  // (indistinguishable from "extraction failed") plus one info finding.
  // This is the structured, machine-readable version of that fact, threaded
  // through to Scorecard and IndexEntry so a JSON consumer (and a human, via
  // report/terminal.ts and index/site.ts) can tell claimed-from-README apart
  // from extracted-from-code without parsing findings. Set (true or false)
  // whenever schema extraction ran at all; stays undefined when it never ran
  // (no repo tree — same "absence != a known value" discipline as every
  // other conditionally-set Signals field here).
  readmeSourced?: boolean
  // security
  toolSurfaceRisk?: 'none' | 'low' | 'medium' | 'high'
  secretsFound?: number
  cveWorst?: 'none' | 'low' | 'medium' | 'high' | 'critical'
  // D2 (integrity-phase2, docs/superpowers/plans/2026-08-04-integrity-v1.md
  // "Phase 2"): count of DECODE-CONFIRMED 'hidden-payload' hits only — never
  // 'invisible-chars-observed' or 'bidi-override-observed' observations,
  // which must never influence scoring. Absence != zero: this stays
  // undefined (not 0) whenever integrity wasn't checked, so score.ts's
  // disqualifying override (see src/scoring/score.ts) provably cannot fire
  // on a server we never scanned.
  hiddenPayloadDecoded?: number
  // cost
  schemaTokenEstimate?: number
  toolCount?: number
  // meta
  findings: Finding[]
  errors: string[]      // human-readable collector failures
  // V2: library/SDK/proxy/stub classification — only ever set when the
  // zero-tools guard let classifyLibrary run (see assemble.ts). Carried
  // through to score.ts so it can produce the distinct notServer Scorecard
  // outcome instead of insufficientData.
  notServer?: boolean
  notServerReason?: NotServerReason
  notServerNote?: string
  // W1 (coverage-v1.4): the GitHub repo could not be resolved at all (404 on
  // repo metadata — deleted/renamed/never existed), distinct from notServer
  // (we DID read it and it's a library) and from a generic insufficientData
  // miss (we read it but couldn't extract enough). Set by assemble.ts when
  // collectGithub throws RepoNotFoundError; carried through to Scorecard so
  // score.ts can null overall/grade the same way it does for notServer.
  unresolved?: boolean
  // D1 (integrity-v1): decode-confirmed invisible-payload hits across tool
  // metadata + fetched files. Absence != clean — this stays undefined
  // (never []) when no files were fetched (snap.treePaths absent), so
  // report/terminal.ts can print "not checked" instead of a false "clean".
  // A real scan, even a clean one, always sets integrityScanned too.
  integrityHits?: IntegrityHit[]
  integrityScanned?: { files: number; chars: number; tools: number }
}

export interface DimensionScore {
  id: DimensionId
  // W6 (fabricated-dimension-value fix): null when the dimension has NO
  // measurement — either zero collectible signals (Rule A) or, for security,
  // an absent PRIMARY tool-surface signal (Rule B). It is never 0 in those
  // cases: 0 is the WORST possible score, and publishing it as a measurement
  // is exactly the fabrication the coverage gate exists to prevent. Consumers
  // must render/aggregate null as "no measurement", never coerce it to a
  // number — see report/terminal.ts, index/scan.ts and index/site.ts.
  score: number | null  // 0-100, or null when not measured
  confidence: Confidence
  available: number     // signals computable
  total: number         // signals defined
  findings: Finding[]
}

export interface Scorecard {
  ref: string
  rubricVersion: string
  // D1 (integrity-v1): records which check set produced this card, distinct
  // from rubricVersion (which means "the version that GRADED it" — nothing
  // integrity-related grades anything; findings are display-only).
  checksVersion?: string
  integrityHits?: IntegrityHit[]
  integrityScanned?: { files: number; chars: number; tools: number }
  // I9: null when notServer — a library/SDK/proxy/stub has no tool surface
  // to grade, so no headline score/letter grade is reported (dimensions are
  // still populated below when useful).
  // W1: null when unresolved — the repo 404s, nothing was ever fetched.
  // W6 (false-published-claim fix): null when insufficientData too. A
  // withheld grade must be withheld in the DATA, not merely hidden by the
  // renderer — previously these fields stayed populated and a "grade": "A"
  // shipped in `trovark --json` and index/results.json for servers the gate
  // had explicitly declined to assess. All three withheld terminal states now
  // go through ONE `withheld` computation in score.ts.
  // Invariant: number/string together (graded) or null/null together
  // (withheld) — never one without the other.
  overall: number | null       // 0-100, null when withheld
  grade: string | null         // 'A+' | 'A' | 'A-' | ... | 'F', null when withheld
  // W6 review remediation item M2: structured passthrough of
  // Signals.readmeSourced — see that field's comment for the full
  // rationale. Undefined when extraction never ran at all.
  readmeSourced?: boolean
  dimensions: DimensionScore[]
  notes: string[]
  generatedAt: string   // ISO string, passed in by caller (determinism)
  insufficientData: boolean
  resolved?: { npmPackage?: string; pypiPackage?: string; repo?: { owner: string; name: string } }
  // V2: a distinct terminal state — NOT the same as insufficientData. Set
  // when classifyLibrary (src/derive/classify.ts) identified the repo as a
  // library/SDK/proxy/stub rather than a genuinely un-parseable server.
  notServer?: boolean
  notServerReason?: NotServerReason
  // W1: a distinct terminal state — the GitHub repo 404s (deleted/renamed/
  // never existed), so there is nothing to grade. Mutually exclusive with
  // notServer/insufficientData in practice (see score.ts). overall/grade are
  // null, exactly like notServer — see the I9 note above.
  unresolved?: boolean
}
