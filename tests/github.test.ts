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
    // Real implementation (not a stub): collectGithub paginates commits through
    // this method, so every existing single-page fixture must keep working —
    // same routes table, just no `Link` header → parseNextLink sees no next page.
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { data: body as T, headers: new Headers() }
      }
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
    // Commits now paginate through jsonWithHeaders, not json — fail that path.
    const origWithHeaders = http.jsonWithHeaders.bind(http)
    http.jsonWithHeaders = async <T,>(url: string): Promise<{ data: T; headers: Headers }> => {
      if (url.includes('/commits?since')) throw new Error('HTTP 500')
      return origWithHeaders<T>(url)
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
    expect(snap.medianIssueResponseDays).toBe(3) // deltas [1,5], even n → true median avg (1+5)/2=3
  })
  it('fetches manifest files by basename even when nested in a workspace subpath', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'packages/x/package.json', type: 'blob', size: 400 },
            { path: 'src/index.ts', type: 'blob', size: 2000 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('packages/x/package.json')
  })
  it('fetches go.mod (root + nested) and .csproj manifests — proving the multi-ecosystem branches are reachable', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const origText = http.text.bind(http)
    const GO_MOD = 'module x\n\nrequire github.com/modelcontextprotocol/go-sdk v1.7.0\n'
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'go.mod', type: 'blob', size: 200 },
            { path: 'subdir/go.mod', type: 'blob', size: 200 },
            { path: 'src/Server.csproj', type: 'blob', size: 300 },
            { path: 'src/index.ts', type: 'blob', size: 2000 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('go.mod')) return GO_MOD
      if (url.includes('.csproj')) return '<PackageReference Include="ModelContextProtocol" Version="0.1.0" />'
      return origText(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('go.mod')
    expect(paths).toContain('subdir/go.mod')
    expect(paths).toContain('src/Server.csproj')
  })
  it('ranks tool-signal-bearing source paths (tools?/server/index/main) above merely-short unrelated files under a tight file budget', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const fillers = Array.from({ length: 11 }, (_, i) => ({ path: `src/util${i}.ts`, type: 'blob', size: 200 }))
    const toolFiles = ['create_widget', 'delete_widget', 'list_widgets']
      .map(n => ({ path: `src/tools/${n}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...fillers, ...toolFiles] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths.filter(p => p.startsWith('src/tools/'))).toHaveLength(3) // all 3 tool-signal files survive the FILE_CAP=12 budget
  })
  it('paginates commits via Link: rel="next" and accumulates bus factor + 90d activity across the full window', async () => {
    const http = fakeHttp()
    // page1: author 'a' has 2 recent commits (within 90d). page2 (reached only via
    // the Link header): author 'a' gets a 3rd commit, older than 90d but inside 365d.
    // busFactor must count 'a' (2+1=3 >= threshold) only by accumulating BOTH pages;
    // commitsLast90Days must stay 2 (page2's commit falls outside the 90d window).
    const page1 = [
      { sha: 'p1a', commit: { author: { date: iso(1) } }, author: { login: 'a' } },
      { sha: 'p1b', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
    ]
    const page2 = [
      { sha: 'p2a', commit: { author: { date: iso(200) } }, author: { login: 'a' } },
    ]
    const nextUrl = 'https://api.github.com/repos/acme/foo/commits?since=X&per_page=100&page=2'
    http.jsonWithHeaders = async <T,>(url: string): Promise<{ data: T; headers: Headers }> => {
      if (url.includes('/commits?since')) {
        if (url.startsWith(nextUrl)) return { data: page2 as T, headers: new Headers() }
        return { data: page1 as T, headers: new Headers({ link: `<${nextUrl}>; rel="next"` }) }
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.busFactor).toBe(1)          // 'a': 2 (page1) + 1 (page2) = 3 commits → crosses the >=3 threshold
    expect(snap.commitsLast90Days).toBe(2)  // only page1's two commits are within 90 days
  })
})
