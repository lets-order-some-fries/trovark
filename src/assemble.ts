import type { Http } from './util/http.js'
import type { ServerIdentity } from './resolver.js'
import type { Signals } from './types.js'
import { collectGithub, RepoNotFoundError, isRootReadme, type RepoFile } from './collectors/github.js'
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
        const staticSchema = extractSchema(snap.files, snap.treePaths, snap.toolFanoutCount)
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
        // fires — read below to floor (never renormalize) the security
        // dimension's primary signal instead of letting it drop out.
        let dynamicNote: string | undefined
        if (classification) {
          s.notServer = true
          s.notServerReason = classification.reason
          s.notServerNote = classification.note
        } else if (staticSchema.tools.length === 0) {
          // W6 (Task W6 Part B / wave2-spec §3 R6 ordering rule 2): the
          // dynamic-surface check runs BEFORE the README rung, and ONLY once
          // classifyLibrary declined (a library/SDK is never "dynamic" — it
          // has no tool surface by design, not an unknowable one).
          const dyn = detectDynamic({
            files: snap.files, treePaths: snap.treePaths, description: snap.description, topics: snap.topics,
          })
          if (dyn) {
            s.notServer = true
            s.notServerReason = 'dynamic'
            s.notServerNote = dyn.note
            dynamicNote = dyn.note
          } else {
            // W6 (Task W6 Part A): the README-catalog rung — reachable only
            // once we know this repo is neither a library nor dynamic-shaped.
            const readmeFile = snap.files.find(f => isRootReadme(f.path))
            if (readmeFile) schema = extractSchema(snap.files, snap.treePaths, snap.toolFanoutCount, readmeFile)
          }
        }

        s.schemaExtracted = schema.extracted && !schema.readmeSourced
        // W6 (Task W6 Part B point 3): do NOT let the tool-surface signal
        // drop out (undefined) for a dynamic server and let security
        // renormalize onto no-secrets/dependency-cves alone — a gateway
        // exposing an unbounded, unknown upstream tool surface is the
        // highest-risk shape in the corpus, not a neutral one (this is
        // exactly what securityPrimaryAbsent in score.ts exists to prevent
        // for every OTHER zero-signal case; notServer already bypasses that
        // gate, so the floor has to be applied here instead). `schema` is
        // `staticSchema` in this branch (0 tools, toolSurfaceRisk normally
        // undefined unless the shell-import fallback already floored it to
        // 'medium' — 'high' is the stronger, structural signal and wins).
        s.toolSurfaceRisk = dynamicNote !== undefined ? 'high' : schema.toolSurfaceRisk
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
        const integrity = scanIntegrity(snap.files, schema.tools)
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
