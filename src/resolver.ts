import type { Http } from './util/http.js'

export interface ServerIdentity {
  ref: string
  repo?: { owner: string; name: string }
  npmPackage?: string
  pypiPackage?: string
}

export class ResolveError extends Error {}

const GITHUB_IN_URL = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i

function repoFrom(url: string | undefined): { owner: string; name: string } | undefined {
  const m = url?.match(GITHUB_IN_URL)
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, '') } : undefined
}

export async function resolve(ref: string, http: Http): Promise<ServerIdentity> {
  const gh = ref.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i)
  if (gh) return { ref, repo: { owner: gh[1], name: gh[2].replace(/\.git$/, '') } }

  const isScopedNpm = ref.startsWith('@')
  const bare = !isScopedNpm && ref.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (bare) return { ref, repo: { owner: bare[1], name: bare[2] } }

  // package name: try npm, then PyPI
  try {
    interface NpmPkg { name: string; repository?: string | { url?: string } }
    const pkg = await http.json<NpmPkg>(`https://registry.npmjs.org/${encodeURIComponent(ref)}`)
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    return { ref, npmPackage: pkg.name, repo: repoFrom(repoUrl) }
  } catch { /* not on npm */ }
  try {
    interface PypiPkg { info: { name: string; home_page?: string; project_urls?: Record<string, string> } }
    const pkg = await http.json<PypiPkg>(`https://pypi.org/pypi/${encodeURIComponent(ref)}/json`)
    const urls = [pkg.info.home_page, ...Object.values(pkg.info.project_urls ?? {})]
    const repo = urls.map(u => repoFrom(u ?? undefined)).find(Boolean)
    return { ref, pypiPackage: pkg.info.name, repo }
  } catch { /* not on PyPI */ }

  throw new ResolveError(
    `Could not resolve "${ref}". Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.`,
  )
}
