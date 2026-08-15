import type { DimensionId, Signals } from '../types.js'

export const RUBRIC_VERSION = '1.7.0'

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
  // 1.7.0: cost scores TOOL-SURFACE SIZE, and nothing else.
  //
  // `token-footprint` (weight 2 of 3, banded on schemaTokenEstimate) was
  // REMOVED here. It is computable only when EVERY tool carries a real
  // serialized JSON schema — manifest/OpenAPI sources, ~5% of the corpus; for
  // the rest schemaText is zod/TS source whose token count bears no relation
  // to the payload a client actually receives (see tokenFootprint() in
  // src/derive/schema.ts, which still measures it — now as a published FACT
  // rather than a signal).
  //
  // NB: the wording here deliberately avoids the bare plural of "tool",
  // which tests/assemble.test.ts greps this file for to prove the rubric
  // never reads the D2 tool-surface artifact off Signals. Keep it that way.
  // Measured on the published index (index/results.json, 2026-08-14):
  // cost.score was null for 268 of 278 graded servers (96%) and for all 87
  // withheld ones, and — since score.ts's coverage gate needs 3 of 4
  // dimensions — an always-absent cost pinned every server at 3/4, so losing
  // ANY other dimension withheld the whole grade. All 87 withheld servers
  // were exactly "cost + reliability", "cost + security", or all three: a
  // signal measurable for a twentieth of the corpus was gating 22% of it out
  // of being graded at all.
  //
  // Why it was not kept as an OPTIONAL signal: because its ABSENCE FLATTERS.
  // A 5-tool server with a 25k-token schema scores (2*0.5 + 1*1.0)/3 = 67
  // with the footprint and 100 without it — so failing to read the schema is
  // worth +33, and absence renders as a favourable measurement. That is the
  // single fault this codebase has fixed most often (see score.ts's Rule
  // A/B/D comments and docs/superpowers/plans/2026-08-01-precision-v1.2.md).
  // score.ts's Rule C papered over it by withholding the dimension whenever
  // the footprint was missing, which is what produced the 96%.
  //
  // HONEST LIMIT — from the adversarial review OF this change, recorded
  // because the commit that introduced it overclaimed. Scoring every server
  // on the same always-present signal removes the FOOTPRINT's asymmetry: a
  // signal available to 5% of the corpus no longer flatters the other 95%.
  // It does NOT remove the asymmetry "by construction", as that commit
  // claimed. `toolCount` counts the definitions we EXTRACTED, not the ones
  // the server actually exposes — and this band is monotone DECREASING, so
  // an under-read surface scores BETTER. Failing to parse a registration
  // idiom is still rewarded, and with cost down to one signal that leverage
  // is 3x what it was.
  // What bounds it: assemble.ts withholds toolCount entirely when
  // `surfacePartial` (the tree shows more tool-bearing files than the sample
  // reached) — the DETECTABLE half of under-reading — and Rule A then
  // withholds the dimension. The undetectable half (a fetched file whose
  // idiom we do not parse) is a real residual limitation, stated in
  // docs/methodology.md, and is part of why this dimension carries 15% and
  // not more.
  //
  // tool-count keeps its existing weight and bands, unchanged.
  { key: 'tool-count', dimension: 'cost', weight: 1,
    evaluate: s => band(s.toolCount, [[10, 1], [25, 0.7], [50, 0.4]], 0.2) },
]
