import type { Http } from '../util/http.js'
import type { Finding } from '../types.js'

export interface Dep { name: string; version: string; ecosystem: 'npm' | 'PyPI' }
type Worst = 'none' | 'low' | 'medium' | 'high' | 'critical'

/** Declared version floors (^~>= stripped) — an approximation, noted in methodology. */
export function depsFromManifest(dependencies: Record<string, string>, ecosystem: 'npm' | 'PyPI'): Dep[] {
  const deps: Dep[] = []
  for (const [name, range] of Object.entries(dependencies)) {
    const m = range.match(/(\d+(?:\.\d+)*(?:[-.][\w.]+)?)/)
    if (m) deps.push({ name, version: m[1], ecosystem })
  }
  return deps
}

function levelOf(vuln: { severity?: Array<{ score?: string }> }): Worst {
  const scores = (vuln.severity ?? [])
    .map(s => Number.parseFloat(s.score ?? ''))
    .filter(n => !Number.isNaN(n))
  const max = scores.length > 0 ? Math.max(...scores) : undefined
  if (max === undefined) return 'medium' // unknown severity on a real vuln
  return max >= 9 ? 'critical' : max >= 7 ? 'high' : max >= 4 ? 'medium' : 'low'
}

const ORDER: Worst[] = ['none', 'low', 'medium', 'high', 'critical']

export async function collectOsv(deps: Dep[], http: Http): Promise<{ cveWorst: Worst | undefined; findings: Finding[] }> {
  if (deps.length === 0) return { cveWorst: undefined, findings: [] }
  interface Res { results?: Array<{ vulns?: Array<{ id: string; severity?: Array<{ score?: string }> }> }> }
  const res = await http.postJson<Res>('https://api.osv.dev/v1/querybatch', {
    queries: deps.map(d => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
  })
  let worst: Worst = 'none'
  const findings: Finding[] = []
  ;(res.results ?? []).forEach((r, i) => {
    for (const v of r.vulns ?? []) {
      const level = levelOf(v)
      if (ORDER.indexOf(level) > ORDER.indexOf(worst)) worst = level
      findings.push({
        id: 'security/dependency-cve', dimension: 'security',
        severity: level === 'critical' || level === 'high' ? 'high' : level === 'medium' ? 'medium' : 'low',
        message: `Dependency ${deps[i].name}@${deps[i].version} has known vulnerability ${v.id}.`,
        evidence: `https://osv.dev/vulnerability/${v.id}`,
      })
    }
  })
  return { cveWorst: worst, findings }
}
