import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import type { Http } from '../src/util/http.js'

const NOW = new Date('2026-07-31T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

function fullFake(): Http {
  const routes: Record<string, unknown> = {
    'https://api.github.com/repos/acme/foo/commits?since': [
      { sha: '1', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
      { sha: '2', commit: { author: { date: iso(3) } }, author: { login: 'a' } },
      { sha: '3', commit: { author: { date: iso(4) } }, author: { login: 'a' } },
    ],
    'https://api.github.com/repos/acme/foo/releases/latest': { published_at: iso(10) },
    'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': {
      tree: [
        { path: 'package.json', type: 'blob', size: 300 },
        { path: 'src/index.ts', type: 'blob', size: 500 },
        { path: '.github/workflows/ci.yml', type: 'blob', size: 100 },
        { path: 'package-lock.json', type: 'blob', size: 100 },
        { path: 'tests/x.test.ts', type: 'blob', size: 100 },
      ],
    },
    'https://api.github.com/repos/acme/foo': {
      stargazers_count: 300, archived: false, pushed_at: iso(2), default_branch: 'main',
    },
    'https://registry.npmjs.org/foo-mcp': {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dependencies: { zod: '^3.22.0' } } },
    },
    'https://api.npmjs.org/downloads/point/last-week/foo-mcp': { downloads: 2000 },
  }
  return {
    async json<T>(url: string): Promise<T> {
      for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    // Real (not a stub): collectGithub paginates commits through this method,
    // and this fixture's single page has no Link header → one page, as before.
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { data: body as T, headers: new Headers() }
      }
      throw new Error(`HTTP 404 for ${url}`)
    },
    async postJson<T>(url: string): Promise<T> {
      if (url.includes('osv.dev')) return { results: [{}] } as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    async text(url: string): Promise<string> {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.2.0' } })
      if (url.endsWith('src/index.ts')) return `server.tool('greet', 'Say hello', {}, h)`
      throw new Error(`HTTP 404 for ${url}`)
    },
  }
}

describe('assemble', () => {
  it('merges github + derivers + npm + osv into Signals', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      fullFake(), NOW,
    )
    expect(s.daysSinceLastCommit).toBe(2)
    expect(s.daysSinceLastRelease).toBe(10)
    expect(s.commitsLast90Days).toBe(3)
    expect(s.stars).toBe(300)
    expect(s.hasCI).toBe(true)
    expect(s.hasTests).toBe(true)
    expect(s.hasLockfile).toBe(true)
    expect(s.specEra).toBe('modern')
    expect(s.schemaExtracted).toBe(true)
    expect(s.toolCount).toBe(1)
    expect(s.toolSurfaceRisk).toBe('none')
    expect(s.secretsFound).toBe(0)
    expect(s.weeklyDownloads).toBe(2000)
    expect(s.cveWorst).toBe('none')
    expect(s.errors).toEqual([])
  })
  it('a failing collector degrades gracefully into errors[], never throws', async () => {
    const http = fullFake()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('registry.npmjs.org')) throw new Error('HTTP 500 for npm')
      return orig<T>(url)
    }
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(s.daysSinceLastCommit).toBe(2)       // github part still fine
    expect(s.weeklyDownloads).toBeUndefined()   // npm part absent
    expect(s.errors.some(e => e.startsWith('npm:'))).toBe(true)
  })
  it('tree fetch failure skips repo-content signals and notes it', async () => {
    const http = fullFake()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) throw new Error('HTTP 500')
      return orig<T>(url)
    }
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(s.hasCI).toBeUndefined()
    expect(s.hasTests).toBeUndefined()
    expect(s.hasLockfile).toBeUndefined()
    expect(s.specEra).toBeUndefined()
    expect(s.schemaExtracted).toBeUndefined()
    expect(s.secretsFound).toBeUndefined()
    expect(s.toolCount).toBeUndefined()
    expect(s.errors).toContain('github: file tree unavailable; repo-content signals skipped')
    expect(s.daysSinceLastCommit).toBe(2) // metadata signals still intact
  })
  it('prefers resolved lockfile versions over manifest floors for the OSV query', async () => {
    const http = fullFake()
    const origText = http.text.bind(http)
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package-lock.json')) {
        return JSON.stringify({
          packages: {
            '': { name: 'foo', version: '1.0.0' },
            'node_modules/zod': { version: '3.22.5' }, // resolved version differs from the ^3.22.0 floor
          },
        })
      }
      return origText(url)
    }
    let queriedVersions: string[] = []
    http.postJson = async <T,>(url: string, body: unknown): Promise<T> => {
      if (url.includes('osv.dev')) {
        queriedVersions = (body as { queries: Array<{ version: string }> }).queries.map(q => q.version)
        return { results: [{}] } as T
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(queriedVersions).toEqual(['3.22.5']) // lockfile-resolved, not the '3.22.0' manifest floor
  })
})
