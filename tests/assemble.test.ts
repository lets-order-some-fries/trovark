import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { collectGithub } from '../src/collectors/github.js'
import { HttpError } from '../src/util/http.js'
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
    expect(s.integrityScanned).toEqual({ files: 2, chars: expect.any(Number), tools: 1 })
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

  it('a repo with more detected tool-fanout files than the sampler reached leaves toolCount/schemaTokenEstimate undefined, but still grades security on the sampled tools', async () => {
    const s = await assemble({ ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }, figwrightShapedHttp(), NOW)
    expect(s.schemaExtracted).toBe(true)       // extraction itself succeeded on the sample
    expect(s.toolSurfaceRisk).toBe('none')     // security still grades on the sampled tools
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
})
