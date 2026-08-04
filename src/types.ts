export type DimensionId = 'health' | 'reliability' | 'security' | 'cost'
export type Confidence = 'high' | 'medium' | 'low'
export type Severity = 'info' | 'low' | 'medium' | 'high'
// v1.3 (V2 — library/SDK/proxy classifier, coverage-spec §3.1 + §3.6): the
// zero-tools outcome is not monolithic — a repo can be a genuine coverage
// miss (insufficientData, unchanged) OR a library/SDK ('sdk'), a repo with no
// MCP surface at all ('not-server'), a remote-proxy that registers tools only
// at runtime ('proxy'), or a distribution stub pointing at an external
// package ('stub'). See src/derive/classify.ts for the detector.
export type NotServerReason = 'sdk' | 'not-server' | 'proxy' | 'stub'

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
  score: number         // 0-100
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
  // still populated below when useful). Only ever number/string together
  // (never notServer) or null/null together (notServer) — see score.ts.
  overall: number | null       // 0-100
  grade: string | null         // 'A+' | 'A' | 'A-' | ... | 'F'
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
