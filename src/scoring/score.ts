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

// Fault hunt 2026-08-08 (IMPORTANT): this was signal-COUNT-based
// (available/total), so losing a weight-1 signal cost exactly as much
// confidence as losing a weight-3 primary — assemble.ts's dynamic-server
// comment even documented the weight-aware behaviour as if it existed.
// Confidence now reflects the WEIGHT of what was actually measured: e.g.
// security missing only no-secrets (1 of 6 weight) stays high (5/6), while
// security missing its primary (3 of 6) is medium at best.
function confidence(measuredWeight: number, totalWeight: number): Confidence {
  const r = measuredWeight / totalWeight
  return r >= 0.75 ? 'high' : r >= 0.4 ? 'medium' : 'low'
}

/**
 * Cost confidence, from the QUALITY of the count rather than its presence.
 *
 * Fault hunt follow-up (2026-08-15): rubric 1.7.0 left cost with a single
 * weight-1 signal, so the generic weight-ratio above degenerates to
 * 1/1 -> 'high' whenever the dimension scores and 0/1 -> 'low' when it does
 * not. The field then restated `score !== null` and carried no information —
 * and, worse, a tool count parsed out of maintainer PROSE (the README
 * catalog rung) published at 'high' beside one extracted from real code.
 *
 * The serialized token footprint is the right input here even though it is
 * deliberately not a scored signal: being able to read every tool's declared
 * schema is evidence that the surface we counted is the COMPLETE one. Using
 * it for confidence rather than for score is what keeps its absence from
 * flattering anybody — absence lowers confidence, exactly as it should, and
 * never moves the number.
 */
function costConfidence(signals: Signals, measuredWeight: number): Confidence {
  if (measuredWeight === 0) return 'low'                    // nothing counted; Rule A also nulls the score
  if (signals.readmeSourced) return 'low'                   // a maintainer's claim, unverified against code
  if (signals.schemaTokenEstimate !== undefined) return 'high' // every tool's schema was readable
  return 'medium'                                           // counted from code, schemas unreadable
}

export function score(
  ref: string, signals: Signals, generatedAt: string,
  resolved?: Scorecard['resolved'],
): Scorecard {
  const ids = Object.keys(DIMENSION_WEIGHTS) as DimensionId[]
  // Coverage gate input, hoisted above the dimension loop so Rule B below and
  // the grade-withholding gate further down read the SAME computation — one
  // definition of "the security primary is missing", not two that can drift.
  const securityPrimaryAbsent = signals.toolSurfaceRisk === undefined
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
    // W6 (fabricated-dimension-value fix): absence lowers confidence AND
    // withholds the dimension score — it never fakes a value.
    //
    // Rule A: zero collectible signals means there is no measurement. The old
    // `wSum === 0 ? 0` published 0/100 — the WORST possible score — conjured
    // from nothing (measured live: a dynamic gateway reported cost 0/100 off
    // 0 of 2 signals).
    //
    // Rule B: security's PRIMARY signal is tool-surface risk (weight 3 of the
    // dimension's 6). Without it the weighted mean renormalizes onto the
    // remaining low-weight signals — chiefly the no-secrets candidate — and
    // reads as a clean bill of health for a server we just said we cannot
    // analyze (measured live: security 100/100 from 1 of 3 signals on a
    // gateway whose tool surface is explicitly unreadable). This is the v1.2
    // bug reappearing at dimension level — see
    // docs/superpowers/plans/2026-08-01-precision-v1.2.md ("when schema
    // extraction fails, security renormalizes onto the lone weight-1
    // no-secrets candidate → security=100, confident A+") — and
    // docs/superpowers/plans/2026-08-03-coverage-v1.4.md forbids exactly this
    // for the dynamic path: "Do NOT renormalize security onto the remaining
    // signals — a gateway with unknown tools is the highest-risk shape in the
    // corpus, not a neutral one."
    // The gate below already withholds the GRADE on this condition —
    // but notServer/dynamic/unresolved bypass that gate entirely, so the
    // withhold has to live on the dimension itself to cover every path.
    // Rule C (fault hunt 2026-08-08) is REMOVED as of rubric 1.7.0. It
    // withheld cost whenever `schemaTokenEstimate` was absent, because
    // renormalizing a 2-signal cost onto tool-count alone REMOVED A PENALTY
    // (absence rendered as a favourable measurement). The rule was right; the
    // rubric it was defending was not. `token-footprint` is computable for
    // ~5% of the corpus, so Rule C withheld cost for 268 of 278 graded
    // servers (96%) and for all 87 withheld ones — and, through the >=3-of-4
    // gate below, was the shared reason every one of those 87 servers went
    // ungraded. src/scoring/rubric.ts now drops token-footprint entirely, so
    // cost's ONLY signal is tool-count: there is no composite left to
    // renormalize and no absent dominant signal to flatter from. Rule A
    // (`available === 0`) already covers the case Rule C would now be asked
    // about — a server whose tool surface could not be counted — so keeping
    // Rule C would be dead code that reads like a live invariant.
    // Rule D (fault hunt 2026-08-08, C4): reliability's primary is spec-era
    // (weight 3 of 9), and it is binary — a server on a LEGACY SDK loses the
    // full 3, while one whose SDK we could not determine loses nothing after
    // renormalization. So "we don't know what this targets" scored exactly
    // like "targets the current spec", at high confidence. Unknown must not
    // outscore known-bad: withhold, like security and cost above.
    const reliabilityPrimaryAbsent = signals.specEra === undefined
    const unmeasured = available === 0
      || (id === 'security' && securityPrimaryAbsent)
      || (id === 'reliability' && reliabilityPrimaryAbsent)
    return {
      id,
      score: unmeasured ? null : Math.round((vSum / wSum) * 100),
      confidence: id === 'cost'
        ? costConfidence(signals, wSum)
        : confidence(wSum, defs.reduce((a, d) => a + d.weight, 0)),
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
  //
  // W6 (fabricated-dimension-value fix): this override deliberately runs
  // AFTER the Rule A/B withhold above and outranks it. Withholding is for
  // ABSENCE of evidence; a decode-confirmed payload is positive EVIDENCE of
  // deliberate concealment. A server that hides a payload AND has an
  // unreadable tool surface must score 0, not "not measured" — otherwise the
  // worst servers hide behind the withhold.
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
  // W6: `securityPrimaryAbsent` is computed once, above the dimension loop —
  // the SAME value Rule B uses to withhold the security dimension score.
  // Fault hunt follow-up (2026-08-09): this gate predates the null-score
  // semantics and counted only `available === 0` — but Rules B/D withhold
  // a dimension's SCORE while its `available` stays positive, and `overall`
  // silently renormalized onto whatever dimensions remained. Measured on the
  // post-fix corpus: 42 graded servers (13%) published letter grades from
  // TWO measured dimensions — Azure/azure-mcp graded D+ 50 from health 40 +
  // security 63 with reliability and cost both withheld, alongside
  // cloudflare/mcp-server-cloudflare, supabase-mcp and upstash/context7. A
  // letter grade from half the rubric is the v1.2 confident-A+ bug at the
  // composite level. Count every dimension whose score is withheld, whatever
  // the mechanism.
  const dimensionsFullyDropped = dimensions.filter(d => d.score === null).length
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
    // Fault hunt 2026-08-08 (IMPORTANT): a primary-withheld dimension used
    // to emit NO note at all — the reliability/security withhold was
    // silent to both humans and JSON consumers, a "not measured" with no
    // stated reason. Name the fact. (Cost was the third case until rubric
    // 1.7.0 retired Rule C; it now reaches this branch only via Rule A,
    // which emits the "No cost signals" note above instead.)
    else if (d.score === null) notes.push(`${d.id} is withheld: its primary signal could not be determined from the available data, and a score computed from the remaining signals would misrepresent what was read.`)
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
      notes.push(`${dimensionsFullyDropped} of 4 dimensions could not be measured — a headline grade from the remainder would overstate what was read. Grade withheld.`)
    }
    if (availableTotal < 4) {
      notes.push(`Only ${availableTotal} of ${SIGNALS.length} signals were collectable — not enough to score. Grade withheld.`)
    }
  }

  // W6: an unmeasured dimension (score null) is EXCLUDED from the weighted
  // mean, never coerced — `null * weight` is 0 in JS, which would silently
  // deflate the overall by the missing dimension's full weight. `available >
  // 0` is kept alongside so the D2 override (which can force a 0 onto a
  // dimension with no collectible signals) still cannot enter the mean, as
  // before.
  const scored = dimensions.filter(d => d.available > 0 && d.score !== null)
  const wTotal = scored.reduce((a, d) => a + DIMENSION_WEIGHTS[d.id], 0)
  const overall = wTotal === 0 ? 0
    : Math.round(scored.reduce((a, d) => a + (d.score ?? 0) * DIMENSION_WEIGHTS[d.id], 0) / wTotal)

  // I9: a notServer card carries no headline score/grade — there is no tool
  // surface to grade, so a real-looking number (e.g. 100/A+ for
  // typescript-sdk) misrepresents "nothing to check" as "checked and clean".
  // W1: unresolved cards get the same treatment — a repo we never fetched
  // must never carry a numeric overall or letter grade (the 18-false-F-card bug).
  //
  // W6 (false-published-claim fix): `insufficientData` joins them, which is
  // what the gate was always supposed to mean. Until now it withheld the
  // grade only in the RENDERING — report/terminal.ts printed "INSUFFICIENT
  // DATA", index/site.ts printed a "—" chip — while `overall`/`grade` stayed
  // populated on the Scorecard and therefore shipped in `trovark --json` and
  // in the committed, publicly served index/results.json. Measured on the
  // published index (2026-08-06): 29 of 29 insufficientData entries carried a
  // numeric overall AND a letter grade, several of them "A" (eat-pray-ai/yutu
  // 94/A, ndthanhdev/mcp-browser-kit 93/A, sitbon/magg 91/A). A machine
  // consumer reading the public dataset saw grade "A" for servers we
  // explicitly said we could not assess — the exact v1.2 "unreadable repo
  // scores a confident A+" failure this gate exists to prevent, surviving one
  // layer below the display.
  //
  // This is deliberately the SAME mechanism notServer/unresolved already use,
  // not a parallel one: there is one definition of "withheld", so the three
  // terminal states cannot drift apart. Dimensions are untouched — the
  // partial evidence we DO have still publishes (see the Rule A/B withholds
  // above, which are about individual dimensions, not the headline).
  // `insufficientData` itself stays on the card, so consumers can still tell
  // the three states apart and keep their distinct presentations.
  const withheld = notServer || unresolved || insufficientData
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
