import type { Http } from '../util/http.js'

export async function collectPypi(pkg: string, http: Http): Promise<{ requiresDist: string[] }> {
  interface Doc { info: { requires_dist?: string[] | null } }
  const doc = await http.json<Doc>(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`)
  return { requiresDist: doc.info.requires_dist ?? [] }
}
