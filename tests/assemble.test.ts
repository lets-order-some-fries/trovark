import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { collectNpm } from '../src/collectors/npm.js'
import { collectGithub } from '../src/collectors/github.js'
import { score } from '../src/scoring/score.js'
import { HttpError, RateLimitError } from '../src/util/http.js'
import type { Http } from '../src/util/http.js'

const NOW = new Date('2026-07-31T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

// Cleanup: shared builder for the route-matching mock Http used across this
// file's fixtures — fullFake() and figwrightShapedHttp() previously
// duplicated this json/jsonWithHeaders/postJson boilerplate verbatim, with
// only `routes` and the `text` lookup differing between them.
function makeRoutedHttp(routes: Record<string, unknown>, textFn: (url: string) => string): Http {
  return {
    async json<T>(url: string): Promise<T> {
      for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    // Real (not a stub): collectGithub paginates commits through this method,
    // and a single-page fixture with no Link header → one page, as before.
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
      return textFn(url)
    },
  }
}

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
  return makeRoutedHttp(routes, (url) => {
    if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.2.0' } })
    if (url.endsWith('src/index.ts')) return `server.tool('greet', 'Say hello', {}, h)`
    // C5: every path this fixture's TREE lists must be servable — an
    // unserved selected path now (correctly) counts as a fetch failure and
    // forces surfacePartial, which is exactly the honesty behavior under
    // test elsewhere, not what this healthy-repo fixture represents.
    if (url.endsWith('.github/workflows/ci.yml')) return 'on: [push]'
    if (url.endsWith('package-lock.json')) return '{"lockfileVersion": 3}'
    if (url.endsWith('tests/x.test.ts')) return 'it("x", () => {})'
    throw new Error(`HTTP 404 for ${url}`)
  })
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
    // W6 review remediation item M2: a code-extracted tool surface carries
    // readmeSourced === false (not merely absent) — extraction genuinely ran
    // via a non-README rung.
    expect(s.readmeSourced).toBe(false)
    expect(s.toolCount).toBe(1)
    expect(s.toolSurfaceRisk).toBe('none')
    expect(s.secretsFound).toBe(0)
    expect(s.weeklyDownloads).toBe(2000)
    expect(s.cveWorst).toBe('none')
    expect(s.errors).toEqual([])
    // D1 (integrity-v1): wired alongside scanSecrets — a real scan (files
    // WERE fetched) always sets integrityHits (even to []) and scanned{}.
    expect(s.integrityHits).toEqual([])
    expect(s.integrityScanned).toEqual({ files: 4, chars: expect.any(Number), tools: 1 })
    // D2 (integrity-phase2): a clean scan (no 'hidden-payload' kind hits)
    // sets hiddenPayloadDecoded to 0, not undefined — score.ts's override
    // relies on this to distinguish "checked, clean" from "never checked".
    expect(s.hiddenPayloadDecoded).toBe(0)
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
  // DF-1: the two tests above only prove assemble PREFERS a lockfile it was
  // handed. The bug was upstream — collectGithub never handed one over for any
  // repo with >= FILE_CAP source files, so OSV saw the manifest floor and the
  // card accused packages of CVEs already patched at the resolved version
  // (loreweave: @modelcontextprotocol/sdk pinned to 1.30.0, three GHSAs
  // reported against the ^1.12.0 floor). This fixture saturates the budget.
  function saturatedRepoHttp(opts: { lockfile: boolean; lockPackages?: Record<string, unknown>; extraTree?: Array<{ path: string; type: string; size: number }> }): { http: Http; queried: () => Array<{ name: string; version: string }> } {
    const sourceFiles = Array.from({ length: 20 }, (_, i) => ({ path: `src/file${i}.ts`, type: 'blob', size: 100 }))
    const tree = [
      { path: 'package.json', type: 'blob', size: 300 },
      { path: 'src/index.ts', type: 'blob', size: 500 },
      ...sourceFiles,
      ...(opts.lockfile ? [{ path: 'package-lock.json', type: 'blob', size: 144_062 }] : []),
      ...(opts.extraTree ?? []),
    ]
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/foo/commits?since': [
        { sha: '1', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
      ],
      'https://api.github.com/repos/acme/foo/releases/latest': { published_at: iso(10) },
      'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': { tree },
      'https://api.github.com/repos/acme/foo': {
        stargazers_count: 300, archived: false, pushed_at: iso(2), default_branch: 'main',
      },
      'https://registry.npmjs.org/foo-mcp': {
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } } },
      },
      'https://api.npmjs.org/downloads/point/last-week/foo-mcp': { downloads: 2000 },
    }
    let queried: Array<{ name: string; version: string }> = []
    const http = makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ name: 'foo-mcp', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      if (url.endsWith('package-lock.json')) {
        return JSON.stringify({
          lockfileVersion: 3,
          packages: opts.lockPackages ?? {
            '': { name: 'foo-mcp', version: '1.0.0' },
            'node_modules/@modelcontextprotocol/sdk': { version: '1.4.2' },
          },
        })
      }
      if (url.endsWith('src/index.ts')) return `server.tool('greet', 'Say hello', {}, h)`
      if (/src\/file\d+\.ts$/.test(url)) return 'export {}'
      throw new Error(`HTTP 404 for ${url}`)
    })
    http.postJson = async <T,>(url: string, body: unknown): Promise<T> => {
      if (url.includes('osv.dev')) {
        queried = (body as { queries: Array<{ package: { name: string }; version: string }> }).queries
          .map(q => ({ name: q.package.name, version: q.version }))
        return { results: queried.map(() => ({})) } as T
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    return { http, queried: () => queried }
  }

  it('DF-1: with a committed package-lock.json in a budget-saturated tree, OSV is queried at the RESOLVED version (1.4.2), not the ^1.0.0 floor', async () => {
    const { http, queried } = saturatedRepoHttp({ lockfile: true })
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(queried()).toEqual([{ name: '@modelcontextprotocol/sdk', version: '1.4.2' }])
    expect(s.depsResolvedFromLockfile).toBe(true)
    expect(s.cveWorst).toBe('none')
    // the source sample is unchanged by the extra lockfile fetch
    expect(s.toolCount).toBe(1)
  })

  it('DF-1: with NO lockfile, OSV is queried at the declared floor and the signals say so (depsResolvedFromLockfile=false) so the card can carry the caveat', async () => {
    const { http, queried } = saturatedRepoHttp({ lockfile: false })
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(queried()).toEqual([{ name: '@modelcontextprotocol/sdk', version: '1.0.0' }])
    expect(s.depsResolvedFromLockfile).toBe(false)
    const card = score('foo-mcp', s, NOW.toISOString())
    expect(card.notes.some(n => /declared floor/i.test(n))).toBe(true)
  })

  it('DF-1: when OSV was never queried (no deps at all), depsResolvedFromLockfile stays undefined — absence is not a value', async () => {
    const { http } = saturatedRepoHttp({ lockfile: false })
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(s.cveWorst).toBeUndefined()
    expect(s.depsResolvedFromLockfile).toBeUndefined()
  })

  // DF-1 round 4, census defect 1. Measured on the published 400-entry index:
  // `seleniumboot/selenium-mcp` went C+/67 -> C/62 and security 60 -> 40 with
  // ZERO dependency findings on either side, and `agentbodegastore/agentbodega`
  // moved the same mechanism the other way (B+/81 -> B+/83). Both repos commit
  // a package-lock.json whose entries are ALL `dev: true`, so the new dev-skip
  // empties the parsed dep list; assemble() then could not tell "a lockfile was
  // read and declares no runtime dependencies" from "no lockfile was ever read",
  // and the dependency-CVE check silently VANISHED (3/3 signals -> 2/3). A
  // package that ships no runtime dependencies genuinely has no dependency
  // CVEs. That is a clean, AVAILABLE measurement.
  const devOnlyLock = {
    '': { name: 'foo-mcp', version: '1.0.0' },
    'node_modules/vitest': { version: '3.2.7', dev: true },
    'node_modules/esbuild': { version: '0.27.7', dev: true },
  }

  it('DF-1 r4: a lockfile whose entries are all dev-only is a CLEAN dependency measurement, not a missing one', async () => {
    const { http, queried } = saturatedRepoHttp({ lockfile: true, lockPackages: devOnlyLock })
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(queried()).toEqual([])                       // nothing runtime to ask OSV about
    expect(s.cveWorst).toBe('none')                     // ... and that IS the answer
    expect(s.depsResolvedFromLockfile).toBe(true)
    expect(s.lockfileDeclaredNoRuntimeDeps).toBe(true)
    expect(s.findings.filter(f => f.id === 'security/dependency-cve')).toHaveLength(0)
    // the check stays AVAILABLE: security keeps all three of its signals
    const card = score('acme/foo', s, NOW.toISOString())
    const sec = card.dimensions.find(d => d.id === 'security')
    expect(sec?.available).toBe(3)
    expect(card.notes.some(n => /no runtime dependencies/i.test(n))).toBe(true)
    // and it must NOT be mistaken for the declared-floor case
    expect(card.notes.some(n => /declared floor/i.test(n))).toBe(false)
  })

  it('DF-1 r4: no lockfile at all is still UNAVAILABLE — the two cases stay distinguishable', async () => {
    const { http } = saturatedRepoHttp({ lockfile: false })
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(s.cveWorst).toBeUndefined()
    expect(s.lockfileDeclaredNoRuntimeDeps).toBeUndefined()
    const card = score('acme/foo', s, NOW.toISOString())
    expect(card.dimensions.find(d => d.id === 'security')?.available).toBe(2)
  })

  it('DF-1 r4: an all-dev lockfile also evicts the manifest floors for its ecosystem (the agentbodega shape, inverted)', async () => {
    const { http, queried } = saturatedRepoHttp({ lockfile: true, lockPackages: devOnlyLock })
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    // the repo's own lockfile says there are no runtime npm deps; the
    // registry manifest's ^1.0.0 floor must not be queried behind its back
    expect(queried()).toEqual([])
    expect(s.depsResolvedFromLockfile).toBe(true)
    expect(s.cveWorst).toBe('none')
  })

  // DF-1 round 4, census defect 3. The branch's own prose said pnpm/yarn/bun
  // repositories "still fall back to floors, and now say so on the card". They
  // do not fall back to floors. `depsFromManifest` runs only for an npm/PyPI
  // REGISTRY identity; for a bare `owner/repo` reference there is no manifest
  // to take floors from, so `deps` stays empty, OSV is never called, and
  // score.ts is silent BY DESIGN. Measured: the declared-floor note rendered
  // 0 times across all 191 movable references and the 18-reference control —
  // including every one of the unsupported-lockfile-only refs it was written
  // for — and rendered correctly on `npm:pluggedin-mcp-proxy`. The code is
  // right; the sentence was wrong. These two tests are what the corrected
  // sentence now asserts, so it can never drift back.
  it('DF-1 r4: a bare owner/repo ref with only an UNSUPPORTED lockfile gets no dependency check — and no floor caveat', async () => {
    const { http } = saturatedRepoHttp({
      lockfile: false,
      extraTree: [{ path: 'pnpm-lock.yaml', type: 'blob', size: 90_000 }],
    })
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(s.cveWorst).toBeUndefined()                  // OSV was never asked anything
    expect(s.depsResolvedFromLockfile).toBeUndefined()  // ... so there is no floor to caveat
    const card = score('acme/foo', s, NOW.toISOString())
    expect(card.notes.some(n => /declared floor/i.test(n))).toBe(false)
    expect(card.dimensions.find(d => d.id === 'security')?.available).toBe(2)
  })

  it('DF-1 r4: the same tree under a REGISTRY identity does get floors, and does carry the caveat', async () => {
    const { http, queried } = saturatedRepoHttp({
      lockfile: false,
      extraTree: [{ path: 'pnpm-lock.yaml', type: 'blob', size: 90_000 }],
    })
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      http, NOW,
    )
    expect(queried()).toEqual([{ name: '@modelcontextprotocol/sdk', version: '1.0.0' }])
    expect(s.depsResolvedFromLockfile).toBe(false)
    expect(score('foo-mcp', s, NOW.toISOString()).notes.some(n => /declared floor/i.test(n))).toBe(true)
  })

  it('DF-1 r4: a lockfile trovark cannot actually parse (v1, no `packages` map) degrades to no-lockfile, never to "clean"', async () => {
    const { http } = saturatedRepoHttp({ lockfile: true })
    const origText = http.text.bind(http)
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package-lock.json')) return JSON.stringify({ lockfileVersion: 1, dependencies: { zod: { version: '3.22.5' } } })
      return origText(url)
    }
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, http, NOW)
    expect(s.cveWorst).toBeUndefined()
    expect(s.lockfileDeclaredNoRuntimeDeps).toBeUndefined()
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

  it('coexists per-ecosystem: npm lockfile-resolved dep AND PyPI requires_dist floor dep both reach the OSV query', async () => {
    const http = fullFake()
    const origJson = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.startsWith('https://pypi.org/pypi/')) {
        return { info: { requires_dist: ['requests>=2.31.0'] } } as T
      }
      return origJson<T>(url)
    }
    const origText = http.text.bind(http)
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package-lock.json')) {
        return JSON.stringify({
          packages: {
            '': { name: 'foo', version: '1.0.0' },
            'node_modules/zod': { version: '3.22.5' }, // npm: lockfile-resolved
          },
        })
      }
      return origText(url)
    }
    let queried: Array<{ name: string; ecosystem: string; version: string }> = []
    http.postJson = async <T,>(url: string, body: unknown): Promise<T> => {
      if (url.includes('osv.dev')) {
        queried = (body as { queries: Array<{ package: { name: string; ecosystem: string }; version: string }> })
          .queries.map(q => ({ name: q.package.name, ecosystem: q.package.ecosystem, version: q.version }))
        return { results: queried.map(() => ({})) } as T
      }
      throw new Error(`HTTP 404 for ${url}`)
    }
    await assemble(
      {
        ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' },
        npmPackage: 'foo-mcp', pypiPackage: 'foo-mcp',
      },
      http, NOW,
    )
    // npm: resolved from the lockfile (not the manifest floor)
    expect(queried).toContainEqual({ name: 'zod', ecosystem: 'npm', version: '3.22.5' })
    // PyPI: no PyPI lockfile was fetched, so the requires_dist floor survives untouched
    expect(queried).toContainEqual({ name: 'requests', ecosystem: 'PyPI', version: '2.31.0' })
  })
})

describe('assemble — notServer classification (V2)', () => {
  // Reuses fullFake()'s acme/foo routes (tree, commits, releases, etc. are
  // already wired there) and only patches the repo-meta description + the
  // fetched source content — keeps the URLs consistent with the shared fixture.
  function sdkRepoHttp(): Http {
    const http = fullFake()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url === 'https://api.github.com/repos/acme/foo') {
        return { stargazers_count: 300, archived: false, pushed_at: iso(2), default_branch: 'main', description: 'The official Foo SDK' } as T
      }
      return orig<T>(url)
    }
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: {} })
      if (url.endsWith('src/index.ts')) return `export function helper() { return 1 }`
      if (url.endsWith('.github/workflows/ci.yml')) return 'on: [push]'
      if (url.endsWith('package-lock.json')) return '{"lockfileVersion": 3}'
      if (url.endsWith('tests/x.test.ts')) return 'it("x", () => {})'
      throw new Error(`HTTP 404 for ${url}`)
    }
    return http
  }

  it('a repo with zero extracted tools + an SDK-shaped description is classified notServer', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      sdkRepoHttp(), NOW,
    )
    expect(s.schemaExtracted).toBe(false)
    expect(s.notServer).toBe(true)
    expect(s.notServerReason).toBe('sdk')
  })

  it('GUARD: a server that DID extract tools is never reclassified as notServer, even if its description looks SDK-shaped', async () => {
    const http = sdkRepoHttp()
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      if (url.endsWith('src/index.ts')) return `server.tool('greet', 'Say hello', {}, h)`
      if (url.endsWith('.github/workflows/ci.yml')) return 'on: [push]'
      if (url.endsWith('package-lock.json')) return '{"lockfileVersion": 3}'
      if (url.endsWith('tests/x.test.ts')) return 'it("x", () => {})'
      throw new Error(`HTTP 404 for ${url}`)
    }
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      http, NOW,
    )
    expect(s.schemaExtracted).toBe(true)
    expect(s.toolCount).toBe(1)
    expect(s.notServer).toBeUndefined() // the sdk-description signal must never fire once tools were found
  })

  it('a genuine miss (imports the MCP SDK but registers tools in an unrecognized idiom) stays notServer-undefined, keeping insufficientData intact', async () => {
    const http = fullFake()
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      // proves this IS an MCP server (imports the SDK) but uses a framework/idiom
      // none of the current extractors recognize — a genuine coverage miss, not a library.
      if (url.endsWith('src/index.ts')) return `import { Server } from '@modelcontextprotocol/sdk'\nregisterAllTheThings(weirdCustomRegistry)`
      throw new Error(`HTTP 404 for ${url}`)
    }
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      http, NOW,
    )
    expect(s.schemaExtracted).toBe(false)
    expect(s.notServer).toBeUndefined() // classifyLibrary correctly declines to guess
  })
})

describe('assemble — unresolved repo (W1): a GitHub 404 must not become a degenerate all-zero card', () => {
  function notFoundHttp(): Http {
    return {
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
  }
  it('a repo-metadata 404 sets signals.unresolved and records the error, without touching other signals', async () => {
    const s = await assemble({ ref: 'acme/gone', repo: { owner: 'acme', name: 'gone' } }, notFoundHttp(), NOW)
    expect(s.unresolved).toBe(true)
    expect(s.toolSurfaceRisk).toBeUndefined()
    expect(s.daysSinceLastCommit).toBeUndefined()
    expect(s.errors.some(e => e.startsWith('github:'))).toBe(true)
  })
  it('GUARD: a generic (non-404) github failure does NOT set unresolved — stays the existing generic-error path', async () => {
    const http: Http = {
      async json<T>(url: string): Promise<T> {
        if (url === 'https://api.github.com/repos/acme/broken') throw new HttpError(500, url)
        throw new Error(`unexpected call: ${url}`)
      },
      async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
        throw new Error(`unexpected call: ${url}`)
      },
      async text(url: string): Promise<string> { throw new Error(`unexpected call: ${url}`) },
      async postJson<T>(): Promise<T> { throw new Error('unused') },
    }
    const s = await assemble({ ref: 'acme/broken', repo: { owner: 'acme', name: 'broken' } }, http, NOW)
    expect(s.unresolved).toBeUndefined()
    expect(s.errors.some(e => e.startsWith('github:'))).toBe(true)
  })
})

// W5 (coverage-v1.5, wave2-spec §2.3): partial-surface honesty, end-to-end
// through the real collectGithub selection + extractSchema + assemble wiring
// (figwright shape: far more tool-fanout files exist than the sampler's
// FILE_CAP can fetch).
describe('assemble — partial-surface honesty (W5)', () => {
  function figwrightShapedHttp(): Http {
    // 30 one-tool-per-file modules under src/tools/ trips toolFanout>=8
    // (FILE_CAP widens to 24), but 30 candidates for the 23 rankedSource
    // slots left after the 1 manifest slot means 7 are never sampled.
    const toolPaths = Array.from({ length: 30 }, (_, i) => `src/tools/tool${i}.ts`)
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/foo/commits?since': [],
      'https://api.github.com/repos/acme/foo/releases/latest': {},
      'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': {
        tree: [
          { path: 'package.json', type: 'blob', size: 500 },
          ...toolPaths.map(p => ({ path: p, type: 'blob', size: 200 })),
        ],
      },
      'https://api.github.com/repos/acme/foo': {
        stargazers_count: 10, archived: false, pushed_at: NOW.toISOString(), default_branch: 'main',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return '{"name":"foo"}'
      const m = /tool(\d+)\.ts$/.exec(url)
      return `server.tool('tool_${m ? m[1] : 'x'}', 'benign', {}, handler)`
    })
  }

  // W6 corpus-scan finding — this test's SECURITY clause was corrected; its
  // count assertions are unchanged and still right. It previously asserted
  // toolSurfaceRisk === 'none' ("security still grades on the sampled
  // tools"). Measured on the live corpus, that is exactly how
  // ViperJuice/mcp-gateway — 1 tool extracted from a tree holding more
  // tool-bearing files than the sampler reached — scored security 100/100
  // and rose to overall A+ 96: a confident clean bill for a surface we
  // simultaneously admitted we had not fully read. A benign PARTIAL sample
  // is not evidence of a benign surface; unexamined tools are precisely
  // where risk would hide. Positive risk found in a partial sample still
  // counts (see the riskForPartial cases below) — only 'none' is withheld.
  it('a repo with more tool-fanout files than the sampler reached withholds BOTH the counts and any clean risk verdict', async () => {
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, figwrightShapedHttp(), NOW)
    expect(s.schemaExtracted).toBe(true)       // extraction itself succeeded on the sample
    expect(s.toolSurfaceRisk).toBeUndefined()  // 'none' from a partial read is not a measurement
    expect(s.toolCount).toBeUndefined()        // cost declines to publish a count from a partial sample
    expect(s.schemaTokenEstimate).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// W6 review remediation item 1 — THE LOAD-BEARING STRUCTURAL TEST.
//
// W6 put the root README into snap.files, and assemble.ts handed that same
// array to five consumers written for source code (extractSchema intended;
// classifyLibrary, detectDynamic, scanSecrets, scanIntegrity not). The fix
// is architectural, not a filter at each call site: RepoSnapshot.files goes
// back to code-only semantics, and the fetched README (when present) is
// carried on its own RepoSnapshot.readme field instead — so no consumer
// that only ever receives `files` can see it, by construction, regardless
// of what any individual consumer does or doesn't filter internally.
// ---------------------------------------------------------------------------

describe('assemble — README quarantine (W6 review remediation item 1): structural invariant', () => {
  function readmeCatalogHttp(): Http {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/shim/commits?since': [],
      'https://api.github.com/repos/acme/shim/releases/latest': {},
      'https://api.github.com/repos/acme/shim/git/trees/main?recursive=1': {
        tree: [
          // Declares the MCP SDK dependency (so classifyLibrary's "no MCP
          // anywhere" signal correctly declines) but registers no tools in a
          // shape any static extractor recognizes ("no parseable code") — a
          // playwright-mcp-shaped distribution shim.
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'src/index.ts', type: 'blob', size: 200 },
          { path: 'README.md', type: 'blob', size: 3000 },
        ],
      },
      'https://api.github.com/repos/acme/shim': {
        stargazers_count: 10, archived: false, pushed_at: iso(3), default_branch: 'main',
        description: 'A distribution shim',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      if (url.endsWith('src/index.ts')) return `import { connect } from './shim-runtime.js'\nconnect()`
      if (url.endsWith('README.md')) {
        return `## Tools

- **do_a**
  - Description: does a

- **do_b**
  - Description: does b

- **do_c**
  - Description: does c
`
      }
      throw new Error(`HTTP 404 for ${url}`)
    })
  }

  it('snap.files never contains a path matching /^README\\.(md|rst)$/i — the README is carried on snap.readme instead', async () => {
    const snap = await collectGithub({ ref: 'acme/shim', repo: { owner: 'acme', name: 'shim' } }, readmeCatalogHttp(), NOW)
    expect(snap.files.some(f => /^README\.(md|rst)$/i.test(f.path))).toBe(false)
    expect(snap.readme?.path).toBe('README.md')
    expect(snap.readme?.content).toContain('do_a')
  })

  it('the README rung still works end-to-end: a repo with no parseable code but a valid >=3-tool README catalog still extracts those tools', async () => {
    const s = await assemble({ ref: 'acme/shim', repo: { owner: 'acme', name: 'shim' } }, readmeCatalogHttp(), NOW)
    expect(s.toolCount).toBe(3)
    expect(s.findings.some(f => f.id === 'reliability/readme-sourced-tools')).toBe(true)
  })

  it('D2: README-rung tools are threaded through Signals with toolSource readme-catalog (artifact provenance)', async () => {
    const s = await assemble({ ref: 'acme/shim', repo: { owner: 'acme', name: 'shim' } }, readmeCatalogHttp(), NOW)
    expect(s.tools).toHaveLength(3)
    expect(s.toolSource).toBe('readme-catalog')
    expect(s.tools![0]).not.toHaveProperty('evidence')
  })
})

// W6 corpus-scan finding: a PARTIAL tool surface may not publish 'none'.
// Measured on the live corpus: ViperJuice/mcp-gateway extracted 1 tool from a
// tree containing more tool-bearing files than the sampler reached; the
// resulting toolSurfaceRisk 'none' scored security 100/100 and lifted the repo
// to A+ 96 — a confident clean bill for a surface we admit we did not fully
// read. Positive risk evidence from a partial sample still counts (sampling
// can omit risk but never invent it); the absence of evidence does not.
describe('partial tool surface never publishes a clean risk verdict', () => {
  it("drops 'none' to undefined when the surface is partial", () => {
    expect(riskForPartial('none', true)).toBeUndefined()
  })
  it("keeps 'none' when the surface is complete", () => {
    expect(riskForPartial('none', false)).toBe('none')
  })
  for (const risk of ['low', 'medium', 'high'] as const) {
    it(`keeps '${risk}' even on a partial surface (positive evidence survives)`, () => {
      expect(riskForPartial(risk, true)).toBe(risk)
    })
  }
})

// Mirrors the expression in src/assemble.ts so the rule is pinned independently
// of the surrounding network-dependent assemble() path.
function riskForPartial(
  risk: 'none' | 'low' | 'medium' | 'high' | undefined,
  surfacePartial: boolean,
): 'none' | 'low' | 'medium' | 'high' | undefined {
  return surfacePartial && risk === 'none' ? undefined : risk
}

// ---------------------------------------------------------------------------
// D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md
// Task 3): the extracted tool surface is threaded through Signals for
// SNAPSHOTTING only — an artifact, never a signal. The second test is the
// load-bearing one: rubric.ts must never mention the new fields.
// ---------------------------------------------------------------------------

describe('assemble — tools threaded through Signals as artifact-only (D2)', () => {
  it('threads extracted tools + source into Signals as an artifact (never scored)', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      fullFake(), NOW,
    )
    expect(s.tools).toBeDefined()
    expect(s.tools!.length).toBeGreaterThan(0)
    expect(s.toolSource).toBe('code')
    expect(s.tools![0]).toHaveProperty('name')
    expect(s.tools![0]).toHaveProperty('schemaText')
    // evidence is stripped: hashes must cover tool content, not our file paths
    expect(s.tools![0]).not.toHaveProperty('evidence')
  })

  it('rubric provably never reads Signals.tools/toolSource (artifact-only guarantee)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/scoring/rubric.ts', 'utf8')
    expect(/\btools\b|\btoolSource\b/.test(src)).toBe(false)
  })
})

// Fault hunt 2026-08-08 (C5). A file the tree listed but the blob fetch could
// not read (403/429/5xx after retries) was previously skipped with an empty
// catch — a rate-limited run simply graded a SMALLER repo than the one that
// exists, with no record anywhere that the sample was incomplete. The grade
// this produces is not merely lower-confidence, it is a different verdict
// derived from a sample we know is wrong.
describe('C5: failed blob fetches are recorded and force a partial surface', () => {
  function flakyHttp(failPath: string): Http {
    const http = fullFake()
    const origText = http.text.bind(http)
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith(failPath)) throw new HttpError(403, url)
      return origText(url)
    }
    return http
  }

  it('names the unfetchable path in errors and withholds the counts', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      flakyHttp('src/index.ts'), NOW,
    )
    expect(s.errors.some(e => e.includes('src/index.ts'))).toBe(true)
    // the sample is incomplete: no confident counts, no clean risk verdict
    expect(s.toolCount).toBeUndefined()
    expect(s.schemaTokenEstimate).toBeUndefined()
    expect(s.toolSurfaceRisk).not.toBe('none')
  })

  it('a fully-fetched repo records no fetch failures and grades normally', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      fullFake(), NOW,
    )
    expect(s.errors).toEqual([])
    expect(s.toolCount).toBe(1)
  })

  // DF-1 round 4, census defect 2. A lockfile is an EXTRA fetch this branch
  // introduced: it widens finalCap, displaces no ranked source, and feeds
  // nothing but the dependency-CVE check. Losing it therefore cannot make the
  // TOOL SURFACE partial — yet it went into the same fetchFailures list as a
  // source file, forced surfacePartial, erased a 'none' tool-surface verdict,
  // tripped securityPrimaryAbsent and voided the whole scorecard. Measured on
  // the census: TheLunarCompany/lunar (published A+ / 96) came back `exit 2,
  // insufficient data - could not fetch 1 selected file(s):
  // mcpx/mcpx-e2e-tests/package-lock.json` on the first of three attempts and
  // graded fine on the other two. One in 191 references on first attempt,
  // turning an A+ entry into NO entry — and this branch raises the number of
  // fetches per reference by one or two.
  it('DF-1 r4: an unfetchable LOCKFILE degrades the dependency check and carries a caveat — it does not void the card', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      flakyHttp('package-lock.json'), NOW,
    )
    // the ranked source all arrived, so the surface is whole and stays scored
    expect(s.toolSurfaceRisk).toBe('none')
    expect(s.toolCount).toBe(1)
    const card = score('acme/foo', s, NOW.toISOString())
    expect(card.insufficientData).toBe(false)
    expect(card.grade).not.toBeNull()
    // but the reader is told the lockfile is missing from THIS read
    expect(s.errors.some(e => /package-lock\.json/.test(e))).toBe(true)
    expect(s.errors.some(e => /lockfile/i.test(e))).toBe(true)
    // ... and it degrades to exactly "no lockfile read": no dependency check
    expect(s.cveWorst).toBeUndefined()
    expect(s.lockfileDeclaredNoRuntimeDeps).toBeUndefined()
  })

  it('DF-1 r4: an unfetchable SOURCE file is still fatal — the fix must not weaken C5', async () => {
    const s = await assemble(
      { ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } },
      flakyHttp('src/index.ts'), NOW,
    )
    expect(s.toolSurfaceRisk).toBeUndefined()
    expect(score('acme/foo', s, NOW.toISOString()).insufficientData).toBe(true)
  })
})

// DF-1 round 4, census defect 3 — the prose half. The two tests above pin what
// the code ACTUALLY does with an unsupported lockfile on a bare `owner/repo`
// reference: nothing, silently and correctly. The shipped documentation claimed
// the opposite — that such repositories "still fall back to declared floors" and
// "now say so on the card" — and a reader acting on that sentence would look for
// a caveat that provably cannot render on 400 of 400 indexed entries. Absence of
// a dependency check is not a floor-based check, and the difference matters to
// anyone deciding whether trovark has vetted a server's dependencies. These
// assertions make the corrected sentences load-bearing so they cannot drift back.
describe('DF-1 r4: the docs say where the declared-floor caveat actually applies', () => {
  const read = async (p: string) => (await import('node:fs')).readFileSync(p, 'utf8')

  it('docs/methodology.md does not claim an unsupported lockfile falls back to floors, and states the real outcome', async () => {
    const src = await read('docs/methodology.md')
    expect(/(?:pnpm|yarn|bun)[^.]*fall back to declared floors/i.test(src)).toBe(false)
    expect(/no dependency check at all/i.test(src)).toBe(true)
  })

  it('CHANGELOG.md scopes the declared-floor caveat to a registry identity', async () => {
    const src = await read('CHANGELOG.md')
    expect(/When no supported lockfile was read, the card now says/i.test(src)).toBe(false)
    expect(/no dependency check at all/i.test(src)).toBe(true)
  })
})

// Rubric 1.7.0 (2026-08-15): the serialized token footprint stops being a
// SCORED signal and becomes a published FACT. `tokenFootprint()` and the
// `schemaTokenEstimate` threading are unchanged — what changes is that
// nothing in src/scoring/rubric.ts reads the number any more, and assemble.ts
// instead attaches it as an informational finding so the measurement we CAN
// make for ~5% of servers is still published rather than thrown away.
//
// The asymmetry that forced this: as a scored signal, its ABSENCE flattered.
// A 5-tool server with a 25k-token schema scored 67; the same server with an
// unreadable schema scored 100. As a finding, absence is simply silent — and
// silence is the one rendering that cannot be mistaken for a good number.
describe('cost/token-footprint is published as an informational finding, not scored', () => {
  const manifestTool = (name: string, description: string) => ({
    name, description,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] },
  })

  function manifestHttp(): Http {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/manifest/commits?since': [
        { sha: '1', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
      ],
      'https://api.github.com/repos/acme/manifest/git/trees/main?recursive=1': {
        tree: [
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'mcp.json', type: 'blob', size: 900 },
        ],
      },
      'https://api.github.com/repos/acme/manifest': {
        stargazers_count: 120, archived: false, pushed_at: iso(2), default_branch: 'main',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.2.0' } })
      if (url.endsWith('mcp.json')) {
        return JSON.stringify({ tools: [manifestTool('search_docs', 'Search documentation'), manifestTool('lookup_symbol', 'Look up a symbol')] })
      }
      throw new Error(`HTTP 404 for ${url}`)
    })
  }

  it('attaches the finding when the footprint is genuinely measured, naming the figure and the source', async () => {
    const s = await assemble({ ref: 'acme/manifest', repo: { owner: 'acme', name: 'manifest' } }, manifestHttp(), NOW)
    expect(typeof s.schemaTokenEstimate).toBe('number')
    const f = s.findings.find(x => x.id === 'cost/token-footprint')!
    expect(f).toBeDefined()
    expect(f.dimension).toBe('cost')
    expect(f.severity).toBe('info')
    // the measured figure itself, as published
    expect(f.message).toContain(s.schemaTokenEstimate!.toLocaleString('en-US'))
    expect(f.message).toMatch(/tools\/list/)
    expect(f.message).toMatch(/declared JSON schemas/i)
    // evidence names the file the schemas were read from — principle 2
    expect(f.evidence).toContain('mcp.json')
  })

  it('says nothing at all when the footprint could not be measured — absence is silent, never "0 tokens"', async () => {
    // fullFake's tool surface is source-extracted (zod/TS text), so
    // tokenFootprint() correctly declines: ~95% of the corpus.
    const s = await assemble({ ref: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } }, fullFake(), NOW)
    expect(s.schemaTokenEstimate).toBeUndefined()
    expect(s.findings.some(f => f.id === 'cost/token-footprint')).toBe(false)
    expect(s.findings.some(f => /0 tokens/.test(f.message))).toBe(false)
  })

  it('a partial surface publishes no footprint fact either — the count would be from a sample we know is incomplete', async () => {
    const http = manifestHttp()
    const origText = http.text.bind(http)
    http.text = async (url: string): Promise<string> => {
      if (url.endsWith('package.json')) throw new HttpError(403, url)
      return origText(url)
    }
    const s = await assemble({ ref: 'acme/manifest', repo: { owner: 'acme', name: 'manifest' } }, http, NOW)
    expect(s.schemaTokenEstimate).toBeUndefined()
    expect(s.findings.some(f => f.id === 'cost/token-footprint')).toBe(false)
  })

  it('the finding is routed to the cost dimension and changes no score — a fact, not a signal', async () => {
    const s = await assemble({ ref: 'acme/manifest', repo: { owner: 'acme', name: 'manifest' } }, manifestHttp(), NOW)
    const card = score('acme/manifest', s, NOW.toISOString())
    const cost = card.dimensions.find(d => d.id === 'cost')!
    expect(cost.findings.map(f => f.id)).toContain('cost/token-footprint')
    // 2 tools -> band(2) = 1.0 -> 100, exactly as it would be with no
    // footprint measured at all.
    expect(cost.score).toBe(100)
    const withoutFact = score('acme/manifest', { ...s, findings: s.findings.filter(f => f.id !== 'cost/token-footprint') }, NOW.toISOString())
    expect(withoutFact.dimensions.find(d => d.id === 'cost')!.score).toBe(cost.score)
    expect(withoutFact.overall).toBe(card.overall)
  })
})

// assemble()'s per-collector catches record a failure in errors[] so one
// registry outage lowers confidence instead of aborting the scan. A
// RateLimitError is about this machine's budget, not the ref, and the GitHub
// branch already lets it out — the npm and OSV branches must too, or the
// same exhausted budget is reported two different ways depending on which
// collector happened to see it first.
describe('assemble — RateLimitError escapes the npm and OSV catches too', () => {
  it('from the npm collector', async () => {
    const base = fullFake()
    const http: Http = {
      ...base,
      async json<T>(url: string): Promise<T> {
        if (url.startsWith('https://registry.npmjs.org/')) throw new RateLimitError(429, url, undefined)
        return base.json<T>(url)
      },
    }
    await expect(assemble({ ref: 'foo-mcp', npmPackage: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } }, http, NOW))
      .rejects.toBeInstanceOf(RateLimitError)
  })
  it('from the npm weekly-downloads call, whose catch used to swallow everything', async () => {
    // The registry document call was covered above; the api.npmjs.org
    // downloads call had its own `.catch(() => undefined)` that ate a
    // RateLimitError too — the one catch that wraps a request and was not
    // routed through rethrowIfCallerSide.
    const base = fullFake()
    const http: Http = {
      ...base,
      async json<T>(url: string): Promise<T> {
        if (url.startsWith('https://api.npmjs.org/')) throw new RateLimitError(429, url, undefined)
        return base.json<T>(url)
      },
    }
    await expect(collectNpm('foo-mcp', http)).rejects.toBeInstanceOf(RateLimitError)
  })
  it('from the OSV batch query', async () => {
    const base = fullFake()
    const http: Http = {
      ...base,
      async postJson<T>(url: string): Promise<T> { throw new RateLimitError(429, url, undefined) },
    }
    // The npm identity is what gives OSV something to query (collectOsv
    // short-circuits on zero deps); the fixture's manifest declares zod.
    await expect(assemble({ ref: 'foo-mcp', npmPackage: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } }, http, NOW))
      .rejects.toBeInstanceOf(RateLimitError)
  })
})
