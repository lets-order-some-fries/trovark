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

  it('V1: toolSignalScore ranks a tools/ directory file above a same-tier index.ts entrypoint (replaces shortest-path tie-break)', async () => {
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
    // Old shortest-path tie-break would order 'src/index.ts' (shorter) first;
    // the tools/-dir signal must now outrank the plain entrypoint signal.
    expect(paths.indexOf('src/tools/registry.ts')).toBeLessThan(paths.indexOf('src/index.ts'))
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
})
