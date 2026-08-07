import type { DimensionId, Signals } from '../types.js'

export const RUBRIC_VERSION = '1.6.0'

export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  health: 0.35,
  reliability: 0.25,
  security: 0.25,
  cost: 0.15,
}

export interface SignalDef {
  key: string
  dimension: DimensionId
  weight: number
  /** Returns 0..1, or undefined when the signal could not be collected. */
  evaluate: (s: Signals) => number | undefined
}

/** Step down through [threshold, value] pairs; `fallback` when above all thresholds. */
function band(v: number | undefined, table: Array<[number, number]>, fallback: number): number | undefined {
  if (v === undefined) return undefined
  for (const [limit, val] of table) if (v <= limit) return val
  return fallback
}

export const SIGNALS: SignalDef[] = [
  // ---- health (35%) ----
  { key: 'commit-recency', dimension: 'health', weight: 3,
    evaluate: s => band(s.daysSinceLastCommit, [[30, 1], [90, 0.7], [180, 0.4], [365, 0.15]], 0) },
  { key: 'commit-activity', dimension: 'health', weight: 2,
    evaluate: s => s.commitsLast90Days === undefined ? undefined
      : s.commitsLast90Days >= 20 ? 1 : s.commitsLast90Days >= 5 ? 0.7 : s.commitsLast90Days >= 1 ? 0.4 : 0 },
  { key: 'bus-factor', dimension: 'health', weight: 2,
    evaluate: s => s.busFactor === undefined ? undefined
      : s.busFactor >= 5 ? 1 : s.busFactor >= 3 ? 0.8 : s.busFactor === 2 ? 0.6 : s.busFactor === 1 ? 0.25 : 0 },
  { key: 'issue-responsiveness', dimension: 'health', weight: 1,
    evaluate: s => band(s.medianIssueResponseDays, [[2, 1], [7, 0.8], [30, 0.5]], 0.15) },
  { key: 'popularity', dimension: 'health', weight: 1,
    evaluate: s => {
      if (s.stars === undefined && s.weeklyDownloads === undefined) return undefined
      const star = s.stars === undefined ? 0
        : s.stars >= 1000 ? 1 : s.stars >= 200 ? 0.8 : s.stars >= 50 ? 0.6 : s.stars >= 10 ? 0.35 : 0.15
      const dl = s.weeklyDownloads === undefined ? 0
        : s.weeklyDownloads >= 10000 ? 1 : s.weeklyDownloads >= 1000 ? 0.8 : s.weeklyDownloads >= 100 ? 0.5 : 0.2
      return Math.max(star, dl)
    } },
  { key: 'release-recency', dimension: 'health', weight: 1,
    evaluate: s => band(s.daysSinceLastRelease, [[90, 1], [365, 0.5]], 0.1) },
  { key: 'not-archived', dimension: 'health', weight: 2,
    evaluate: s => s.archived === undefined ? undefined : s.archived ? 0 : 1 },

  // ---- reliability (25%) ----
  { key: 'spec-era', dimension: 'reliability', weight: 3,
    evaluate: s => s.specEra === undefined ? undefined : s.specEra === 'modern' ? 1 : 0 },
  { key: 'ci-present', dimension: 'reliability', weight: 2,
    evaluate: s => s.hasCI === undefined ? undefined : s.hasCI ? 1 : 0 },
  { key: 'tests-present', dimension: 'reliability', weight: 2,
    evaluate: s => s.hasTests === undefined ? undefined : s.hasTests ? 1 : 0 },
  { key: 'lockfile', dimension: 'reliability', weight: 1,
    evaluate: s => s.hasLockfile === undefined ? undefined : s.hasLockfile ? 1 : 0 },
  { key: 'schema-parseable', dimension: 'reliability', weight: 1,
    evaluate: s => s.schemaExtracted === undefined ? undefined : s.schemaExtracted ? 1 : 0.3 },

  // ---- security (25%) ----
  { key: 'tool-surface', dimension: 'security', weight: 3,
    evaluate: s => s.toolSurfaceRisk === undefined ? undefined
      : ({ none: 1, low: 0.8, medium: 0.5, high: 0.2 } as const)[s.toolSurfaceRisk] },
  { key: 'no-secrets', dimension: 'security', weight: 1, // low weight: candidate signal, ~13% true-positive rate (see methodology)
    evaluate: s => s.secretsFound === undefined ? undefined : s.secretsFound === 0 ? 1 : 0 },
  { key: 'dependency-cves', dimension: 'security', weight: 2,
    evaluate: s => s.cveWorst === undefined ? undefined
      : ({ none: 1, low: 0.6, medium: 0.6, high: 0.2, critical: 0 } as const)[s.cveWorst] },

  // ---- cost (15%) ----
  { key: 'token-footprint', dimension: 'cost', weight: 2,
    evaluate: s => band(s.schemaTokenEstimate, [[2000, 1], [10000, 0.8], [25000, 0.5], [50000, 0.25]], 0.1) },
  { key: 'tool-count', dimension: 'cost', weight: 1,
    evaluate: s => band(s.toolCount, [[10, 1], [25, 0.7], [50, 0.4]], 0.2) },
]
