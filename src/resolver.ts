import { HttpError, type Http } from './util/http.js'

export interface ServerIdentity {
  ref: string
  repo?: { owner: string; name: string }
  npmPackage?: string
  pypiPackage?: string
}

/** The ref names nothing we can find: malformed, or no registry has it. A terminal fact about the ref. */
export class ResolveError extends Error {}

/**
 * A registry could not be reached or did not answer (no network, a timeout,
 * a 5xx) while resolving the ref. Says nothing about the ref itself, so it
 * is deliberately NOT a ResolveError: index/audit.ts records a ResolveError
 * as the ref being unresolvable, which an outage must never be counted as.
 *
 * Measured before this existed: with the network down, every ref shape was
 * reported as "Could not resolve <ref>. Accepted forms: ..." — a lecture
 * on ref syntax for an infrastructure failure.
 */
export class RegistryUnreachableError extends Error {}

const ACCEPTED_FORMS = 'Accepted forms: GitHub URL, owner/repo, npm package name, PyPI package name.'
const notFound = (ref: string): ResolveError => new ResolveError(`Could not resolve "${ref}". ${ACCEPTED_FORMS}`)

/** Only a typed 404 means the registry looked and has no such package. Anything else is the registry failing us. */
const isNotFound = (err: unknown): boolean => err instanceof HttpError && err.status === 404

function describeFailure(err: unknown): string {
  const e = err as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null
  const message = typeof e?.message === 'string' ? e.message : String(err)
  const cause = e?.cause
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : undefined
  return detail !== undefined && !message.includes(detail) ? `${message} (${detail})` : message
}

/**
 * `failures` are the registries that did not answer with a 404; `absent`
 * are the ones that did. The ref may or may not exist — the honest
 * statement is that we could not find out.
 */
function unreachable(ref: string, failures: Array<[registry: string, err: unknown]>, absent: string[] = []): RegistryUnreachableError {
  const detail = failures.map(([registry, err]) => `${registry}: ${describeFailure(err)}`).join('; ')
  const absentNote = absent.length > 0 ? ` (${absent.join(' and ')} reported no package by that name)` : ''
  return new RegistryUnreachableError(
    `Could not reach ${failures.map(([r]) => r).join(' or ')} to resolve "${ref}" — ${detail}${absentNote}. `
    + 'This is a network or registry failure, not a problem with the ref; check connectivity and try again.',
  )
}

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
    } catch (err) {
      throw isNotFound(err) ? notFound(ref) : unreachable(ref, [['the npm registry', err]])
    }
  }

  const pypiPrefix = ref.match(/^pypi:(.+)$/)
  if (pypiPrefix) {
    try {
      return { ref, ...(await fromPypi(pypiPrefix[1], http)) }
    } catch (err) {
      throw isNotFound(err) ? notFound(ref) : unreachable(ref, [['PyPI', err]])
    }
  }

  const isScopedNpm = ref.startsWith('@')
  const bare = !isScopedNpm && ref.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (bare) return { ref, repo: { owner: bare[1], name: bare[2] } }

  if (isScopedNpm) {
    try {
      return { ref, ...(await fromNpm(ref, http)) }
    } catch (err) {
      throw isNotFound(err) ? notFound(ref) : unreachable(ref, [['the npm registry', err]])
    }
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

  // Both rejected. "Not found" is only established when BOTH registries
  // answered 404; if either one failed to answer, the name may well exist
  // there and the honest report is that we could not find out.
  const outcomes: Array<[registry: string, err: unknown]> = [
    ['the npm registry', npmResult.reason], ['PyPI', pypiResult.reason],
  ]
  const failures = outcomes.filter(([, err]) => !isNotFound(err))
  if (failures.length > 0) {
    throw unreachable(ref, failures, outcomes.filter(([, err]) => isNotFound(err)).map(([r]) => r))
  }
  throw notFound(ref)
}
