export type DimensionId = 'health' | 'reliability' | 'security' | 'cost'
export type Confidence = 'high' | 'medium' | 'low'
export type Severity = 'info' | 'low' | 'medium' | 'high'

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
  overall: number       // 0-100
  grade: string         // 'A+' | 'A' | 'A-' | ... | 'F'
  dimensions: DimensionScore[]
  notes: string[]
  generatedAt: string   // ISO string, passed in by caller (determinism)
}
