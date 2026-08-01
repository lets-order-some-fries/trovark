import { describe, expect, it } from 'vitest'
import { collectNpm } from '../src/collectors/npm.js'
import { collectPypi } from '../src/collectors/pypi.js'
import { collectOsv, depsFromManifest } from '../src/collectors/osv.js'
import type { Http } from '../src/util/http.js'

const httpOf = (routes: Record<string, unknown>): Http => ({
  async json<T>(url: string): Promise<T> {
    for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
    throw new Error(`HTTP 404 for ${url}`)
  },
  async text() { throw new Error('unused') },
  async postJson() { throw new Error('unused') },
})

describe('collectNpm', () => {
  it('reads downloads, deprecation, dependencies', async () => {
    const http = httpOf({
      'https://registry.npmjs.org/foo': {
        'dist-tags': { latest: '2.0.0' },
        versions: { '2.0.0': { deprecated: 'use bar instead', dependencies: { zod: '^3.0.0' } } },
      },
      'https://api.npmjs.org/downloads/point/last-week/foo': { downloads: 4321 },
    })
    const r = await collectNpm('foo', http)
    expect(r.weeklyDownloads).toBe(4321)
    expect(r.deprecated).toBe(true)
    expect(r.dependencies).toEqual({ zod: '^3.0.0' })
  })
})

describe('collectPypi', () => {
  it('reads requires_dist', async () => {
    const http = httpOf({
      'https://pypi.org/pypi/foo/json': { info: { requires_dist: ['mcp>=1.0', 'httpx>=0.27'] } },
    })
    expect((await collectPypi('foo', http)).requiresDist).toEqual(['mcp>=1.0', 'httpx>=0.27'])
  })
})

describe('depsFromManifest', () => {
  it('strips range prefixes', () => {
    expect(depsFromManifest({ zod: '^3.22.0', left: '~1.0.0', x: '>=2.1.0' }, 'npm')).toEqual([
      { name: 'zod', version: '3.22.0', ecosystem: 'npm' },
      { name: 'left', version: '1.0.0', ecosystem: 'npm' },
      { name: 'x', version: '2.1.0', ecosystem: 'npm' },
    ])
  })
})

describe('collectOsv', () => {
  it('maps CVSS >= 9 to critical and emits evidence-linked findings', async () => {
    const http: Http = {
      async json() { throw new Error('unused') },
      async text() { throw new Error('unused') },
      async postJson<T>(url: string, body: unknown): Promise<T> {
        expect(url).toBe('https://api.osv.dev/v1/querybatch')
        expect(body).toEqual({ queries: [{ package: { name: 'zod', ecosystem: 'npm' }, version: '1.0.0' }] })
        return { results: [{ vulns: [{ id: 'GHSA-xxxx', severity: [{ type: 'CVSS_V3', score: '9.8' }] }] }] } as T
      },
    }
    const r = await collectOsv([{ name: 'zod', version: '1.0.0', ecosystem: 'npm' }], http)
    expect(r.cveWorst).toBe('critical')
    expect(r.findings[0]).toMatchObject({
      id: 'security/dependency-cve', severity: 'high',
      evidence: 'https://osv.dev/vulnerability/GHSA-xxxx',
    })
  })
  it('no vulns → none', async () => {
    const http: Http = {
      async json() { throw new Error('unused') },
      async text() { throw new Error('unused') },
      async postJson<T>(): Promise<T> { return { results: [{}] } as T },
    }
    expect((await collectOsv([{ name: 'a', version: '1', ecosystem: 'npm' }], http)).cveWorst).toBe('none')
  })
  it('empty deps → none without network', async () => {
    const http: Http = {
      async json() { throw new Error('unused') },
      async text() { throw new Error('unused') },
      async postJson() { throw new Error('should not be called for empty deps') },
    }
    expect((await collectOsv([], http)).cveWorst).toBe('none')
  })
})
