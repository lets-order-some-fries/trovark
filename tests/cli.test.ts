import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import type { Http } from '../src/util/http.js'

// Minimal fake: a healthy-enough GitHub-only server.
const NOW = new Date('2026-07-31T00:00:00Z')
const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const fake: Http = {
  async json<T>(url: string): Promise<T> {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/foo/commits?since': [
        { sha: '1', commit: { author: { date: iso(1) } }, author: { login: 'a' } },
        { sha: '2', commit: { author: { date: iso(2) } }, author: { login: 'a' } },
        { sha: '3', commit: { author: { date: iso(3) } }, author: { login: 'a' } },
      ],
      'https://api.github.com/repos/acme/foo/releases/latest': { published_at: iso(5) },
      'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': { tree: [
        { path: 'package.json', type: 'blob', size: 100 },
      ] },
      'https://api.github.com/repos/acme/foo': {
        stargazers_count: 2000, archived: false, pushed_at: iso(1), default_branch: 'main',
      },
    }
    for (const [p, b] of Object.entries(routes)) if (url.startsWith(p)) return b as T
    throw new Error(`HTTP 404 for ${url}`)
  },
  async postJson<T>(): Promise<T> { return { results: [{}] } as T },
  async text(url: string): Promise<string> {
    if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
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
    expect(card.rubricVersion).toBe('1.0.0')
    expect(card.dimensions).toHaveLength(4)
    expect(card.ref).toBe('acme/foo')
  })
  it('--fail-under A exits 1 when below A', async () => {
    const r = await run(['acme/foo', '--fail-under', 'A'])
    // fake repo has no CI/tests/lockfile and no extractable schema; lands ~B
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

describe('cli main — insufficient data', () => {
  const unfetchable: Http = {
    async json() { throw new Error('HTTP 403') },
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
