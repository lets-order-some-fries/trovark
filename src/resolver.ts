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

interface NpmPkg { name: string; repository?: string | { url?: string } }
interface PypiPkg { info: { name: string; home_page?: string; project_urls?: Record<string, string> } }

async function fromNpm(name: string, http: Http): Promise<{ npmPackage: string; repo?: { owner: string; name: string } }> {
  const pkg = await http.json<NpmPkg>(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return { npmPackage: pkg.name, repo: repoFrom(repoUrl) }
}

async function fromPypi(name: string, http: Http): Promise<{ pypiPackage: string; repo?: { owner: string; name: string } }> {
  const pkg = await http.json<PypiPkg>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)
  const urls = [pkg.info.home_page, ...Object.values(pkg.info.project_urls ?? {})]
  const repo = urls.map(u => repoFrom(u ?? undefined)).find(Boolean)
  return { pypiPackage: pkg.info.name, repo }
}

export async function resolve(ref: string, http: Http): Promise<ServerIdentity> {
  const gh = ref.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i)
  if (gh) return { ref, repo: { owner: gh[1], name: gh[2].replace(/\.git$/, '') } }

  const npmPrefix = ref.match(/^npm:(.+)$/)
  if (npmPrefix) {
    try {
      return { ref, ...(await fromNpm(npmPrefix[1], http)) }
    } catch {
      throw new ResolveError(
        `Could not resolve "${ref}". Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.`,
      )
    }
  }

  const pypiPrefix = ref.match(/^pypi:(.+)$/)
  if (pypiPrefix) {
    try {
      return { ref, ...(await fromPypi(pypiPrefix[1], http)) }
    } catch {
      throw new ResolveError(
        `Could not resolve "${ref}". Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.`,
      )
    }
  }

  const isScopedNpm = ref.startsWith('@')
  const bare = !isScopedNpm && ref.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (bare) return { ref, repo: { owner: bare[1], name: bare[2] } }

  if (isScopedNpm) {
    try {
      return { ref, ...(await fromNpm(ref, http)) }
    } catch { /* not on npm */ }
    throw new ResolveError(
      `Could not resolve "${ref}". Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.`,
    )
  }

  // Bare plain name (no slash, no prefix): npm and PyPI are both plausible — check concurrently.
  const [npmResult, pypiResult] = await Promise.allSettled([fromNpm(ref, http), fromPypi(ref, http)])

  if (npmResult.status === 'fulfilled' && pypiResult.status === 'fulfilled') {
    throw new ResolveError(
      `"${ref}" exists on both npm and PyPI — ambiguous. Use npm:${ref} or pypi:${ref} to disambiguate.`,
    )
  }
  if (npmResult.status === 'fulfilled') return { ref, ...npmResult.value }
  if (pypiResult.status === 'fulfilled') return { ref, ...pypiResult.value }

  throw new ResolveError(
    `Could not resolve "${ref}". Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.`,
  )
}
