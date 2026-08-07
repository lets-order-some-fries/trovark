import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { HttpError } from '../src/util/http.js'
import type { Http } from '../src/util/http.js'

// Minimal fake: a healthy-enough GitHub-only server.
const NOW = new Date('2026-07-31T00:00:00Z')
const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const routes: Record<string, unknown> = {
  'https://api.github.com/repos/acme/foo/commits?since': [
    { sha: '1', commit: { author: { date: iso(1) } }, author: { login: 'a' } },
    { sha: '2', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
    { sha: '3', commit: { author: { date: iso(3) } }, author: { login: 'a' } },
  ],
  'https://api.github.com/repos/acme/foo/releases/latest': { published_at: iso(5) },
  'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': { tree: [
    { path: 'package.json', type: 'blob', size: 100 },
    { path: 'src/server.js', type: 'blob', size: 200 },
  ] },
  'https://api.github.com/repos/acme/foo': {
    stargazers_count: 2000, archived: false, pushed_at: iso(1), default_branch: 'main',
  },
}
const fake: Http = {
  async json<T>(url: string): Promise<T> {
    for (const [p, b] of Object.entries(routes)) if (url.startsWith(p)) return b as T
    throw new Error(`HTTP 404 for ${url}`)
  },
  // Real (not a stub): collectGithub paginates commits through this method;
  // this fixture's single page has no Link header → one page, as before.
  async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
    for (const [p, b] of Object.entries(routes)) if (url.startsWith(p)) return { data: b as T, headers: new Headers() }
    throw new Error(`HTTP 404 for ${url}`)
  },
  async postJson<T>(): Promise<T> { return { results: [{}] } as T },
  async text(url: string): Promise<string> {
    if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
    // A minimal tool registration so the security dimension's PRIMARY signal
    // (tool-surface) is determinable — without this the P1 coverage gate
    // correctly withholds a confident grade for this fixture.
    if (url.endsWith('src/server.js')) return 'server.tool("add_numbers", "adds two numbers")'
    throw new Error(`HTTP 404 for ${url}`)
  },
}

const run = async (argv: string[]) => {
  const logs: string[] = [], errs: string[] = []
  const code = await main(argv, { http: fake, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
  return { code, out: logs.join('\n'), err: errs.join('\n') }
}

describe('cli main', () => {
  it('scores a repo and exits 0', async () => {
    const r = await run(['acme/foo'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Trust Score:')
  })
  it('--json emits parseable scorecard', async () => {
    const r = await run(['acme/foo', '--json'])
    const card = JSON.parse(r.out)
    expect(card.rubricVersion).toBe('1.6.0')
    expect(card.dimensions).toHaveLength(4)
    expect(card.ref).toBe('acme/foo')
  })
  it('--fail-under A exits 1 when below A', async () => {
    const r = await run(['acme/foo', '--fail-under', 'A'])
    // fake repo has no CI/tests/lockfile; lands ~B despite a clean, extractable tool surface
    expect(r.code).toBe(1)
  })
  it('--fail-under 10 passes', async () => {
    expect((await run(['acme/foo', '--fail-under', '10'])).code).toBe(0)
  })
  it('unresolvable ref → exit 2 with accepted forms in stderr', async () => {
    const r = await run(['definitely-not-real'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/Accepted forms/i)
  })
  it('no args → help text, exit 2', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.err).toContain('Usage')
  })
  it('report header shows the resolved identity', async () => {
    const r = await run(['acme/foo'])
    expect(r.out).toContain('resolved: github.com/acme/foo')
  })
  it('--fail-under without a value errors instead of silently passing', async () => {
    const r = await run(['acme/foo', '--fail-under'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/requires a value/)
  })
})

describe('cli main — notServer (I9)', () => {
  // A minimal repo whose name alone triggers classifyLibrary Tier A (zero
  // tools extracted from a bare package.json) — a distinct terminal state
  // from a real graded server.
  const sdkRoutes: Record<string, unknown> = {
    'https://api.github.com/repos/acme/foo-sdk/commits?since': [],
    'https://api.github.com/repos/acme/foo-sdk/releases/latest': { published_at: iso(5) },
    'https://api.github.com/repos/acme/foo-sdk/git/trees/main?recursive=1': { tree: [
      { path: 'package.json', type: 'blob', size: 100 },
    ] },
    'https://api.github.com/repos/acme/foo-sdk': {
      stargazers_count: 500, archived: false, pushed_at: iso(1), default_branch: 'main',
      description: 'The official Foo SDK', topics: [],
    },
  }
  const sdkHttp: Http = {
    async json<T>(url: string): Promise<T> {
      for (const [p, b] of Object.entries(sdkRoutes)) if (url.startsWith(p)) return b as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      for (const [p, b] of Object.entries(sdkRoutes)) if (url.startsWith(p)) return { data: b as T, headers: new Headers() }
      throw new Error(`HTTP 404 for ${url}`)
    },
    async postJson<T>(): Promise<T> { return { results: [{}] } as T },
    async text(url: string): Promise<string> {
      if (url.endsWith('package.json')) return '{"name":"foo-sdk"}'
      throw new Error(`HTTP 404 for ${url}`)
    },
  }
  const runSdk = async (argv: string[]) => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(argv, { http: sdkHttp, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    return { code, out: logs.join('\n'), err: errs.join('\n') }
  }
  it('--json emits no numeric overall/grade for a notServer ref', async () => {
    const r = await runSdk(['acme/foo-sdk', '--json'])
    const card = JSON.parse(r.out)
    expect(card.notServer).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
  })
  it('--fail-under is a no-op (exit 0) on a notServer ref, even at the strictest threshold', async () => {
    const r = await runSdk(['acme/foo-sdk', '--fail-under', 'A'])
    expect(r.code).toBe(0)
  })
  it('terminal output reports LIBRARY, not INSUFFICIENT DATA, and exits 0 with no --fail-under', async () => {
    const r = await runSdk(['acme/foo-sdk'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('LIBRARY')
  })
})

describe('cli main — insufficient data', () => {
  const unfetchable: Http = {
    async json() { throw new Error('HTTP 403') },
    async jsonWithHeaders() { throw new Error('HTTP 403') },
    async postJson() { throw new Error('HTTP 403') },
    async text() { throw new Error('HTTP 403') },
  }
  it('unfetchable repo → INSUFFICIENT DATA, exit 2', async () => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/foo'], { http: unfetchable, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(logs.join('\n')).toContain('INSUFFICIENT DATA')
    expect(errs.join('\n')).toMatch(/insufficient data/i)
  })
})

describe('cli main — unresolved repo (W1): a 404 must never print a graded F card', () => {
  const notFound: Http = {
    async json(url: string) { throw new HttpError(404, url) },
    async jsonWithHeaders() { throw new Error('unused') },
    async postJson() { throw new Error('unused') },
    async text() { throw new Error('unused') },
  }
  it('exits 2 with "repository not found" in stderr, and never prints a Trust Score / F grade', async () => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/gone'], { http: notFound, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(errs.join('\n')).toMatch(/repository not found: acme\/gone/i)
    expect(logs.join('\n')).not.toContain('Trust Score:')
    expect(logs.join('\n')).not.toMatch(/\(F\)/)
  })
  it('--json emits unresolved:true with null overall/grade, not a fabricated F', async () => {
    const logs: string[] = [], errs: string[] = []
    await main(['acme/gone', '--json'], { http: notFound, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    const card = JSON.parse(logs.join('\n'))
    expect(card.unresolved).toBe(true)
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
  })
  it('--fail-under cannot turn this into a pass — unresolved always exits 2 regardless of threshold', async () => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/gone', '--fail-under', '0'], { http: notFound, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
  })
})
