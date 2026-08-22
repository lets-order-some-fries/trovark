import type { Http } from './util/http.js'
import type { ServerIdentity } from './resolver.js'
import type { Signals } from './types.js'
import { collectGithub, RepoNotFoundError, type RepoFile } from './collectors/github.js'
import { collectNpm } from './collectors/npm.js'
import { collectPypi } from './collectors/pypi.js'
import { collectOsv, depsFromManifest, type Dep } from './collectors/osv.js'
import { repoChecks } from './derive/repoChecks.js'
import { specEra } from './derive/specEra.js'
import { extractSchema } from './derive/schema.js'
import { classifyLibrary } from './derive/classify.js'
import { detectDynamic } from './derive/dynamic.js'
import { scanSecrets } from './derive/secrets.js'
import { scanIntegrity } from './derive/integrity.js'
import { parseLockfile } from './derive/lockfile.js'

const days = (fromIso: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000))

export async function assemble(
  identity: ServerIdentity, http: Http, now: Date, opts: { hasToken?: boolean } = {},
): Promise<Signals> {
  const s: Signals = { findings: [], errors: [] }
  const deps: Dep[] = []
  let repoFiles: RepoFile[] | undefined

  if (identity.repo) {
    try {
      const snap = await collectGithub(identity, http, now, opts)
      repoFiles = snap.files
      s.daysSinceLastCommit = days(snap.pushedAt, now)
      if (snap.latestReleaseAt) s.daysSinceLastRelease = days(snap.latestReleaseAt, now)
      s.commitsLast90Days = snap.commitsLast90Days
      s.busFactor = snap.busFactor
      s.medianIssueResponseDays = snap.medianIssueResponseDays
      s.stars = snap.stars
      s.archived = snap.archived
      if (snap.treePaths) {
        Object.assign(s, repoChecks(snap.treePaths))
        s.specEra = specEra(snap.files)
        // W6 (Task W6): STATIC-only extraction first (manifest/js/py/go/spec
        // — no README rung yet). This is the ladder result classifyLibrary
        // and the dynamic-surface classifier both key off of: README-derived
        // tools must never feed classifyLibrary's toolsExtracted (verified
        // regression, wave2-spec §3 R6 — modelcontextprotocol/ruby-sdk's
        // README yields 11 fake "tools" like destructive_hint/redirect_uri
        // and would flip a correct `notServer(sdk)` verdict into a graded
        // card), and the dynamic classifier is gated on "every STATIC
        // extractor returned 0" specifically so a proxy's own README
        // (MCPJungle: included_tools/excluded_tools/included_servers) can
        // never masquerade as a real tool surface and suppress it.
        // Fault hunt 2026-08-08 (C5): files the tree listed but the blob
        // fetch could not read (403/429/5xx after retries). Previously
        // dropped silently — a rate-limited run just graded a smaller repo
        // than the one that exists, with no record. Now: named in errors
        // (which reach the published notes), and the surface is forced
        // PARTIAL below so every existing partial-read honesty rule engages
        // (no clean risk verdict, no counts, no dynamic verdict).
        const fetchesFailed = snap.fetchFailures.length > 0
        if (fetchesFailed) {
          s.errors.push(`could not fetch ${snap.fetchFailures.length} selected file(s): ${snap.fetchFailures.slice(0, 5).join(', ')}${snap.fetchFailures.length > 5 ? ', …' : ''}`)
        }
        const extractedSchema = extractSchema(snap.files, snap.treePaths, snap.toolFanoutCount)
        const staticSchema = fetchesFailed && !extractedSchema.surfacePartial
          ? { ...extractedSchema, surfacePartial: true }
          : extractedSchema
        // V2/V6 (library/SDK/proxy classifier, coverage-spec §3.1): ALWAYS
        // call classifyLibrary and let it pick the tier via `toolsExtracted`
        // (see the V6 note atop classify.ts). At zero tools it runs the
        // unchanged Tier A signals (any one suffices); once tools WERE
        // extracted it runs ONLY Tier B's corroborated-identity check (name
        // ends `-sdk` AND an official-SDK description/topic) — added because
        // V3-V5's better extraction started reading python-sdk/typescript-
        // sdk/go-sdk/kotlin-sdk's own API-definition code as tool-shaped, so
        // the old zero-tools-only guard stopped firing for exactly those
        // repos. assemble.ts (not schema.ts) is the wiring seam:
        // classifyLibrary needs repo metadata (name/description/topics, only
        // on RepoSnapshot) alongside the FULL fetched file set, both of
        // which live on `snap` here — routing this through schema.ts would
        // need schema.ts to import classify.ts while classify.ts imports
        // schema.ts's idiom detectors, a cycle.
        // W6: moved ahead of the schema-derived signal assignments below
        // (previously ran after them) — it only ever needed
        // staticSchema.tools.length, so reordering is behavior-preserving
        // for every pre-W6 call site, and it must run before the
        // dynamic/README branch below can decide anything.
        const classification = classifyLibrary({
          name: snap.name, description: snap.description, topics: snap.topics, files: snap.files,
          // Cross-language MCP SDK detection (already computed above for
          // s.specEra) protects non-JS servers whose import-bearing file
          // wasn't sampled from a false 'not a server' verdict — see
          // ClassifyContext.mcpSdkDetected in classify.ts.
          mcpSdkDetected: s.specEra !== undefined,
          toolsExtracted: staticSchema.tools.length > 0,
        })

        let schema = staticSchema
        // W6 (Task W6 Part B): set only when the dynamic-surface classifier
        // fires. W6 review remediation item I5 (.superpowers/sdd/w6-review-
        // findings.md): previously used to floor toolSurfaceRisk to a
        // fabricated 'high' — that pin is gone (see below); these are now
        // read only to attach the evidence-bearing `security/dynamic-tool-
        // surface` finding.
        let dynamicNote: string | undefined
        let dynamicEvidence: string | undefined
        if (classification) {
          s.notServer = true
          s.notServerReason = classification.reason
          s.notServerNote = classification.note
        } else if (staticSchema.tools.length === 0) {
          // W6 (Task W6 Part B / wave2-spec §3 R6 ordering rule 2): the
          // dynamic-surface check runs BEFORE the README rung, and ONLY once
          // classifyLibrary declined (a library/SDK is never "dynamic" — it
          // has no tool surface by design, not an unknowable one).
          // W6 review remediation item I6 (IMPORTANT): never emit `dynamic`
          // when staticSchema.surfacePartial is true — that already folds in
          // toolFanoutCount vs. what was actually sampled (see
          // detectSurfacePartial in schema.ts), so a figwright-shaped repo
          // (100+ one-tool-per-file modules, sampler reaches ~20) that trips
          // Signal A would otherwise be published as "no static list exists"
          // while the same scan's own tree knows unsampled tool-bearing
          // files exist. That case is honestly insufficientData (via
          // securityPrimaryAbsent in score.ts, since toolSurfaceRisk stays
          // undefined below), not dynamic — skip straight to the README rung
          // instead of asking a detector that can't see the whole tree.
          const dyn = staticSchema.surfacePartial ? null : detectDynamic({
            files: snap.files, treePaths: snap.treePaths, description: snap.description, topics: snap.topics,
          })
          if (dyn) {
            s.notServer = true
            s.notServerReason = 'dynamic'
            s.notServerNote = dyn.note
            dynamicNote = dyn.note
            dynamicEvidence = dyn.evidence
          } else {
            // W6 (Task W6 Part A): the README-catalog rung — reachable only
            // once we know this repo is neither a library nor dynamic-shaped.
            // W6 review remediation item 1: read from snap.readme (the
            // quarantined field), never snap.files — this is the ONE place
            // in this whole function that is meant to see the README at all.
            const readmeFile = snap.readme
            if (readmeFile) schema = extractSchema(snap.files, snap.treePaths, snap.toolFanoutCount, readmeFile)
          }
        }

        s.schemaExtracted = schema.extracted && !schema.readmeSourced
        // W6 review remediation item M2: structured, machine-readable
        // provenance — see the field's comment in types.ts. Set alongside
        // schemaExtracted (same `schema` this run resolved to, whichever
        // rung produced it) so the two can never drift apart.
        s.readmeSourced = schema.readmeSourced
        // W6 review remediation item I5 (.superpowers/sdd/w6-review-findings.
        // md): the W6-era pin `toolSurfaceRisk = 'high'` for dynamic servers
        // is REMOVED. It was published as a measured, confidently-scored
        // security dimension with no evidence finding attached — a verdict,
        // not a fact. We genuinely cannot read a dynamic server's tool
        // surface, so the signal stays whatever `schema.toolSurfaceRisk`
        // already resolved to (`staticSchema` in the dynamic branch: 0
        // tools, so `undefined` unless the shell-import structural floor —
        // see I1 / findShellImportFile in schema.ts — already set it to
        // 'medium', which is untouched here and applies regardless of
        // rung). This is NOT a renormalization: the governing spec
        // (wave2-spec §1a, restated in .superpowers/sdd/threat-spec.md
        // §Part B) forbids letting security score clean by dropping the
        // primary signal and pretending the remaining no-secrets/
        // dependency-cves signals are the whole picture — but it does not
        // license inventing a number either. Leaving it undefined and
        // reusing the EXISTING coverage/confidence machinery (score.ts's
        // `confidence()` — dropping the weight-3 primary signal out of
        // security's 3-signal denominator caps the best achievable ratio at
        // 2/3 ≈ 0.67, below the 0.75 'high' threshold, so confidence can
        // land 'medium' or 'low' but never 'high') is that machinery already
        // doing its job, not a parallel mechanism. `overall`/`grade` stay
        // null for dynamic regardless (notServer bypasses score.ts's gate,
        // unchanged). The evidence-bearing finding below is what replaces
        // the old fabricated pin as the honest published fact.
        // W6 corpus-scan finding: a partial surface may not publish `'none'`.
        // `'none'` means "we examined the tool surface and nothing is risky";
        // on a partial sample the true statement is "we examined SOME of the
        // tool surface and that part is not risky" — which is not evidence of
        // absence, because an unexamined tool is precisely where risk would
        // hide. Measured: ViperJuice/mcp-gateway extracted 1 tool from a tree
        // with more tool-bearing files than the sampler reached, and the
        // resulting 'none' scored security 100/100 -> overall A+ 96 — a
        // confident clean bill for a surface we admit we did not fully read,
        // and the same shape as the v1.2 bug where an unreadable repo scored
        // a confident A+.
        //
        // The monotonicity argument in the W5 comment below is kept where it
        // is valid and dropped where it is not: finding a low/medium/high
        // tool in a partial sample IS positive evidence and survives (a
        // sample can only omit risk, never invent it), but the ABSENCE of a
        // finding in an incomplete read is not a measurement. Leaving this
        // undefined routes it through score.ts's existing securityPrimaryAbsent
        // path — security is withheld rather than fabricated, and the grade
        // gate handles the rest.
        s.toolSurfaceRisk = schema.surfacePartial && schema.toolSurfaceRisk === 'none'
          ? undefined
          : schema.toolSurfaceRisk
        if (dynamicNote !== undefined) {
          s.findings.push({
            id: 'security/dynamic-tool-surface', dimension: 'security', severity: 'low',
            message: 'Tool registrations are resolved at runtime, so the tool surface cannot be enumerated by static analysis; its risk is unassessed rather than clean.',
            evidence: dynamicEvidence ?? 'tool registrations resolved at runtime (no static evidence file)',
          })
        }
        // W5 (coverage-v1.5, wave2-spec §2.3): partial-surface honesty. When
        // the full tree has more tool-fanout-shaped files than the sample
        // reached (schema.surfacePartial), a toolCount/schemaTokenEstimate
        // derived from that sample would be a confidently WRONG count
        // (figwright: 133 tool files on disk, ~20 fetched under the cap —
        // publishing "20" reads as complete, not partial). Cost signals
        // decline to answer instead of lying; both stay `undefined`, which
        // the rubric already treats as "signal not computable" (band()
        // returns undefined for undefined input — see src/scoring/rubric.ts).
        //
        // Security is NOT withheld: it still grades on the sampled tools
        // below. That's safe in this one direction because max-risk
        // classification is MONOTONE under sampling — toolSurfaceRisk is the
        // max risk tier across whatever tools were seen, and seeing fewer
        // tools can only ever omit a risk finding, never invent one that
        // isn't there. A partial sample can therefore understate risk but
        // can never overstate it, so grading security on it is the safe
        // direction to be incomplete in — unlike toolCount/token estimate,
        // which would be actively wrong (not just incomplete) if published.
        if (!schema.surfacePartial) {
          s.schemaTokenEstimate = schema.schemaTokenEstimate
          if (schema.extracted) s.toolCount = schema.tools.length
          // Rubric 1.7.0: the serialized token footprint is no longer a
          // SCORED signal (src/scoring/rubric.ts dropped `token-footprint`
          // because its absence flattered the ~95% of servers we cannot
          // measure it for) — but it is still a real, checkable measurement
          // for the ~5% we can, so it is published as a FACT instead of
          // discarded. `schemaTokenEstimate` still threads through Signals
          // untouched; nothing in the rubric reads it.
          //
          // Absence is SILENT. No finding when tokenFootprint() declined —
          // never a "0 tokens" or "not measured" line, which is how an
          // unmeasured server would start reading like a cheap one. The
          // surfacePartial gate above applies for the same reason it applies
          // to the counts: a footprint summed over a sample we know is
          // incomplete is a wrong number, not a partial one.
          if (s.schemaTokenEstimate !== undefined) {
            const sources = [...new Set(schema.tools.map(t => t.evidence))]
            const shown = sources.slice(0, 3).join(', ')
            s.findings.push({
              id: 'cost/token-footprint', dimension: 'cost', severity: 'info',
              message: `Tool schemas reconstruct to ~${s.schemaTokenEstimate.toLocaleString('en-US')} tokens of a tools/list response for a GPT-family tokenizer, from the declared JSON schemas of the ${s.toolCount ?? 0} extracted definitions. Other tokenizers, and any fields the server adds, will differ.`,
              evidence: sources.length > 3 ? `${shown}, +${sources.length - 3} more` : shown,
            })
          }
        }
        // D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md
        // Task 3): thread the resolved rung's tool surface through Signals for
        // SNAPSHOTTING only — an artifact, never a signal (rubric.ts provably
        // never reads these fields; tests/assemble.test.ts asserts it). Set
        // together iff extraction produced >=1 tool; both stay undefined
        // otherwise — absence != an empty surface. The single resolved
        // `schema` here covers BOTH extraction sites: provenance comes from
        // schema.readmeSourced, the same flag s.readmeSourced records above,
        // so the snapshot source can never drift from the published one.
        // D2 review (IMPORTANT): gated on !surfacePartial, aligned with the
        // toolCount/schemaTokenEstimate withhold below. A partial extraction
        // snapshots whichever SUBSET the sampler happened to fetch, so two
        // scans of the same unchanged repo could snapshot different subsets
        // and the drift feed would report fake "tools added/removed" within
        // one EXTRACTOR_VERSION — manufacturing exactly the false drift the
        // suppression rules exist to prevent. No snapshot for partial reads;
        // missing-snapshot-is-not-removal already keeps that honest.
        if (schema.tools.length > 0 && !schema.surfacePartial) {
          s.tools = schema.tools.map(({ evidence: _evidence, ...t }) => t)  // strip evidence: hashes must cover tool content, not our file paths
          s.toolSource = schema.readmeSourced ? 'readme-catalog' : 'code'
        }
        s.findings.push(...schema.findings)
        const secrets = scanSecrets(snap.files)
        s.secretsFound = secrets.count
        s.findings.push(...secrets.findings)
        // D1 (integrity-v1): integrityHits/integrityScanned remain
        // findings-only passthroughs for rendering — score.ts never reads
        // the hits list itself. Gated on the same snap.treePaths branch as
        // everything else above, so "absence != clean" holds: if this
        // branch didn't run, integrityHits/hiddenPayloadDecoded stay
        // undefined and report/terminal.ts prints "not checked" rather than
        // a false "clean".
        // D2 (integrity-phase2, docs/superpowers/plans/2026-08-04-integrity-v1.md
        // "Phase 2"): hiddenPayloadDecoded counts ONLY decode-confirmed
        // 'hidden-payload' hits — never 'invisible-chars-observed' or
        // 'bidi-override-observed', which are observations, not evidence of
        // concealment, and must never affect scoring. score.ts reads this
        // single count as a disqualifying override on the security
        // dimension (see the rationale comment there); it stays undefined
        // (not 0) whenever this branch didn't run, so the override provably
        // cannot fire on a server we never scanned.
        // W6 review remediation item 1: README-derived tool DESCRIPTIONS
        // already reach this scan via schema.tools (readmeSourced tools
        // carry name/description/schemaText same as any other tool) — that
        // path is untouched. Separately, the raw README TEXT is real fetched
        // content and integrity scanning is offline/deterministic/display-
        // only (never feeds score.ts), so it is scanned too — passed here
        // explicitly via snap.readme (never implicitly via snap.files) so
        // integrityScanned's `files` denominator honestly counts it when
        // present. See integrity.ts's trap #5 for the up-to-date statement
        // of what is and isn't fetched/scanned.
        const integrity = scanIntegrity(snap.files, schema.tools, snap.readme)
        s.findings.push(...integrity.findings)
        s.integrityHits = integrity.hits
        s.integrityScanned = integrity.scanned
        s.hiddenPayloadDecoded = integrity.hits.filter(h => h.kind === 'hidden-payload').length
      } else {
        s.errors.push('github: file tree unavailable; repo-content signals skipped')
      }
    } catch (err) {
      // W1: a 404 on repo metadata (RepoNotFoundError) means the repo is
      // gone — a distinct terminal state, not a generic collector hiccup.
      // Everything else (network errors, 403, 5xx) keeps today's behavior:
      // recorded in errors[], surfaced later as insufficientData.
      if (err instanceof RepoNotFoundError) s.unresolved = true
      s.errors.push(`github: ${(err as Error).message}`)
    }
  } else {
    s.errors.push('github: no repository could be resolved for this ref')
  }

  if (identity.npmPackage) {
    try {
      const npm = await collectNpm(identity.npmPackage, http)
      s.weeklyDownloads = npm.weeklyDownloads
      if (npm.deprecated) {
        s.findings.push({
          id: 'health/deprecated-package', dimension: 'health', severity: 'high',
          message: `Package "${identity.npmPackage}" is marked deprecated on npm.`,
          evidence: `https://www.npmjs.com/package/${identity.npmPackage}`,
        })
      }
      deps.push(...depsFromManifest(npm.dependencies, 'npm'))
    } catch (err) {
      s.errors.push(`npm: ${(err as Error).message}`)
    }
  }

  if (identity.pypiPackage) {
    try {
      const pypi = await collectPypi(identity.pypiPackage, http)
      for (const spec of pypi.requiresDist) {
        const m = spec.match(/^([\w.-]+)\s*(?:\[[^\]]*\])?\s*(?:==|>=|~=)\s*([\d.]+)/)
        if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'PyPI' })
      }
    } catch (err) {
      s.errors.push(`pypi: ${(err as Error).message}`)
    }
  }

  // Prefer exact resolved versions from a committed lockfile over the manifest
  // floor, per ecosystem: this catches transitive deps and versions already
  // patched within the declared range, avoiding both over- and under-reporting
  // CVEs (see src/derive/lockfile.ts). Falls back to floors when no supported
  // lockfile was fetched (labelled approximate — no code change needed here,
  // that's simply the pre-existing `deps` array being left untouched).
  const lockDeps = repoFiles ? parseLockfile(repoFiles) : []
  if (lockDeps.length > 0) {
    const lockEcosystems = new Set(lockDeps.map(d => d.ecosystem))
    const floorDeps = deps.filter(d => !lockEcosystems.has(d.ecosystem))
    deps.length = 0
    deps.push(...floorDeps, ...lockDeps)
  }

  // A large monorepo lockfile can resolve into many hundreds/thousands of
  // transitive deps; cap the OSV batch so one repo can't blow up a single
  // query (or the downstream findings list) unboundedly.
  const cappedDeps = deps.slice(0, 400)

  try {
    const osv = await collectOsv(cappedDeps, http)
    s.cveWorst = osv.cveWorst
    s.findings.push(...osv.findings)
  } catch (err) {
    s.errors.push(`osv: ${(err as Error).message}`)
  }

  return s
}
