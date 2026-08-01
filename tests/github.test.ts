import { describe, expect, it } from 'vitest'
import { collectGithub } from '../src/collectors/github.js'
import type { Http } from '../src/util/http.js'

const NOW = new Date('2026-07-31T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

function fakeHttp(): Http {
  const routes: Record<string, unknown> = {
    'https://api.github.com/repos/acme/foo/commits?since': [
      // 365d listing reused for both windows in this fixture
      { sha: '1', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
      { sha: '2', commit: { author: { date: iso(5) } }, author: { login: 'a' } },
      { sha: '3', commit: { author: { date: iso(9) } }, author: { login: 'a' } },
      { sha: '4', commit: { author: { date: iso(50) } }, author: { login: 'b' } },
      { sha: '5', commit: { author: { date: iso(120) } }, author: { login: 'b' } },
      { sha: '6', commit: { author: { date: iso(130) } }, author: { login: 'b' } },
    ],
    'https://api.github.com/repos/acme/foo/releases/latest': { published_at: iso(30) },
    'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': {
      tree: [
        { path: 'package.json', type: 'blob', size: 500 },
        { path: 'src/index.ts', type: 'blob', size: 2000 },
        { path: '.github/workflows/ci.yml', type: 'blob', size: 300 },
        { path: 'huge.ts', type: 'blob', size: 5_000_000 },
      ],
    },
    'https://api.github.com/repos/acme/foo': {
      stargazers_count: 1234, archived: false, pushed_at: iso(2), default_branch: 'main',
    },
  }
  return {
    async json<T>(url: string): Promise<T> {
      for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    async text(url: string): Promise<string> {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('src/index.ts')) return 'export {}'
      throw new Error(`HTTP 404 for ${url}`)
    },
    async postJson() { throw new Error('unused') },
  }
}

describe('collectGithub', () => {
  it('builds a snapshot: meta, commits window, bus factor, tree, sampled files', async () => {
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, fakeHttp(), NOW)
    expect(snap.stars).toBe(1234)
    expect(snap.archived).toBe(false)
    expect(snap.commitsLast90Days).toBe(4) // days 2,5,9,50
    expect(snap.busFactor).toBe(2)         // a:3 commits, b:3 commits
    expect(snap.latestReleaseAt).toBeDefined()
    expect(snap.treePaths).toContain('.github/workflows/ci.yml')
    expect(snap.files.map(f => f.path)).toEqual(expect.arrayContaining(['package.json', 'src/index.ts']))
    expect(snap.files.map(f => f.path)).not.toContain('huge.ts') // size cap
    expect(snap.medianIssueResponseDays).toBeUndefined() // no token
  })
  it('throws when identity has no repo', async () => {
    await expect(collectGithub({ ref: 'x' }, fakeHttp(), NOW)).rejects.toThrow(/repo/i)
  })
  it('missing releases endpoint is not fatal', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/releases/latest')) throw new Error('HTTP 404')
      return orig<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.latestReleaseAt).toBeUndefined()
  })
  it('commits fetch failure yields undefined activity signals, not zeros', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/commits?since')) throw new Error('HTTP 500')
      return orig<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.commitsLast90Days).toBeUndefined()
    expect(snap.busFactor).toBeUndefined()
  })
  it('tree fetch failure yields undefined treePaths (distinct from empty repo)', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) throw new Error('HTTP 500')
      return orig<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.treePaths).toBeUndefined()
    expect(snap.files).toEqual([])
  })
  it('with token, computes median issue time-to-first-response and skips PRs', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/issues?')) {
        return [
          { number: 1, comments: 1, created_at: iso(10) },
          { number: 2, comments: 1, created_at: iso(20), pull_request: {} },
          { number: 3, comments: 1, created_at: iso(30) },
        ] as T
      }
      if (url.includes('/issues/1/comments')) return [{ created_at: iso(9) }] as T // 1 day
      if (url.includes('/issues/3/comments')) return [{ created_at: iso(25) }] as T // 5 days
      return orig<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW, { hasToken: true })
    expect(snap.medianIssueResponseDays).toBe(5) // deltas [1,5] → index floor(2/2)=1
  })
})
