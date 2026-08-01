import { describe, expect, it } from 'vitest'
import { ResolveError, resolve } from '../src/resolver.js'
import type { Http } from '../src/util/http.js'

const httpOf = (routes: Record<string, unknown>): Http => ({
  async json<T>(url: string): Promise<T> {
    for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
    throw new Error(`HTTP 404 for ${url}`)
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
