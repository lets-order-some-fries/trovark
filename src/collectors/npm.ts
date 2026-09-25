import { rethrowIfCallerSide, type Http } from '../util/http.js'

export interface NpmInfo {
  weeklyDownloads?: number
  deprecated?: boolean
  dependencies: Record<string, string>
  // DF-4 (artifact identity): WHICH release this document describes, and the
  // commit npm recorded it was published from. Both come off the SAME
  // registry document the fields above are already read from — no extra
  // request. `publishedGitHead` stays undefined for the ~37% of packages that
  // publish no gitHead at all (measured across the top 40 npm "mcp server"
  // packages: 15 of 40): absence is absence, never the repository's own HEAD.
  latestVersion?: string
  publishedGitHead?: string
}

export async function collectNpm(pkg: string, http: Http): Promise<NpmInfo> {
  interface Doc { 'dist-tags'?: { latest?: string }; versions?: Record<string, { deprecated?: unknown; gitHead?: string; dependencies?: Record<string, string> }> }
  const doc = await http.json<Doc>(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`)
  const latest = doc['dist-tags']?.latest
  const v = latest !== undefined ? doc.versions?.[latest] : undefined
  const weeklyDownloads = await http
    .json<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`)
    .then(d => d.downloads)
    // Downloads are a nice-to-have, so any failure here leaves them undefined
    // — except an exhausted budget, which is the caller's problem and must
    // escape like it does from every other catch that wraps a request.
    .catch((err: unknown) => { rethrowIfCallerSide(err); return undefined })
  return {
    weeklyDownloads,
    deprecated: v ? Boolean(v.deprecated) : undefined,
    dependencies: v?.dependencies ?? {},
    latestVersion: latest,
    publishedGitHead: v?.gitHead,
  }
}
