import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { AuthError, HttpError, RateLimitError } from '../src/util/http.js'
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
    throw new HttpError(404, url) // what the real http layer throws for a missing route
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
    expect(card.rubricVersion).toBe('1.7.0') // 1.7.0: cost scores tool-count alone
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
  it('--help → usage on stdout, exit 0', async () => {
    // Asking for help is not an error. Writing it to stderr with exit 2 makes
    // `trovark --help | less` show an empty page and fails any `set -e` script.
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Usage')
    expect(r.err).toBe('')
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
  it('invalid --fail-under value (not a grade letter or number) errors, exit 2', async () => {
    const r = await run(['acme/foo', '--fail-under', 'Z'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/Invalid --fail-under/)
  })
  it('--fail-under exactly at the grade passes — "meets" counts as beating it', async () => {
    const json = JSON.parse((await run(['acme/foo', '--json'])).out)
    const r = await run(['acme/foo', '--fail-under', String(json.overall)])
    expect(r.code).toBe(0)
  })
  it('--fail-under one point above the grade fails', async () => {
    const json = JSON.parse((await run(['acme/foo', '--json'])).out)
    const r = await run(['acme/foo', '--fail-under', String(json.overall + 1)])
    expect(r.code).toBe(1)
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
  // Fault hunt 2026-08-08 (IMPORTANT) — this test previously asserted the
  // OPPOSITE contract ("--fail-under is a no-op, exit 0"). That let a CI
  // gate demanding a minimum grade silently PASS on a library or dynamic
  // gateway, while the sibling ungradeable states (unresolved,
  // insufficientData) both exit non-zero. A card with no grade cannot
  // satisfy "grade >= threshold". Without --fail-under, exit 0 stands.
  it('--fail-under fails (exit 1) on a notServer ref: no grade cannot pass a threshold', async () => {
    const r = await runSdk(['acme/foo-sdk', '--fail-under', 'A'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('no grade to compare')
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
  it('--fail-under cannot turn insufficient data into a pass — exits 2 regardless of threshold', async () => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/foo', '--fail-under', '0'], { http: unfetchable, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
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

// A mistyped flag used to be spliced past and ignored. For --fail-under that
// silently converts a CI gate into a permanent pass, which is worse than
// having no gate: the workflow stays green and nobody looks again.
describe('cli main — unknown flags are rejected, not ignored', () => {
  it('a typo\'d --fail-under exits 2 and names the flag instead of passing', async () => {
    const r = await run(['acme/foo', '--fail-undr', '90'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('--fail-undr')
  })
  it('suggests the nearest known flag', async () => {
    const r = await run(['acme/foo', '--fail-undr', '90'])
    expect(r.err).toContain('Did you mean "--fail-under"?')
  })
  it('rejects an unknown flag wherever it appears, not only before the ref', async () => {
    const before = await run(['--failunder', '90', 'acme/foo'])
    const after = await run(['acme/foo', '--failunder', '90'])
    expect(before.code).toBe(2)
    expect(after.code).toBe(2)
    expect(after.err).toContain('--failunder')
  })
  it('rejects a second positional ref rather than silently scoring the first', async () => {
    const r = await run(['acme/foo', 'acme/bar'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('Expected one <ref>')
  })
  it('still accepts every known flag together', async () => {
    const r = await run(['acme/foo', '--json', '--no-color', '--fail-under', 'D'])
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.out)).not.toThrow()
  })
  it('a real threshold breach still exits 1, not 2', async () => {
    const r = await run(['acme/foo', '--fail-under', '99'])
    expect(r.code).toBe(1)
  })

  it('an exhausted rate limit blames the budget, not the scanned repo', async () => {
    // Before: stdout showed "Trust Score: INSUFFICIENT DATA" with four
    // "not measured" dimensions, and stderr said "insufficient data to score
    // this ref" — about a repo that grades A+ when a token is present.
    const reset = Math.floor(Date.UTC(2026, 6, 31, 1, 30, 0) / 1000)
    const limited = {
      ...fake,
      async json<T>(url: string): Promise<T> {
        if (url.startsWith('https://api.github.com/')) {
          throw new RateLimitError(403, url, reset)
        }
        return fake.json<T>(url)
      },
    }
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/foo'], { http: limited, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(errs.join('\n')).toMatch(/rate limit/i)
    expect(errs.join('\n')).toMatch(/GITHUB_TOKEN/)
    expect(logs.join('\n')).not.toMatch(/INSUFFICIENT DATA/)
  })
})

// A rate limit that bites AFTER the first call used to be swallowed by the
// collector's fail-soft catches and published as a scorecard. Measured at
// f7f4f34 with this same fixture: the budget dying on the commits page (the
// second API call) exited 0 with a confident "Trust Score: 86/100 (A-)" and
// health 100/100; dying on the tree fetch (the last API call) exited 2 with
// INSUFFICIENT DATA — blaming the ref. Only a rate limit on the very first
// call was reported honestly. A partial card is never the honest outcome for
// an exhausted budget: every swallow site must let a RateLimitError out.
describe('cli main — a rate limit that bites mid-scan is still a rate limit', () => {
  const reset = Math.floor(Date.UTC(2026, 6, 31, 1, 30, 0) / 1000)
  // The fixture's happy path, except that the call matching `dies` is the
  // one on which the budget runs out.
  const limitedAfter = (dies: (url: string) => boolean): Http => ({
    async json<T>(url: string): Promise<T> {
      if (dies(url)) throw new RateLimitError(403, url, reset)
      return fake.json<T>(url)
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      if (dies(url)) throw new RateLimitError(403, url, reset)
      return fake.jsonWithHeaders<T>(url)
    },
    async postJson<T>(url: string, body: unknown): Promise<T> { return fake.postJson<T>(url, body) },
    async text(url: string): Promise<string> {
      if (dies(url)) throw new RateLimitError(429, url, reset)
      return fake.text(url)
    },
  })
  it.each([
    ['the commits page (second API call)', (u: string) => u.includes('/commits')],
    ['releases/latest', (u: string) => u.includes('/releases/latest')],
    ['the tree fetch (last API call)', (u: string) => u.includes('/git/trees/')],
    ['a selected blob fetch', (u: string) => u.endsWith('/src/server.js')],
  ])('budget dies on %s → exit 2 naming the rate limit, and no card is printed', async (_label, dies) => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/foo'], { http: limitedAfter(dies), now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(errs.join('\n')).toMatch(/rate limit/i)
    expect(errs.join('\n')).toMatch(/GITHUB_TOKEN/)
    expect(logs.join('\n')).not.toMatch(/INSUFFICIENT DATA/)
    expect(logs.join('\n')).not.toMatch(/Trust Score: \d/)
  })
})

// Measured live at f7f4f34 with GITHUB_TOKEN=ghp_definitelybogus: exit 2,
// "trovark: insufficient data to score this ref", a card of four "not
// measured" dimensions, and the only clue a note reading "github: HTTP 401
// for <url>". The ref was modelcontextprotocol/servers, which grades A- with
// a working token. A rejected credential is the caller's problem and must be
// named as such.
describe('cli main — a rejected GITHUB_TOKEN is reported as the caller\'s credential, not as the ref', () => {
  const rejectedOn = (dies: (url: string) => boolean): Http => ({
    ...fake,
    async json<T>(url: string): Promise<T> {
      if (dies(url)) throw new AuthError(401, url)
      return fake.json<T>(url)
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      if (dies(url)) throw new AuthError(401, url)
      return fake.jsonWithHeaders<T>(url)
    },
  })
  it.each([
    ['the first call (repo metadata)', (u: string) => u === 'https://api.github.com/repos/acme/foo'],
    ['a later call (the commits page)', (u: string) => u.includes('/commits')],
  ])('rejected on %s → exit 2, names GITHUB_TOKEN as rejected, prints no card', async (_label, dies) => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(['acme/foo'], { http: rejectedOn(dies), now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(errs.join('\n')).toMatch(/GITHUB_TOKEN/)
    expect(errs.join('\n')).toMatch(/rejected/i)
    expect(errs.join('\n')).not.toMatch(/insufficient data/i)
    expect(logs.join('\n')).not.toMatch(/INSUFFICIENT DATA/)
    expect(logs.join('\n')).not.toMatch(/Trust Score: \d/)
  })
})

// Measured at f7f4f34 with the fake-fetch harness: with no network at all,
// `trovark @scope/pkg` printed "Could not resolve "@scope/pkg". Accepted
// forms: GitHub URL, owner/repo, npm package name, PyPI package name." —
// a syntax lecture for an infrastructure failure.
describe('cli main — a registry that could not be reached is reported as such', () => {
  const networkDown: Http = {
    async json(): Promise<never> {
      const e = new TypeError('fetch failed') as TypeError & { cause?: unknown }
      e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })
      throw e
    },
    async jsonWithHeaders() { throw new Error('unused') },
    async text() { throw new Error('unused') },
    async postJson() { throw new Error('unused') },
  }
  it.each(['@scope/pkg', 'bare-name', 'npm:bare-name'])('%s with no network → exit 2, no "Accepted forms"', async (ref) => {
    const logs: string[] = [], errs: string[] = []
    const code = await main([ref], { http: networkDown, now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    expect(code).toBe(2)
    expect(errs.join('\n')).not.toMatch(/Accepted forms/)
    expect(errs.join('\n')).toMatch(/could not (be )?reach/i)
    expect(errs.join('\n')).toMatch(/ECONNREFUSED/)
    expect(logs.join('\n')).toBe('')
  })
})

// Measured at f7f4f34: the fixture grades 77/B, and `--fail-under B+`
// exited 0. cli.ts stripped the modifier — GRADE_FLOOR[raw.replace(/[+-]$/,
// '')] — so B+ gated at B's band floor (70), and A- at 85 was the only
// modifier that happened to be right. A CI gate demanding B+ passed every
// B- in the corpus.
describe('cli main — --fail-under honours +/- modifiers from the grade() band table', () => {
  it('the fixture scores 77 (B) — the premise every row below relies on', async () => {
    const card = JSON.parse((await run(['acme/foo', '--json'])).out)
    expect(card.overall).toBe(77)
    expect(card.grade).toBe('B')
  })
  // Bare letters keep their published meaning — the whole band, so `B`
  // accepts B-, B and B+, exactly as `--fail-under B` in the README always
  // has. A modifier narrows it to the floor of that label.
  it.each([
    ['A+', 1], ['A', 1], ['A-', 1],
    ['B+', 1], ['B', 0], ['B-', 0],
    ['C+', 0], ['C', 0], ['C-', 0],
    ['D+', 0], ['D', 0], ['D-', 0],
  ])('--fail-under %s on a 77/B card exits %i', async (label, expected) => {
    expect((await run(['acme/foo', '--fail-under', label])).code).toBe(expected)
  })
  it('is case-insensitive: b+ gates like B+', async () => {
    expect((await run(['acme/foo', '--fail-under', 'b+'])).code).toBe(1)
  })
  it.each(['B*', 'B++', '+B', 'F', 'E+', 'A+ '])('rejects "%s" as an invalid threshold rather than guessing, exit 2', async (label) => {
    const r = await run(['acme/foo', '--fail-under', label])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/Invalid --fail-under/)
  })
})
