import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectGithub, RepoNotFoundError, selectRepoFiles } from '../src/collectors/github.js'
import { HttpError } from '../src/util/http.js'
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
      description: 'A handy MCP server', topics: ['mcp', 'ai'],
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
  it('carries repo description + topics for library/SDK classification (V2)', async () => {
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, fakeHttp(), NOW)
    expect(snap.description).toBe('A handy MCP server')
    expect(snap.topics).toEqual(['mcp', 'ai'])
  })
  it('missing description/topics degrade to undefined/empty, not throw', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url === 'https://api.github.com/repos/acme/foo') {
        return { stargazers_count: 1234, archived: false, pushed_at: iso(2), default_branch: 'main' } as T
      }
      return orig<T>(url)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.description).toBeUndefined()
    expect(snap.topics).toEqual([])
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
  it('ranks single-file entrypoints like weather_server.py / mcp_server.ts by the tool-signal boost, not just exact path segments', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // Tight budget: package.json (manifest, 1 slot) + FILE_CAP-1=11 source slots.
    // Fillers are shorter than the two entrypoint-style files below, so under the
    // old exact-segment TOOL_SIGNAL_HINT (score 0 for both) a pure shortest-path
    // sort fills all 11 slots with fillers and drops both entrypoint files.
    const fillers = Array.from({ length: 11 }, (_, i) => ({ path: `src/u${i}.ts`, type: 'blob', size: 200 }))
    const entrypoints = [
      { path: 'weather_server.py', type: 'blob', size: 200 },
      { path: 'mcp_server.ts', type: 'blob', size: 200 },
    ]
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...fillers, ...entrypoints] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('weather_server.py')
    expect(paths).toContain('mcp_server.ts')
  })
  it('does not give an unrelated file like utils.py the tool-signal priority boost', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // Same tight-budget setup, but the two extra candidates are an unrelated
    // "src/utils.py" (no tool-signal boost) and a real entrypoint "mcp_server.ts"
    // (boosted). Only the entrypoint should be rescued from the squeeze.
    const fillers = Array.from({ length: 11 }, (_, i) => ({ path: `src/u${i}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            ...fillers,
            { path: 'src/utils.py', type: 'blob', size: 200 },
            { path: 'mcp_server.ts', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('mcp_server.ts')
    expect(paths).not.toContain('src/utils.py')
  })
  it('final review fix: lockfiles rank LAST — under a full FILE_CAP=12 budget of source files, package-lock.json is starved out', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const sourceFiles = Array.from({ length: 12 }, (_, i) => ({ path: `src/tool${i + 1}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package-lock.json', type: 'blob', size: 500 }, ...sourceFiles] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package-lock.json')) return '{}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toHaveLength(12)
    for (const f of sourceFiles) expect(paths).toContain(f.path)
    expect(paths).not.toContain('package-lock.json') // budget fully consumed by source before lockfiles are considered
  })

  // I8: envBlobs had no cap and was never evicted — 10 .env.example files
  // plus 8 src/tools/*.ts files at FILE_CAP=12 left zero budget for ranked
  // source, so the whole tool surface starved. ENV_FETCH_CAP=3 (shallowest
  // path first) mirrors SPEC_FETCH_CAP/ENTRYPOINT_FETCH_CAP.
  it('I8: an uncapped .env bucket no longer starves ranked source — at most ENV_FETCH_CAP env files fetched, shallowest first', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const envFiles = [
      { path: '.env.example', type: 'blob', size: 50 }, // depth 1 — shallowest, must survive
      ...Array.from({ length: 9 }, (_, i) => ({ path: `deploy/envs/env${i}/.env.example`, type: 'blob', size: 50 })),
    ]
    const toolFiles = Array.from({ length: 8 }, (_, i) => ({ path: `src/tools/tool${i}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...envFiles, ...toolFiles] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    const envPaths = paths.filter(p => p.includes('.env'))
    const toolPaths = paths.filter(p => p.startsWith('src/tools/'))
    expect(envPaths.length).toBeLessThanOrEqual(3)
    expect(envPaths).toContain('.env.example') // shallowest survives eviction
    expect(toolPaths).toHaveLength(8) // all 8 source files fetched — no longer starved
  })

  it('final review fix: a PRIMARY manifest (package.json) and source files both win over a lockfile when budget is tight', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const sourceFiles = Array.from({ length: 5 }, (_, i) => ({ path: `src/tool${i + 1}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'package-lock.json', type: 'blob', size: 500 },
            ...sourceFiles,
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package-lock.json')) return '{}'
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('package.json')
    for (const f of sourceFiles) expect(paths).toContain(f.path)
    expect(paths).toContain('package-lock.json') // 7 used of 12 cap, room remains for the lockfile
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
  it('caps commit pagination at COMMIT_PAGE_CAP even when Link: rel="next" is present on every page (huge-repo safety net)', async () => {
    const http = fakeHttp()
    let commitPageFetches = 0
    http.jsonWithHeaders = async <T,>(url: string): Promise<{ data: T; headers: Headers }> => {
      if (url.includes('/commits?since')) {
        commitPageFetches++
        // Every page's commit is recent (well within the 365d cutoff), so the
        // cutoff early-stop never fires — only the page cap can end this loop.
        const page = [{ sha: `s${commitPageFetches}`, commit: { author: { date: iso(1) } }, author: { login: 'a' } }]
        const next = `https://api.github.com/repos/acme/foo/commits?since=X&per_page=100&page=${commitPageFetches + 1}`
        return { data: page as T, headers: new Headers({ link: `<${next}>; rel="next"` }) }
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(commitPageFetches).toBeLessThanOrEqual(10) // COMMIT_PAGE_CAP
    expect(commitPageFetches).toBe(10)                // infinite next → loop stops only via the cap, not the cutoff
    expect(snap.busFactor).toBeDefined()              // proves the loop actually terminated and returned a snapshot
  })
  // --- V1: monorepo sampling overhaul (coverage-spec §3.3 + §4) ---

  it('V1: raised FILE_CAP + source floor rescue a source file that would be starved by 16 nested package.json manifests', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const nestedManifests = Array.from({ length: 15 }, (_, i) => ({ path: `pkg${i + 1}/package.json`, type: 'blob', size: 300 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 }, // root, 16 manifests total
            ...nestedManifests,
            { path: 'packages/mcp/src/index.ts', type: 'blob', size: 400 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    // Under the OLD fixed FILE_CAP=12, 16 manifests alone exceed the cap and the
    // single source file is never reached. The dynamic cap (>3 manifests → 24)
    // plus the source floor must rescue it.
    expect(paths).toContain('packages/mcp/src/index.ts')
  })

  it('V1 + regression fix: a tools/ directory file and the index.ts entrypoint are BOTH fetched, entrypoint prioritized (guaranteed bucket)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'src/index.ts', type: 'blob', size: 200 },
            { path: 'src/tools/registry.ts', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('src/tools/registry.ts')
    expect(paths).toContain('src/index.ts')
    // Regression fix (coverage-v1.3 fix wave): V1 originally made the
    // tools/-dir signal (+5) outrank the plain entrypoint signal (+2) so that
    // 'src/tools/registry.ts' sorted ahead of 'src/index.ts' in rankedSource.
    // That ordering is exactly what caused the 16/17-server regression this
    // fix wave addresses: under a TIGHT budget (many tools/-dir helper files,
    // few source slots), the entrypoint — often the ONLY file with the actual
    // `server.tool("x", ...)` / `ListToolsRequestSchema` registration, since
    // tools/-dir files frequently hold only handler LOGIC — got evicted
    // entirely. The entrypoint now has its own guaranteed bucket
    // (ENTRYPOINT_FETCH_CAP) placed ahead of ranked source, so it can never
    // be crowded out by tools/-dir files, regardless of their score.
    expect(paths.indexOf('src/index.ts')).toBeLessThan(paths.indexOf('src/tools/registry.ts'))
  })

  it('V1: a 150KB src/index.ts entrypoint is fetched under the raised SIZE_CAP (previously skipped at the old 100KB cap)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const BIG = 'x'.repeat(150_000)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, { path: 'src/index.ts', type: 'blob', size: 150_000 }] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('src/index.ts')) return BIG
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const file = snap.files.find(f => f.path === 'src/index.ts')
    expect(file).toBeDefined()
    expect(file?.content.length).toBe(150_000) // fully fetched, under the new 300KB cap
  })

  it('V1: an oversized entrypoint (400KB) is fetched-and-truncated to the 300KB SIZE_CAP rather than skipped', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const HUGE_ENTRYPOINT = 'y'.repeat(400_000)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, { path: 'src/index.ts', type: 'blob', size: 400_000 }] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('src/index.ts')) return HUGE_ENTRYPOINT
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const file = snap.files.find(f => f.path === 'src/index.ts')
    expect(file).toBeDefined() // not skipped
    expect(file?.content.length).toBe(300_000) // truncated to SIZE_CAP
  })

  it('V1: a .cursor/mcp.json is NOT treated as a manifest (root-only mcp.json/server.json + editor-dir exclusion)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: '.cursor/mcp.json', type: 'blob', size: 200 },
            { path: 'src/index.ts', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('.cursor/mcp.json')) return '{}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).not.toContain('.cursor/mcp.json')
  })

  it('V1: a .go file is now fetched (SOURCE_EXT extended with go/rs/java/cs/kt)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'go.mod', type: 'blob', size: 200 }, { path: 'internal/server/tools.go', type: 'blob', size: 500 }] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('go.mod')) return 'module x\n'
      return 'package server\n'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('internal/server/tools.go')
  })

  it('V1: manifest eviction protects the source floor when manifest count vastly exceeds even the raised FILE_CAP', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    const nestedManifests = Array.from({ length: 29 }, (_, i) => ({ path: `pkg${i + 1}/package.json`, type: 'blob', size: 300 }))
    const toolFiles = Array.from({ length: 20 }, (_, i) => ({ path: `src/tools/tool${i + 1}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...nestedManifests, ...toolFiles] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    // 30 manifest candidates would alone exceed FILE_CAP=24; eviction of
    // lowest-priority (deepest) manifests must protect the source floor.
    expect(paths.filter(p => p.endsWith('package.json')).length).toBeLessThan(30)
    expect(paths).toContain('package.json') // root manifest is never evicted
    expect(paths.filter(p => p.startsWith('src/tools/')).length).toBeGreaterThanOrEqual(16) // SOURCE_FLOOR = ceil(24*0.66)
  })

  // --- V5: OpenAPI/toolDefinitions spec-fetch allowance (coverage-spec §3.5) ---

  it('V5: an openapi.json spec file is fetched (spec-fetch allowance)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'openapi.json', type: 'blob', size: 2000 },
            { path: 'src/index.ts', type: 'blob', size: 2000 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('openapi.json')) return '{"openapi":"3.0.0","paths":{}}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('openapi.json')
  })

  it('V5: a toolDefinitions.json spec file is fetched', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'toolDefinitions.json', type: 'blob', size: 2000 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '[]'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('toolDefinitions.json')
  })

  it('V5: a case-variant OpenAPI.JSON basename is still recognized as a spec file', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'OpenAPI.JSON', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('OpenAPI.JSON')
  })

  it('V5: the spec-fetch bucket is capped at 2 files even with 3 spec candidates present', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'openapi.json', type: 'blob', size: 200 },
            { path: 'swagger.json', type: 'blob', size: 200 },
            { path: 'toolDefinitions.json', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const specPaths = snap.files.map(f => f.path).filter(p => /(?:^|\/)(?:openapi|swagger)\.json$/i.test(p) || /(?:^|\/)toolDefinitions\.json$/.test(p))
    expect(specPaths).toHaveLength(2)
  })

  // --- W2 (coverage-v1.4): prefixed openapi/swagger basenames + tools.json manifest ---

  it('W2: a prefixed openapi basename (notion-style scripts/notion-openapi.json) is fetched by the spec bucket', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'scripts/notion-openapi.json', type: 'blob', size: 2000 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('notion-openapi.json')) return '{"openapi":"3.0.0","paths":{}}'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('scripts/notion-openapi.json')
  })

  it('W2: non-server spec paths (docs/, examples/) never occupy a slot that would starve the real spec file under the cap', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            // Shorter/shallower than the real file below — without the
            // isNonServerPath exclusion these two would win both
            // SPEC_FETCH_CAP slots on path-length alone and evict the real
            // spec entirely.
            { path: 'docs/openapi.json', type: 'blob', size: 200 },
            { path: 'examples/openapi.json', type: 'blob', size: 200 },
            { path: 'scripts/notion-openapi.json', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('scripts/notion-openapi.json')
    expect(paths).not.toContain('docs/openapi.json')
    expect(paths).not.toContain('examples/openapi.json')
  })

  it('W2: spec candidates are prioritized shallowest-first under SPEC_FETCH_CAP=2', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            // Same basename at 3 depths, listed deep-first in the tree, so
            // only a shallowest-first SORT (not raw tree/slice order) can
            // make the root file survive the cap=2.
            { path: 'a/b/openapi.json', type: 'blob', size: 200 },
            { path: 'scripts/openapi.json', type: 'blob', size: 200 },
            { path: 'openapi.json', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('openapi.json')
    expect(paths).toContain('scripts/openapi.json')
    expect(paths).not.toContain('a/b/openapi.json')
  })

  it('W2: a tools.json manifest is fetched (olostep-style)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'tools.json', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '[]'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('tools.json')
  })

  it('stops pagination after page 1 once its oldest commit is already past the 365d cutoff, even with Link: rel="next" present', async () => {
    const http = fakeHttp()
    let commitPageFetches = 0
    const nextUrl = 'https://api.github.com/repos/acme/foo/commits?since=X&per_page=100&page=2'
    http.jsonWithHeaders = async <T,>(url: string): Promise<{ data: T; headers: Headers }> => {
      if (url.includes('/commits?since')) {
        commitPageFetches++
        // Oldest (last) commit on page 1 is 400 days old — already past the
        // 365d cutoff — even though a next Link is present, page 2 must never
        // be fetched.
        const page1 = [
          { sha: 'p1a', commit: { author: { date: iso(5) } }, author: { login: 'a' } },
          { sha: 'p1b', commit: { author: { date: iso(400) } }, author: { login: 'a' } },
        ]
        return { data: page1 as T, headers: new Headers({ link: `<${nextUrl}>; rel="next"` }) }
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(commitPageFetches).toBe(1)
    expect(snap.commitsLast90Days).toBe(1) // only the 5d-old commit is within the 90d window; 400d is not
  })

  // --- Regression fix (coverage-v1.3 fix wave) regression guards ---------
  // These reproduce the exact shapes that caused 16/17 previously-graded
  // servers to regress to "insufficient data" after the V1 sampling
  // overhaul. See src/collectors/github.ts (ENTRYPOINT_FETCH_CAP,
  // BARE_TOOL_FILE_RE, WELL_KNOWN_MANIFEST_PATH_RE,
  // UNSUPPORTED_EXTRACTOR_EXT_RE) and .superpowers/sdd/regression-fix-report.md.

  it('regression fix #1: the entrypoint survives even when a tools/ directory has MORE files than fit in the source budget (8enSmith/mcp-open-library, modelcontextprotocol/servers shape)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // 15 tools/-dir helper files (score 5 each, no registration — like real
    // one-tool-per-file layouts where only the entrypoint calls
    // `server.tool(name, ...)`) vastly outnumber the 11 source slots that
    // were available under the OLD fixed FILE_CAP=12 - 1 manifest.
    //
    // W5 (wave2-spec §2.1 change 4) updated this repo's OWN cap out from
    // under the original version of this test: 15 tools/-dir files trips
    // `toolFanout >= 8`, so FILE_CAP now widens to 24 for this exact shape —
    // this is the explicitly-specified "tools-fanout repo gets cap 24"
    // behavior, not a regression. Under the wider cap none of the 17
    // candidates (1 manifest + entrypoint + 15 tool files) need eviction at
    // all, which is a STRICTLY STRONGER guarantee than the original "stays
    // under 12" assertion: every candidate is now provably present, not just
    // the entrypoint surviving a squeeze that no longer occurs for this shape.
    const toolFiles = Array.from({ length: 15 }, (_, i) => ({ path: `src/tools/handler${i}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'src/index.ts', type: 'blob', size: 200 },
            ...toolFiles,
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('src/index.ts')
    expect(paths.length).toBeLessThanOrEqual(24) // FILE_CAP's new ceiling under the fan-out trigger
    expect(paths).toHaveLength(17) // manifest + entrypoint + all 15 tool files — no eviction needed under the widened cap
    for (const f of toolFiles) expect(paths).toContain(f.path)
  })

  it('regression fix #2: a bare tool.py FILE (not a tools/ directory) is prioritized over many irrelevant same-score files (mroops0111/openapi-mcp-gateway shape)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // 11 irrelevant, SHORTER-path .py files (no tool signal at all) would
    // win the shortest-path tie-break over 'src/exposure/tool.py' pre-fix,
    // since bare "tool.py" only matched the OLD TOOL_SIGNAL_HINT (dropped by
    // V1's directory-only TOOLS_DIR_RE).
    const noise = Array.from({ length: 11 }, (_, i) => ({ path: `src/m${i}.py`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'pyproject.toml', type: 'blob', size: 500 },
            { path: 'src/exposure/tool.py', type: 'blob', size: 200 },
            ...noise,
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('pyproject.toml')) return '[project]\nname = "foo"\n'
      return 'x = 1'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('src/exposure/tool.py')
  })

  it('regression fix #3: a mcp.json under a .well-known/ directory is fetched despite ROOT_ONLY_MANIFEST (codex-curator/studiomcphub shape)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'package.json', type: 'blob', size: 500 },
            { path: 'site/.well-known/mcp.json', type: 'blob', size: 500 },
            // A DIFFERENT nested mcp.json outside .well-known/ must still be
            // excluded — this test must not just blanket-revert
            // ROOT_ONLY_MANIFEST.
            { path: '.cursor/mcp.json', type: 'blob', size: 500 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return '{"tools":[{"name":"x"}]}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('site/.well-known/mcp.json')
    expect(paths).not.toContain('.cursor/mcp.json')
  })

  it('regression fix #4: an extractor-unsupported extension (.rs) does not outrank a .py file (extractor exists) on shortest-path tie-break (protostatis/unbrowser shape)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // 'src/a.rs' is shorter than 'scripts/observers_smoke.py' — pre-fix
    // (SOURCE_EXT gained rs/java/cs/kt in V1 with no ranking penalty), the
    // unsupported-extractor .rs file would win the tie-break and, under a
    // tight budget, could displace the .py file entirely.
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'Cargo.toml', type: 'blob', size: 500 },
            { path: 'src/a.rs', type: 'blob', size: 200 },
            { path: 'scripts/observers_smoke.py', type: 'blob', size: 200 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('Cargo.toml')) return '[package]\nname = "foo"\n'
      return 'import subprocess'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain('scripts/observers_smoke.py')
    // The .py extractor-supported file must rank ahead of the unsupported .rs one.
    expect(paths.indexOf('scripts/observers_smoke.py')).toBeLessThan(paths.indexOf('src/a.rs'))
  })

  // --- W1: stop publishing an F for a repo we never fetched -------------
  // 18/400 index entries are repos GitHub 404s (deleted/renamed) yet get
  // published with ok:true/overall:0/grade:"F". Root cause: the repo-metadata
  // fetch (`const meta = await http.json<GhRepo>(api)`) is the single
  // unguarded throw point in collectGithub — every other fetch inside this
  // function already has its own try/catch or `.catch()`. A 404 there means
  // "this repo does not exist" and must be distinguishable from a generic
  // collector hiccup (network blip, 403, 5xx) so assemble.ts can mark the
  // result `unresolved` instead of scoring a degenerate all-zero card.
  it('W1: a 404 on repo metadata throws RepoNotFoundError, not a generic Error', async () => {
    const http: Http = {
      async json<T>(url: string): Promise<T> {
        if (url === 'https://api.github.com/repos/acme/gone') throw new HttpError(404, url)
        throw new Error(`unexpected call: ${url}`)
      },
      async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
        throw new Error(`unexpected call: ${url}`)
      },
      async text(url: string): Promise<string> { throw new Error(`unexpected call: ${url}`) },
      async postJson<T>(): Promise<T> { throw new Error('unused') },
    }
    await expect(
      collectGithub({ ref: 'acme/gone', repo: { owner: 'acme', name: 'gone' } }, http, NOW),
    ).rejects.toBeInstanceOf(RepoNotFoundError)
  })
  it('W1: a non-404 failure on repo metadata is NOT reclassified as RepoNotFoundError (403/5xx/network stay generic)', async () => {
    const http: Http = {
      async json<T>(url: string): Promise<T> {
        if (url === 'https://api.github.com/repos/acme/broken') throw new HttpError(403, url)
        throw new Error(`unexpected call: ${url}`)
      },
      async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
        throw new Error(`unexpected call: ${url}`)
      },
      async text(url: string): Promise<string> { throw new Error(`unexpected call: ${url}`) },
      async postJson<T>(): Promise<T> { throw new Error('unused') },
    }
    const p = collectGithub({ ref: 'acme/broken', repo: { owner: 'acme', name: 'broken' } }, http, NOW)
    await expect(p).rejects.not.toBeInstanceOf(RepoNotFoundError)
    await expect(p).rejects.toBeInstanceOf(HttpError)
  })
  // Rename redirects: `request()` in src/util/http.ts never sets
  // `redirect: 'manual'`, so the real fetch already follows a GitHub 301
  // (rename) transparently — collectGithub's repo-metadata call simply sees
  // a normal 200 for the new location, indistinguishable from a repo that
  // was never renamed. This test documents/guards that: a fixture shaped
  // like "the redirect already happened" scores normally, with no special
  // rename-handling code needed inside collectGithub itself.
  it('W1: a followed rename redirect (fetch already resolved 301→200) scores the repo normally, no special-casing needed', async () => {
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, fakeHttp(), NOW)
    expect(snap.stars).toBe(1234) // ordinary success path — same as any other resolved repo
  })

  // --- W5 (coverage-v1.5, wave2-spec §2): SOURCE_HINT becomes a ranking
  // score, not a gate; fan-out budget; non-server quota. ---------------

  it('W5: a repo whose only source is trends_mcp.py (fails the old SOURCE_HINT gate) is now selected (salwks/mcp-techTrend shape)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return {
          tree: [
            { path: 'requirements.txt', type: 'blob', size: 50 },
            // No 'src/', no 'server'/'tool'/'index'/'main' substring — the
            // pre-W5 SOURCE_HINT gate excluded this file outright, leaving
            // nothing at all to extract from (the repo's ONLY source file).
            { path: 'trends_mcp.py', type: 'blob', size: 400 },
          ],
        } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('requirements.txt')) return 'requests\n'
      return '@mcp.tool()\ndef get_trend(q: str) -> str:\n    ...\n'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('trends_mcp.py')
  })

  it('W5: a tools/-fanout repo (>=8 tool-fanout files) gets FILE_CAP=24, not the fixed 12 (measured: 21/77 live repos trip this)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // 8 tools/-dir files trips toolFanout >= 8. 20 additional unrelated
    // filler source files prove the cap actually widened: under the OLD
    // fixed FILE_CAP=12, at most 11 non-manifest files could ever be
    // selected; under the new 24, up to 23 can.
    const toolFiles = Array.from({ length: 8 }, (_, i) => ({ path: `src/tools/handler${i}.ts`, type: 'blob', size: 200 }))
    const fillers = Array.from({ length: 20 }, (_, i) => ({ path: `src/lib/util${i}.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...toolFiles, ...fillers] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths.length).toBeGreaterThan(12) // proves the cap widened past the old fixed 12
    expect(paths).toHaveLength(24) // FILE_CAP's new ceiling for this fan-out shape
    for (const f of toolFiles) expect(paths).toContain(f.path) // the fan-out files themselves always win their own trigger
  })

  it('W5: a vite.config.ts build-noise file ranks below real tool source and is evicted under a tight budget, even when its path is shorter (CONFIG_NOISE_RE)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // Real tool file scores +8 (TOOLS_DIR +5, SOURCE_HINT +3) and always
    // wins its slot. The remaining 10 slots are contested between 10 filler
    // files (score 0, LONG paths) and vite.config.ts (score -6 under
    // CONFIG_NOISE_RE, SHORT path). Without the -6 penalty, vite.config.ts's
    // shorter path would win the path-length tie-break over every filler —
    // it would survive and evict a filler instead. With the penalty, it's
    // vite.config.ts that gets evicted.
    const realTool = { path: 'src/tools/create_widget.ts', type: 'blob', size: 200 }
    const fillers = Array.from({ length: 10 }, (_, i) => ({ path: `filler/somewhat-longer-name-${i}.ts`, type: 'blob', size: 200 }))
    const configNoise = { path: 'vite.config.ts', type: 'blob', size: 200 }
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, realTool, ...fillers, configNoise] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    expect(paths).toContain(realTool.path)
    for (const f of fillers) expect(paths).toContain(f.path)
    expect(paths).not.toContain('vite.config.ts')
    expect(paths).toHaveLength(12) // FILE_CAP=12: manifest + realTool + 10 fillers, vite.config.ts is the one evicted
  })

  it('W5: non-server-path files (tests/examples) are quota-capped at NON_SERVER_FETCH_CAP=3, even when the budget has room for more', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    // 8 tools/-dir files trip toolFanout>=8 -> FILE_CAP=24, so there is
    // plenty of spare room (1 manifest + 8 tool files = 9, leaving 15 free
    // of 24) for all 10 test files to fit with room to spare if nothing
    // capped them — proving the quota is unconditional, not just eviction
    // under scarcity.
    const toolFiles = Array.from({ length: 8 }, (_, i) => ({ path: `src/tools/handler${i}.ts`, type: 'blob', size: 200 }))
    const testFiles = Array.from({ length: 10 }, (_, i) => ({ path: `tests/case${i}.test.ts`, type: 'blob', size: 200 }))
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [{ path: 'package.json', type: 'blob', size: 500 }, ...toolFiles, ...testFiles] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      return 'export {}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    const paths = snap.files.map(f => f.path)
    const selectedTestFiles = paths.filter(p => p.startsWith('tests/'))
    expect(selectedTestFiles.length).toBeLessThanOrEqual(3)
    expect(selectedTestFiles).toHaveLength(3) // room for all 10 existed; the quota is what stopped it
    for (const f of toolFiles) expect(paths).toContain(f.path) // real source is never displaced by the quota'd files
  })

  it('fix: NON_SERVER_FETCH_CAP is scoped to rankedSource — example entrypoints must not drain it and starve the guaranteed entrypoint bucket', () => {
    // Bug this guards: NON_SERVER_FETCH_CAP was a mutable counter in the
    // SHARED final dedup/FILE_CAP loop, not scoped to rankedSource.
    // ENTRYPOINT_RE matches `examples/index.ts` (etc.), which ALSO matches
    // NON_SERVER_DIR_RE — so entrypoint-bucket members were counted against
    // the SAME 3-slot quota rankedSource's own non-server files use,
    // exhausting it before rankedSource was even reached and silently
    // dropping legitimate entrypoint-bucket members that ENTRYPOINT_FETCH_CAP
    // (=6) had room for.
    const blobs = [
      { path: 'package.json', size: 500 },
      // 5 example entrypoints — all match BOTH ENTRYPOINT_RE and
      // NON_SERVER_DIR_RE, well within ENTRYPOINT_FETCH_CAP=6. Pre-fix, only
      // the first 3 (by manifestPriority: shallowest/shortest first) survive
      // the shared quota; `examples/foo/index.ts` and `examples/bar/index.ts`
      // are silently dropped.
      { path: 'examples/index.ts', size: 100 },
      { path: 'examples/server.ts', size: 100 },
      { path: 'examples/main.ts', size: 100 },
      { path: 'examples/foo/index.ts', size: 100 },
      { path: 'examples/bar/index.ts', size: 100 },
      // Non-entrypoint-shaped example files — these fall through to
      // rankedSource (not the entrypoint bucket) and are the files
      // NON_SERVER_FETCH_CAP was actually designed to quota.
      { path: 'examples/util-one.ts', size: 100 },
      { path: 'examples/util-two.ts', size: 100 },
      { path: 'examples/util-three.ts', size: 100 },
      { path: 'examples/util-four.ts', size: 100 },
      // 8 real tool files: (a) real tool-bearing source that must never be
      // starved by this bug, and (b) trips toolFanout>=8 so FILE_CAP widens
      // to 24, giving ample budget headroom — isolating the assertions below
      // from any FILE_CAP eviction, so only the quota-scoping bug can explain
      // a dropped path.
      ...Array.from({ length: 8 }, (_, i) => ({ path: `src/tools/tool${i}.ts`, size: 100 })),
    ]
    const selected = selectRepoFiles(blobs, 'foo', false)

    // 1. Real source is (and was always) unaffected by this bug — still
    // selected. (It is never itself a non-server path, so it was never at
    // risk; asserted for completeness / non-regression.)
    for (let i = 0; i < 8; i++) expect(selected).toContain(`src/tools/tool${i}.ts`)

    // 2. rankedSource's OWN non-server quota still holds: at most
    // NON_SERVER_FETCH_CAP (=3) of the 4 non-entrypoint example files make it
    // through — the quota still applies where it was designed to, just
    // scoped to this bucket instead of shared globally.
    const rankedSourceNonServer = selected.filter(p => p.startsWith('examples/util'))
    expect(rankedSourceNonServer.length).toBeLessThanOrEqual(3)

    // 3. THE CORE ASSERTION: the entrypoint bucket is NOT subject to the
    // quota at all — all 5 example entrypoints (well within
    // ENTRYPOINT_FETCH_CAP=6) are selected as entrypoints, not just the
    // first 3. Pre-fix this fails: `examples/foo/index.ts` and
    // `examples/bar/index.ts` are silently dropped because the shared quota
    // was already exhausted by `examples/index.ts`, `examples/server.ts`,
    // `examples/main.ts`.
    for (const p of ['examples/index.ts', 'examples/server.ts', 'examples/main.ts', 'examples/foo/index.ts', 'examples/bar/index.ts']) {
      expect(selected).toContain(p)
    }
  })

  // --- W6 (Task W6 Part A): 1-slot README bucket ---------------------------

  it('W6: a root README.md is fetched (1-slot README bucket)', async () => {
    const http = fakeHttp()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) {
        return { tree: [
          { path: 'package.json', type: 'blob', size: 500 },
          { path: 'README.md', type: 'blob', size: 2000 },
        ] } as T
      }
      return origJson<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.includes('package.json')) return '{"name":"foo"}'
      if (url.includes('README.md')) return '# foo'
      return '{}'
    }
    const snap = await collectGithub({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(snap.files.map(f => f.path)).toContain('README.md')
  })

  it('W6: a README.rst is also recognized', () => {
    const blobs = [{ path: 'package.json', size: 500 }, { path: 'README.rst', size: 500 }]
    const selected = selectRepoFiles(blobs, 'foo', false)
    expect(selected).toContain('README.rst')
  })

  it('W6: a NESTED README (docs/README.md, packages/x/README.md) is never treated as the root catalog source (depth-0 only)', () => {
    const blobs = [
      { path: 'package.json', size: 500 },
      { path: 'docs/README.md', size: 500 },
      { path: 'packages/x/README.md', size: 500 },
    ]
    const selected = selectRepoFiles(blobs, 'foo', false)
    expect(selected).not.toContain('docs/README.md')
    expect(selected).not.toContain('packages/x/README.md')
  })

  it('W6: the README bucket is capped at 1 slot even with both README.md and README.rst present (prefers .md)', () => {
    const blobs = [{ path: 'package.json', size: 500 }, { path: 'README.md', size: 500 }, { path: 'README.rst', size: 500 }]
    const selected = selectRepoFiles(blobs, 'foo', false)
    const readmes = selected.filter(p => p === 'README.md' || p === 'README.rst')
    expect(readmes).toHaveLength(1)
    expect(readmes).toEqual(['README.md'])
  })

  it('W6: the README bucket is ranked AFTER spec files and BEFORE ranked source, and is accounted in the SAME availableSourceSlots budget as every other guaranteed bucket (never a shared-loop counter)', () => {
    // A saturated FILE_CAP=12 budget: 1 manifest + 1 spec + README + as many
    // ranked-source files as fit. If README were NOT budgeted through
    // availableSourceSlots (e.g. bolted on as an extra, uncounted fetch), the
    // total selected count would exceed FILE_CAP; if it displaced the spec
    // bucket instead of ranked source, the spec file would be missing.
    // NOTE: deliberately generic (non-`tools/`) source paths — a `tools/`-dir
    // shape would itself trip the toolFanout>=8 trigger and widen FILE_CAP to
    // 24, defeating the point of this saturation test.
    const blobs = [
      { path: 'package.json', size: 500 },
      { path: 'openapi.json', size: 500 },
      { path: 'README.md', size: 500 },
      ...Array.from({ length: 20 }, (_, i) => ({ path: `src/file${i}.ts`, size: 100 })),
    ]
    const selected = selectRepoFiles(blobs, 'foo', false)
    expect(selected.length).toBe(12) // FILE_CAP=12, fully saturated
    expect(selected).toContain('README.md')
    expect(selected).toContain('openapi.json')
  })

  // --- W5 THE REGRESSION GUARD (plan Task W5, wave2-spec §2.2) ----------
  //
  // tests/fixtures/sampling-corpus.json was recorded live (`gh api
  // .../git/trees/<branch>?recursive=1`, path+size+type only, no file
  // contents) for the 9 repos named in the plan, together with
  // `expectedRetained` — the file list selectRepoFiles chose for each repo
  // BEFORE this task's W5 edits (computed from the exact pre-edit source,
  // reconstructed from the same commit this branch forked from). This guard
  // re-runs the CURRENT (post-W5) selectRepoFiles against those same
  // recorded trees and asserts no tool-bearing path is dropped.
  //
  // Three pre-W5-selected paths are EXCLUDED from the strict "must survive"
  // set below, each individually verified live (not merely asserted) to
  // carry no tool surface our extractors would ever read from it:
  //   - mroops0111/openapi-mcp-gateway: src/openapi_mcp_gateway/__init__.py
  //     — 647 bytes, pure `from .x import y` re-exports + `__all__`; no
  //     `add_tool(...)`/`.tool(...)`/`@mcp.tool()` call appears in it.
  //   - codex-curator/studiomcphub: src/tools/__init__.py — NOT empty (the
  //     wave2-spec's "empty file" note is stale; live content is a 604-line
  //     dispatch table). Still not tool-bearing: its `handlers = {...}` /
  //     `_TOOL_CATEGORIES` are plain dict literals with no recognized
  //     registration call, AND this repo's real tool list is published via
  //     `site/.well-known/mcp.json` (still selected, unchanged pre/post),
  //     which wins extractSchema's ladder ahead of any Python source bucket
  //     — this file was never contributing a tool to the graded output
  //     either before or after.
  //   - protostatis/unbrowser: src/policy.rs — Rust. extractSchema has no
  //     Rust bucket (manifestJson/js/py/go only) — categorically
  //     unextractable regardless of content, per UNSUPPORTED_EXTRACTOR_EXT_RE.
  //
  // W6 (Task W6 Part A): three more paths join this list — not because a
  // tool-bearing file became unextractable, but because the new 1-slot
  // README bucket (ranked ahead of rankedSource, budgeted through the SAME
  // availableSourceSlots() accounting as every other guaranteed bucket — see
  // src/collectors/github.ts) now costs exactly one rankedSource slot on a
  // repo whose budget was already saturated, displacing the single
  // lowest-ranked rankedSource candidate. Each was fetched live and verified
  // to carry no tool-registration idiom at all (confirmed by direct content
  // inspection, not inference from the filename):
  //   - codex-curator/studiomcphub: src/tools/watermark.py — a DCT-domain
  //     image-watermarking helper (embed/detect), no `.tool(`/`add_tool(`
  //     call anywhere; this repo's real tool list is published via
  //     `site/.well-known/mcp.json` regardless (same rationale as the
  //     sibling `src/tools/__init__.py` entry above).
  //   - protostatis/unbrowser: train/eval_tool_likelihoods.py — a dev-only
  //     A/B eval harness script for a separately-built Rust binary; no MCP
  //     tool registration of any kind.
  //   - upstash/context7: packages/mcp/src/lib/encryption.ts — a client-IP
  //     encryption/header utility; no tool registration. (context7's actual
  //     tool surface already lives under docs/openapi.json, correctly
  //     excluded by isNonServerPath per the original W5 rank_sim finding.)
  const KNOWN_NOT_TOOL_BEARING = new Set([
    'mroops0111/openapi-mcp-gateway::src/openapi_mcp_gateway/__init__.py',
    'codex-curator/studiomcphub::src/tools/__init__.py',
    'protostatis/unbrowser::src/policy.rs',
    'codex-curator/studiomcphub::src/tools/watermark.py',
    'protostatis/unbrowser::train/eval_tool_likelihoods.py',
    'upstash/context7::packages/mcp/src/lib/encryption.ts',
  ])

  interface SamplingCorpusEntry {
    ref: string
    rootPkgName: string | null
    hasWorkspaces: boolean
    tree: Array<{ path: string; size: number; type: string }>
    expectedRetained: string[]
  }
  const corpusPath = fileURLToPath(new URL('./fixtures/sampling-corpus.json', import.meta.url))
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as SamplingCorpusEntry[]

  describe('W5 regression guard: recorded-tree corpus (network-free)', () => {
    it('the corpus fixture covers all 9 named repos', () => {
      expect(corpus.map(r => r.ref).sort()).toEqual([
        '8enSmith/mcp-open-library',
        'AliKarami/MikroMCP',
        'FradSer/mcp-server-apple-reminders',
        'PantelisGeorgiadis/dicomweb-mcp-server',
        'codex-curator/studiomcphub',
        'cyclops-ui/mcp-cyclops',
        'mroops0111/openapi-mcp-gateway',
        'protostatis/unbrowser',
        'upstash/context7',
      ])
    })

    for (const repo of corpus) {
      it(`${repo.ref}: no tool-bearing pre-W5-selected path is dropped by the current selectRepoFiles`, () => {
        const blobs = repo.tree.map(t => ({ path: t.path, size: t.size }))
        const post = selectRepoFiles(blobs, repo.rootPkgName ?? undefined, repo.hasWorkspaces)
        const dropped = repo.expectedRetained.filter(p => !post.includes(p))
        const unjustifiedDrops = dropped.filter(p => !KNOWN_NOT_TOOL_BEARING.has(`${repo.ref}::${p}`))
        expect(unjustifiedDrops).toEqual([])
      })
    }

    it('cyclops-ui/mcp-cyclops: the SOURCE_HINT gate removal recovers internal/modules/*.go (6 Go-idiom tools our extractor already supports)', () => {
      const repo = corpus.find(r => r.ref === 'cyclops-ui/mcp-cyclops')!
      const blobs = repo.tree.map(t => ({ path: t.path, size: t.size }))
      const post = selectRepoFiles(blobs, repo.rootPkgName ?? undefined, repo.hasWorkspaces)
      expect(post).toContain('internal/modules/create.go')
      expect(post.filter(p => p.startsWith('internal/modules/')).length).toBeGreaterThanOrEqual(6)
    })
  })
})
