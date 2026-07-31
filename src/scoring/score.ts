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

export function score(ref: string, signals: Signals, generatedAt: string): Scorecard {
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

  const notes: string[] = []
  for (const d of dimensions) {
    if (d.available === 0) notes.push(`No ${d.id} signals could be collected; ${d.id} is excluded from the overall score.`)
    else if (d.confidence === 'low') notes.push(`Low confidence in ${d.id}: only ${d.available}/${d.total} signals available.`)
  }
  for (const e of signals.errors) notes.push(`Collector issue: ${e}`)

  const scored = dimensions.filter(d => d.available > 0)
  const wTotal = scored.reduce((a, d) => a + DIMENSION_WEIGHTS[d.id], 0)
  const overall = wTotal === 0 ? 0
    : Math.round(scored.reduce((a, d) => a + d.score * DIMENSION_WEIGHTS[d.id], 0) / wTotal)

  return { ref, rubricVersion: RUBRIC_VERSION, overall, grade: grade(overall), dimensions, notes, generatedAt }
}
