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

  // D2 (integrity-phase2, docs/superpowers/plans/2026-08-04-integrity-v1.md
  // "Phase 2"): a decode-confirmed hidden payload in tool metadata is
  // implemented as a DISQUALIFYING OVERRIDE on the security dimension, not
  // as an additional weighted SIGNALS entry. Why: the 400-server audit
  // found this fires on 0% of the corpus (0 payloads / 400 servers) — a
  // signal that evaluates to 1.0 for 100% of servers carries no
  // information, but adding it as, say, weight 3 to security's existing
  // tool-surface(3)+no-secrets(1)+dependency-cves(2)=6 denominator would
  // still INFLATE every score by diluting the signals that actually
  // discriminate (measured: a high-risk exec/shell server would move
  // 60->73; a high-risk server with a secret candidate would move 43->62).
  // That is a regression in scoring quality, not an improvement. An
  // override sidesteps this entirely: it has ZERO effect when
  // hiddenPayloadDecoded is 0 or undefined — true for every server measured
  // so far, so this is a provable zero-regression change — and is DECISIVE
  // (forces security to 0, the worst possible score) when a hit is
  // decode-confirmed. A decode-confirmed payload is positive evidence of
  // deliberate concealment (not a probabilistic guess like the secrets
  // heuristic above), and the audit measured zero legitimate runs >=4
  // across 56.7M characters, so this cannot fire on benign content.
  // Weights, denominators, and every other dimension are untouched — see
  // src/scoring/rubric.ts, which this override does not modify.
  let hiddenPayloadNote: string | undefined
  if (signals.hiddenPayloadDecoded !== undefined && signals.hiddenPayloadDecoded > 0) {
    const sec = dimensions.find(d => d.id === 'security')
    if (sec) sec.score = 0
    hiddenPayloadNote = `Security scored 0: ${signals.hiddenPayloadDecoded} decode-confirmed hidden payload(s) in tool metadata — see findings for path, codepoints and decoded text.`
  }

  const availableTotal = dimensions.reduce((a, d) => a + d.available, 0)
  // Coverage gate: don't hand out a confident grade when the security PRIMARY
  // signal (tool-surface risk) couldn't be determined — without it, security
  // renormalizes onto the low-weight no-secrets candidate signal and can read
  // as a false clean bill (e.g. 100/A+) even for dangerous servers.
  const securityPrimaryAbsent = signals.toolSurfaceRisk === undefined
  const dimensionsFullyDropped = dimensions.filter(d => d.available === 0).length
  // V2: notServer is a DISTINCT terminal state, not insufficientData — a
  // library/SDK/proxy/stub was never going to have a coverage-gate-passing
  // tool surface (it has none by design), so the same sparse-signal shape
  // that would normally trip this gate must not be reported as "we failed to
  // check this server". The notServer flag (set by classifyLibrary via
  // assemble.ts) unconditionally overrides the gate.
  const notServer = Boolean(signals.notServer)
  // W1: unresolved (GitHub 404 — repo deleted/renamed/never existed) is a
  // THIRD distinct terminal state, alongside notServer ("we read it, it's a
  // library") and the generic insufficientData gate below ("we read it, but
  // couldn't extract enough"). It bypasses the gate the same way notServer
  // does — there was never a tool surface to fail to extract, because there
  // was never a repo to read.
  const unresolved = Boolean(signals.unresolved)
  const insufficientData = !notServer && !unresolved
    && (availableTotal < 4 || securityPrimaryAbsent || dimensionsFullyDropped >= 2)

  const notes: string[] = []
  if (hiddenPayloadNote) notes.push(hiddenPayloadNote)
  for (const d of dimensions) {
    if (d.available === 0) notes.push(`No ${d.id} signals could be collected; ${d.id} is excluded from the overall score.`)
    else if (d.confidence === 'low') notes.push(`Low confidence in ${d.id}: only ${d.available}/${d.total} signals available.`)
  }
  for (const e of signals.errors) notes.push(`Collector issue: ${e}`)
  // W6 (coverage-v1.5, Task W6 Part B): 'dynamic' reuses the notServer
  // plumbing (overall/grade null, same as every other notServer reason —
  // see the `withheld` computation below) but is NOT a library: it is a
  // real MCP server whose tool list is unknowable from source, not "nothing
  // here to grade". Given its own note wording rather than the generic
  // "Library / not an MCP server" phrasing every other reason gets.
  if (notServer && signals.notServerReason === 'dynamic') {
    notes.push(signals.notServerNote ?? 'Tools are registered at runtime from upstream servers; no static list exists.')
  } else if (notServer) {
    const reasonPart = signals.notServerReason ? ` (${signals.notServerReason})` : ''
    notes.push(`Library / not an MCP server${reasonPart}: ${signals.notServerNote ?? 'no tools to grade.'}`)
  } else if (unresolved) {
    notes.push('Repository could not be resolved on GitHub (404 — deleted or renamed) — no grade to report.')
  } else {
    if (securityPrimaryAbsent) {
      notes.push('Security tool surface could not be determined — grade withheld to avoid a false clean bill.')
    }
    if (dimensionsFullyDropped >= 2) {
      notes.push(`${dimensionsFullyDropped} dimensions had zero collectible signals — not enough coverage to score confidently. Grade withheld.`)
    }
    if (availableTotal < 4) {
      notes.push(`Only ${availableTotal} of ${SIGNALS.length} signals were collectable — not enough to score. Grade withheld.`)
    }
  }

  const scored = dimensions.filter(d => d.available > 0)
  const wTotal = scored.reduce((a, d) => a + DIMENSION_WEIGHTS[d.id], 0)
  const overall = wTotal === 0 ? 0
    : Math.round(scored.reduce((a, d) => a + d.score * DIMENSION_WEIGHTS[d.id], 0) / wTotal)

  // I9: a notServer card carries no headline score/grade — there is no tool
  // surface to grade, so a real-looking number (e.g. 100/A+ for
  // typescript-sdk) misrepresents "nothing to check" as "checked and clean".
  // W1: unresolved cards get the same treatment — a repo we never fetched
  // must never carry a numeric overall or letter grade (the 18-false-F-card bug).
  const withheld = notServer || unresolved
  return {
    ref, rubricVersion: RUBRIC_VERSION,
    // D1 (integrity-v1): checksVersion records which CHECK set produced this
    // card — distinct from rubricVersion, which records which set of
    // signals GRADED it. integrityHits/integrityScanned remain display-only
    // passthroughs from Signals — nothing above reads the hits list itself.
    // integrityHits stays undefined (never []) when assemble.ts never
    // called scanIntegrity — see its "absence != clean" note.
    // D2 (integrity-phase2): the ONE exception is signals.hiddenPayloadDecoded
    // (a derived count, not the hits list), which the override above reads
    // to zero the security dimension — see that comment for the full
    // rationale.
    checksVersion: '1.0.0',
    overall: withheld ? null : overall,
    grade: withheld ? null : grade(overall),
    dimensions, notes, generatedAt,
    insufficientData,
    integrityHits: signals.integrityHits,
    integrityScanned: signals.integrityScanned,
    // W6 review remediation item M2: structured passthrough, undefined only
    // when extraction never ran at all (mirrors integrityHits' own
    // absence-vs-value discipline above).
    ...(signals.readmeSourced !== undefined ? { readmeSourced: signals.readmeSourced } : {}),
    ...(resolved ? { resolved } : {}),
    ...(notServer ? { notServer: true, notServerReason: signals.notServerReason } : {}),
    ...(unresolved ? { unresolved: true } : {}),
  }
}
