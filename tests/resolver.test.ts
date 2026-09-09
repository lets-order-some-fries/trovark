import { describe, expect, it } from 'vitest'
import { RegistryUnreachableError, ResolveError, resolve } from '../src/resolver.js'
import { HttpError } from '../src/util/http.js'
import type { Http } from '../src/util/http.js'

// A route that is not in the table is a package the registry does not have:
// the real http layer throws a typed 404 for that (see createHttp), and the
// resolver now tells a 404 apart from a registry it could not reach.
const httpOf = (routes: Record<string, unknown>): Http => ({
  async json<T>(url: string): Promise<T> {
    for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
    throw new HttpError(404, url)
  },
  async jsonWithHeaders() { throw new Error('unused') },
  async text() { throw new Error('unused') },
  async postJson() { throw new Error('unused') },
})

describe('resolve()', () => {
  it('parses a GitHub URL', async () => {
    const id = await resolve('https://github.com/acme/foo-mcp', httpOf({}))
    expect(id.repo).toEqual({ owner: 'acme', name: 'foo-mcp' })
  })
  it('strips .git and deep paths from GitHub URLs', async () => {
    const id = await resolve('https://github.com/acme/foo.git', httpOf({}))
    expect(id.repo).toEqual({ owner: 'acme', name: 'foo' })
  })
  it('parses bare owner/repo', async () => {
    const id = await resolve('acme/foo', httpOf({}))
    expect(id.repo).toEqual({ owner: 'acme', name: 'foo' })
  })
  it('resolves an npm package and follows its repository URL', async () => {
    const id = await resolve('some-mcp', httpOf({
      'https://registry.npmjs.org/some-mcp': {
        name: 'some-mcp', repository: { url: 'git+https://github.com/acme/some-mcp.git' },
      },
    }))
    expect(id.npmPackage).toBe('some-mcp')
    expect(id.repo).toEqual({ owner: 'acme', name: 'some-mcp' })
  })
  it('scoped npm names never parse as owner/repo', async () => {
    const id = await resolve('@scope/pkg', httpOf({
      'https://registry.npmjs.org/%40scope%2Fpkg': { name: '@scope/pkg' },
    }))
    expect(id.npmPackage).toBe('@scope/pkg')
    expect(id.repo).toBeUndefined()
  })
  it('falls back to PyPI when npm 404s', async () => {
    const id = await resolve('mcp-server-fetch', httpOf({
      'https://pypi.org/pypi/mcp-server-fetch/json': {
        info: { name: 'mcp-server-fetch', project_urls: { Repository: 'https://github.com/acme/fetch' } },
      },
    }))
    expect(id.pypiPackage).toBe('mcp-server-fetch')
    expect(id.repo).toEqual({ owner: 'acme', name: 'fetch' })
  })
  it('throws ResolveError with accepted forms listed when nothing matches', async () => {
    await expect(resolve('definitely-not-a-thing', httpOf({}))).rejects.toThrow(ResolveError)
  })
  it('throws ResolveError naming both registries when a bare name exists on npm AND PyPI', async () => {
    await expect(resolve('dual-pkg', httpOf({
      'https://registry.npmjs.org/dual-pkg': { name: 'dual-pkg' },
      'https://pypi.org/pypi/dual-pkg/json': { info: { name: 'dual-pkg' } },
    }))).rejects.toThrow(/both npm and PyPI.*npm:dual-pkg.*pypi:dual-pkg/s)
  })
  it('npm: prefix forces npm and skips PyPI', async () => {
    const id = await resolve('npm:dual-pkg', httpOf({
      'https://registry.npmjs.org/dual-pkg': { name: 'dual-pkg' },
      'https://pypi.org/pypi/dual-pkg/json': { info: { name: 'dual-pkg' } },
    }))
    expect(id.npmPackage).toBe('dual-pkg')
    expect(id.pypiPackage).toBeUndefined()
    expect(id.ref).toBe('npm:dual-pkg')
  })
  it('pypi: prefix forces PyPI and skips npm', async () => {
    const id = await resolve('pypi:dual-pkg', httpOf({
      'https://registry.npmjs.org/dual-pkg': { name: 'dual-pkg' },
      'https://pypi.org/pypi/dual-pkg/json': { info: { name: 'dual-pkg' } },
    }))
    expect(id.pypiPackage).toBe('dual-pkg')
    expect(id.npmPackage).toBeUndefined()
    expect(id.ref).toBe('pypi:dual-pkg')
  })
})

// Every failure to look a ref up used to be reported as "Could not resolve
// <ref>. Accepted forms: ..." — a lecture on ref syntax for what was
// actually a registry outage or no network. Measured at f7f4f34 with the
// fake-fetch harness: fetch throwing ECONNREFUSED for "@scope/pkg" and for a
// bare name, and a 503 from the npm registry for "npm:name", all produced
// that message. Only a typed 404 means "no such package".
describe('resolve() — a registry it could not reach is not a malformed ref', () => {
  const networkDown = (): Http => ({
    async json(): Promise<never> {
      const e = new TypeError('fetch failed') as TypeError & { cause?: unknown }
      e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })
      throw e
    },
    async jsonWithHeaders() { throw new Error('unused') },
    async text() { throw new Error('unused') },
    async postJson() { throw new Error('unused') },
  })
  const statusFor = (status: number, hostFilter?: (url: string) => boolean): Http => ({
    async json(url: string): Promise<never> {
      throw new HttpError(hostFilter === undefined || hostFilter(url) ? status : 404, url)
    },
    async jsonWithHeaders() { throw new Error('unused') },
    async text() { throw new Error('unused') },
    async postJson() { throw new Error('unused') },
  })
  const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('resolved') }, (e: Error) => e)

  it('network down, scoped npm name → RegistryUnreachableError naming npm and the cause, no syntax lecture', async () => {
    const err = await rejection(resolve('@scope/pkg', networkDown()))
    expect(err).toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/npm/)
    expect(err.message).toMatch(/ECONNREFUSED/)
    expect(err.message).not.toMatch(/Accepted forms/)
  })
  it('network down, bare name → names both registries it tried', async () => {
    const err = await rejection(resolve('some-name', networkDown()))
    expect(err).toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/npm/)
    expect(err.message).toMatch(/PyPI/)
    expect(err.message).not.toMatch(/Accepted forms/)
  })
  it('npm registry 503 for an npm: ref → unreachable, carrying the status', async () => {
    const err = await rejection(resolve('npm:name', statusFor(503)))
    expect(err).toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/503/)
    expect(err.message).not.toMatch(/Accepted forms/)
  })
  it('PyPI 502 for a pypi: ref → unreachable', async () => {
    const err = await rejection(resolve('pypi:name', statusFor(502)))
    expect(err).toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/PyPI/)
    expect(err.message).not.toMatch(/Accepted forms/)
  })
  it('bare name: npm says 404 but PyPI is down → unreachable, not "not found" (absence was never established)', async () => {
    const err = await rejection(resolve('some-name', statusFor(503, u => u.includes('pypi.org'))))
    expect(err).toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/PyPI/)
    expect(err.message).toMatch(/npm/)
    expect(err.message).not.toMatch(/Accepted forms/)
  })
  it('a typed 404 from both registries is still "could not resolve" with the accepted forms', async () => {
    const err = await rejection(resolve('definitely-not-a-thing', httpOf({})))
    expect(err).toBeInstanceOf(ResolveError)
    expect(err).not.toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/Accepted forms/)
  })
  it('a typed 404 for an npm: ref is "could not resolve", not unreachable', async () => {
    const err = await rejection(resolve('npm:nope', httpOf({})))
    expect(err).not.toBeInstanceOf(RegistryUnreachableError)
    expect(err.message).toMatch(/Accepted forms/)
  })
})
