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
