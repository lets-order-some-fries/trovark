import type { Http } from './util/http.js'
import type { ServerIdentity } from './resolver.js'
import type { Signals } from './types.js'
import { collectGithub } from './collectors/github.js'
import { collectNpm } from './collectors/npm.js'
import { collectPypi } from './collectors/pypi.js'
import { collectOsv, depsFromManifest, type Dep } from './collectors/osv.js'
import { repoChecks } from './derive/repoChecks.js'
import { specEra } from './derive/specEra.js'
import { extractSchema } from './derive/schema.js'
import { scanSecrets } from './derive/secrets.js'

const days = (fromIso: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000))

export async function assemble(
  identity: ServerIdentity, http: Http, now: Date, opts: { hasToken?: boolean } = {},
): Promise<Signals> {
  const s: Signals = { findings: [], errors: [] }
  const deps: Dep[] = []

  if (identity.repo) {
    try {
      const snap = await collectGithub(identity, http, now, opts)
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
        const schema = extractSchema(snap.files)
        s.schemaExtracted = schema.extracted
        s.toolSurfaceRisk = schema.toolSurfaceRisk
        s.schemaTokenEstimate = schema.schemaTokenEstimate
        if (schema.extracted) s.toolCount = schema.tools.length
        s.findings.push(...schema.findings)
        const secrets = scanSecrets(snap.files)
        s.secretsFound = secrets.count
        s.findings.push(...secrets.findings)
      } else {
        s.errors.push('github: file tree unavailable; repo-content signals skipped')
      }
    } catch (err) {
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

  try {
    const osv = await collectOsv(deps, http)
    s.cveWorst = osv.cveWorst
    s.findings.push(...osv.findings)
  } catch (err) {
    s.errors.push(`osv: ${(err as Error).message}`)
  }

  return s
}
