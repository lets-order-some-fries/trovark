const BANDS: Array<[lo: number, hi: number, letter: string]> = [
  [85, 100, 'A'], [70, 84, 'B'], [55, 69, 'C'], [40, 54, 'D'],
]

export function grade(score: number): string {
  const v = Math.round(score)
  for (const [lo, hi, letter] of BANDS) {
    if (v >= lo && v <= hi) {
      if (v >= hi - 4) return `${letter}+`
      if (v <= lo + 4) return `${letter}-`
      return letter
    }
  }
  return 'F'
}

import { DIMENSION_WEIGHTS, RUBRIC_VERSION, SIGNALS } from './rubric.js'
import type { Confidence, DimensionId, DimensionScore, Scorecard, Signals } from '../types.js'

function confidence(available: number, total: number): Confidence {
  const r = available / total
  return r >= 0.75 ? 'high' : r >= 0.4 ? 'medium' : 'low'
}

export function score(
  ref: string, signals: Signals, generatedAt: string,
  resolved?: Scorecard['resolved'],
): Scorecard {
  const ids = Object.keys(DIMENSION_WEIGHTS) as DimensionId[]
  const dimensions: DimensionScore[] = ids.map(id => {
    const defs = SIGNALS.filter(d => d.dimension === id)
    let wSum = 0, vSum = 0, available = 0
    for (const d of defs) {
      const v = d.evaluate(signals)
      if (v === undefined) continue
      available++
      wSum += d.weight
      vSum += d.weight * v
    }
    return {
      id,
      score: wSum === 0 ? 0 : Math.round((vSum / wSum) * 100),
      confidence: confidence(available, defs.length),
      available,
      total: defs.length,
      findings: signals.findings.filter(f => f.dimension === id),
    }
  })

  const availableTotal = dimensions.reduce((a, d) => a + d.available, 0)
  // Coverage gate: don't hand out a confident grade when the security PRIMARY
  // signal (tool-surface risk) couldn't be determined — without it, security
  // renormalizes onto the low-weight no-secrets candidate signal and can read
  // as a false clean bill (e.g. 100/A+) even for dangerous servers.
  const securityPrimaryAbsent = signals.toolSurfaceRisk === undefined
  const dimensionsFullyDropped = dimensions.filter(d => d.available === 0).length
  const insufficientData = availableTotal < 4 || securityPrimaryAbsent || dimensionsFullyDropped >= 2

  const notes: string[] = []
  for (const d of dimensions) {
    if (d.available === 0) notes.push(`No ${d.id} signals could be collected; ${d.id} is excluded from the overall score.`)
    else if (d.confidence === 'low') notes.push(`Low confidence in ${d.id}: only ${d.available}/${d.total} signals available.`)
  }
  for (const e of signals.errors) notes.push(`Collector issue: ${e}`)
  if (securityPrimaryAbsent) {
    notes.push('Security tool surface could not be determined — grade withheld to avoid a false clean bill.')
  }
  if (dimensionsFullyDropped >= 2) {
    notes.push(`${dimensionsFullyDropped} dimensions had zero collectible signals — not enough coverage to score confidently. Grade withheld.`)
  }
  if (availableTotal < 4) {
    notes.push(`Only ${availableTotal} of ${SIGNALS.length} signals were collectable — not enough to score. Grade withheld.`)
  }

  const scored = dimensions.filter(d => d.available > 0)
  const wTotal = scored.reduce((a, d) => a + DIMENSION_WEIGHTS[d.id], 0)
  const overall = wTotal === 0 ? 0
    : Math.round(scored.reduce((a, d) => a + d.score * DIMENSION_WEIGHTS[d.id], 0) / wTotal)

  return {
    ref, rubricVersion: RUBRIC_VERSION, overall, grade: grade(overall), dimensions, notes, generatedAt,
    insufficientData,
    ...(resolved ? { resolved } : {}),
  }
}
