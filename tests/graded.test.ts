import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { main } from '../src/cli.js'
import { collectGithub } from '../src/collectors/github.js'
import { collectNpm } from '../src/collectors/npm.js'
import { renderTerminal } from '../src/report/terminal.js'
import { score } from '../src/scoring/score.js'
import type { Scorecard, Signals } from '../src/types.js'
import type { Http } from '../src/util/http.js'

// DF-4 — the graded revision's identity, at the collector layer.
//
// A trovark score is meant to be citable: pasted into a README or a
// procurement doc and re-derived later by a skeptic. It could not be. The
// scorecard carried rubricVersion and checksVersion — the GRADER's versions —
// and nothing at all identifying the artifact that was read. Worse,
// collectGithub fetches `git/trees/<default_branch>`, so an `npm:` ref grades
// the maintainer's working branch rather than the tarball the user is about
// to install.
//
// Both shas below come out of responses collectGithub ALREADY fetches: the
// tree document's own `sha`, and page 1 entry 0 of `/commits` (which defaults
// to the default branch, so entry 0 is that branch's HEAD). No extra request.

const NOW = new Date('2026-09-22T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

const TREE_REF_SHA = 'aaaaaaabbbbbbbccccccc111111122222223333333'
const HEAD_SHA = 'ffffeee1111222233334444555566667777888899'
const PUBLISHED_SHA = 'pub99998888777766665555444433332222111100'

function fakeHttp(): Http {
  const routes: Record<string, unknown> = {
    'https://api.github.com/repos/acme/foo/commits?since': [
      { sha: HEAD_SHA, commit: { author: { date: iso(2) } }, author: { login: 'a' } },
      { sha: 'older111', commit: { author: { date: iso(9) } }, author: { login: 'b' } },
    ],
    'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': {
      sha: TREE_REF_SHA,
      tree: [
        { path: 'package.json', type: 'blob', size: 300 },
        { path: 'src/index.ts', type: 'blob', size: 500 },
      ],
    },
    'https://api.github.com/repos/acme/foo': {
      stargazers_count: 10, archived: false, pushed_at: iso(2), default_branch: 'main',
    },
  }
  return {
    async json<T>(url: string): Promise<T> {
      for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { data: body as T, headers: new Headers() }
      }
      throw new Error(`HTTP 404 for ${url}`)
    },
    async text(url: string): Promise<string> {
      if (url.endsWith('package.json')) return '{"name":"foo"}'
      return 'export {}'
    },
    async postJson() { throw new Error('unused') },
  }
}

const identity = { ref: 'acme/foo', repo: { owner: 'acme', name: 'foo' } }

describe('collectGithub — graded revision identity (DF-4)', () => {
  it('records the tree-ref sha and the head commit sha of the branch it read', async () => {
    const snap = await collectGithub(identity, fakeHttp(), NOW)
    expect(snap.defaultBranch).toBe('main')
    expect(snap.treeRefSha).toBe(TREE_REF_SHA)
    expect(snap.headCommitSha).toBe(HEAD_SHA)
  })

  // The commit listing is fetched with since=<365 days>, so a repo dormant for
  // over a year yields []. headCommitSha must then be undefined — never null,
  // never a stand-in — while treeRefSha, which is present whenever the tree
  // fetch succeeded, still identifies the revision that was graded. That is
  // precisely why treeRefSha is captured as well as the commit: dormant,
  // abandoned servers are a large slice of trovark's corpus.
  it('an empty 365-day commit window leaves headCommitSha undefined, treeRefSha still set', async () => {
    const http = fakeHttp()
    const orig = http.jsonWithHeaders.bind(http)
    http.jsonWithHeaders = async <T,>(url: string): Promise<{ data: T; headers: Headers }> => {
      if (url.includes('/commits?since')) return { data: [] as unknown as T, headers: new Headers() }
      return orig<T>(url)
    }
    const snap = await collectGithub(identity, http, NOW)
    expect(snap.headCommitSha).toBeUndefined()
    expect(snap.treeRefSha).toBe(TREE_REF_SHA)
  })

  it('a failed tree fetch leaves treeRefSha undefined, mirroring treePaths', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) throw new Error('HTTP 500')
      return orig<T>(url)
    }
    const snap = await collectGithub(identity, http, NOW)
    expect(snap.treePaths).toBeUndefined()
    expect(snap.treeRefSha).toBeUndefined()
  })

  // A tree document without a sha (an older fixture, a proxy that strips it)
  // must leave the field absent rather than carry `undefined` through as a
  // rendered placeholder.
  it('a tree document with no sha leaves treeRefSha undefined, not fabricated', async () => {
    const http = fakeHttp()
    const orig = http.json.bind(http)
    http.json = async <T,>(url: string): Promise<T> => {
      if (url.includes('/git/trees/')) return { tree: [{ path: 'src/index.ts', type: 'blob', size: 500 }] } as T
      return orig<T>(url)
    }
    const snap = await collectGithub(identity, http, NOW)
    expect(snap.treePaths).toEqual(['src/index.ts'])
    expect(snap.treeRefSha).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// collectNpm — the published artifact's identity.
//
// collectNpm already reads dist-tags.latest to find the version document it
// takes `deprecated` and `dependencies` off. It threw the version away, so
// nothing downstream could say WHICH release the card described, nor compare
// that release against the branch the files were actually read from.
// ---------------------------------------------------------------------------

const npmHttp = (routes: Record<string, unknown>): Http => ({
  async json<T>(url: string): Promise<T> {
    for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
    throw new Error(`HTTP 404 for ${url}`)
  },
  async jsonWithHeaders() { throw new Error('unused') },
  async text() { throw new Error('unused') },
  async postJson() { throw new Error('unused') },
})

describe('collectNpm — published version and gitHead (DF-4)', () => {
  it('records the published version and the commit it was cut from', async () => {
    const r = await collectNpm('foo', npmHttp({
      'https://registry.npmjs.org/foo': {
        'dist-tags': { latest: '2.0.0' },
        versions: { '2.0.0': { gitHead: 'a40bc27ffff1111222233334444555566667777', dependencies: {} } },
      },
      'https://api.npmjs.org/downloads/point/last-week/foo': { downloads: 1 },
    }))
    expect(r.latestVersion).toBe('2.0.0')
    expect(r.publishedGitHead).toBe('a40bc27ffff1111222233334444555566667777')
  })

  // Measured across the top 40 npm "mcp server" packages: 15 publish no
  // gitHead at all — not pinnable even in principle. Absence stays undefined;
  // it is never filled in with the repository's own HEAD.
  it('a package published without gitHead leaves publishedGitHead undefined', async () => {
    const r = await collectNpm('foo', npmHttp({
      'https://registry.npmjs.org/foo': {
        'dist-tags': { latest: '2.0.0' },
        versions: { '2.0.0': { dependencies: {} } },
      },
      'https://api.npmjs.org/downloads/point/last-week/foo': { downloads: 1 },
    }))
    expect(r.latestVersion).toBe('2.0.0')
    expect(r.publishedGitHead).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// assemble — the identity threaded onto Signals as an ARTIFACT, never a signal.
// ---------------------------------------------------------------------------

function assembleFake(): Http {
  const routes: Record<string, unknown> = {
    'https://api.github.com/repos/acme/foo/commits?since': [
      { sha: HEAD_SHA, commit: { author: { date: iso(2) } }, author: { login: 'a' } },
    ],
    'https://api.github.com/repos/acme/foo/git/trees/main?recursive=1': {
      sha: TREE_REF_SHA,
      tree: [
        { path: 'package.json', type: 'blob', size: 300 },
        { path: 'src/index.ts', type: 'blob', size: 500 },
      ],
    },
    'https://api.github.com/repos/acme/foo': {
      stargazers_count: 300, archived: false, pushed_at: iso(2), default_branch: 'main',
    },
    'https://registry.npmjs.org/foo-mcp': {
      name: 'foo-mcp',
      repository: { url: 'https://github.com/acme/foo.git' },
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { gitHead: PUBLISHED_SHA, dependencies: {} } },
    },
    'https://api.npmjs.org/downloads/point/last-week/foo-mcp': { downloads: 2000 },
  }
  return {
    async json<T>(url: string): Promise<T> {
      for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
      throw new Error(`HTTP 404 for ${url}`)
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { data: body as T, headers: new Headers() }
      }
      throw new Error(`HTTP 404 for ${url}`)
    },
    async text(url: string): Promise<string> {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: {} })
      if (url.endsWith('src/index.ts')) return `server.tool('greet', 'Say hello', {}, h)`
      throw new Error(`HTTP 404 for ${url}`)
    },
    async postJson<T>(): Promise<T> { return { results: [{}] } as T },
  }
}

describe('assemble — graded revision threaded through Signals (DF-4)', () => {
  it('carries branch, head commit, tree sha, npm version and published gitHead', async () => {
    const s = await assemble(
      { ref: 'npm:foo-mcp', repo: { owner: 'acme', name: 'foo' }, npmPackage: 'foo-mcp' },
      assembleFake(), NOW,
    )
    expect(s.graded).toEqual({
      branch: 'main',
      headCommitSha: HEAD_SHA,
      treeRefSha: TREE_REF_SHA,
      npmVersion: '1.0.0',
      publishedGitHead: PUBLISHED_SHA,
    })
  })

  it('a github-only ref carries no npm fields at all — absence, not empty strings', async () => {
    const s = await assemble(identity, assembleFake(), NOW)
    expect(s.graded?.branch).toBe('main')
    expect(s.graded).not.toHaveProperty('npmVersion')
    expect(s.graded).not.toHaveProperty('publishedGitHead')
  })

  // The same mechanical guarantee tests/assemble.test.ts already enforces for
  // the D2 tool-surface artifact: the rubric must provably never read this.
  // Revision identity describes WHAT was graded; it must never move the score.
  it('the rubric provably never reads Signals.graded (artifact-only guarantee)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/scoring/rubric.ts', 'utf8')
    expect(/\bs\.graded\b|\bsignals\.graded\b/.test(src)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// score — the divergence note.
//
// An `npm:` ref is graded at the repository's DEFAULT BRANCH, not at the
// commit the published tarball was cut from. Measured on the top 40 npm "mcp
// server" packages: of the 21 with a comparable gitHead, 15 (71%) had moved on
// — median ~7 commits, up to 744 (@storybook/mcp) and 59 with 128 files
// changed (chrome-devtools-mcp). Nothing on the card said so, so a user
// vetting a package before install read a grade of the maintainer's working
// branch: the one artifact they are specifically not going to run.
// ---------------------------------------------------------------------------

const healthy = (): Signals => ({
  daysSinceLastCommit: 3, daysSinceLastRelease: 20, commitsLast90Days: 40,
  busFactor: 6, medianIssueResponseDays: 1, stars: 5000, weeklyDownloads: 50000,
  archived: false, specEra: 'modern', hasCI: true, hasTests: true, hasLockfile: true,
  schemaExtracted: true, toolSurfaceRisk: 'none', secretsFound: 0, cveWorst: 'none',
  schemaTokenEstimate: 1500, toolCount: 6, findings: [], errors: [],
})

describe('score — graded-revision divergence note (DF-4)', () => {
  const withGraded = (graded: NonNullable<Signals['graded']>): Signals => ({ ...healthy(), graded })
  const resolved = { npmPackage: 'foo-mcp', repo: { owner: 'acme', name: 'foo' } }

  it('fires when the published gitHead differs from the graded head commit', () => {
    const card = score('npm:foo-mcp', withGraded({
      branch: 'main', headCommitSha: 'abcdef1234567890', npmVersion: '1.2.3',
      publishedGitHead: '9876543210fedcba',
    }), '2026-09-22T00:00:00Z', resolved)
    const note = card.notes.find(n => n.includes('not the published'))
    expect(note).toBeDefined()
    expect(note).toContain('main@abcdef1')
    expect(note).toContain('foo-mcp@1.2.3')
    expect(note).toContain('9876543')
  })

  // Scope, not an alarm. Divergence is a fact about what was read, not a
  // finding against the server — it must not touch the score or the grade.
  it('is scope, not a finding: no score, grade or finding moves', () => {
    const graded = {
      branch: 'main', headCommitSha: 'abcdef1234567890', npmVersion: '1.2.3',
      publishedGitHead: '9876543210fedcba',
    }
    const plain = score('npm:foo-mcp', healthy(), '2026-09-22T00:00:00Z', resolved)
    const flagged = score('npm:foo-mcp', withGraded(graded), '2026-09-22T00:00:00Z', resolved)
    expect(flagged.overall).toBe(plain.overall)
    expect(flagged.grade).toBe(plain.grade)
    expect(flagged.dimensions).toEqual(plain.dimensions)
    expect(flagged.notes.length).toBe(plain.notes.length + 1)
  })

  it('stays silent when the release and the branch are the same commit', () => {
    const card = score('npm:foo-mcp', withGraded({
      branch: 'main', headCommitSha: 'abcdef1234567890', npmVersion: '1.2.3',
      publishedGitHead: 'abcdef1234567890',
    }), '2026-09-22T00:00:00Z', resolved)
    expect(card.notes.some(n => n.includes('not the published'))).toBe(false)
  })

  // Inventing a divergence claim out of a missing field would be the same
  // fabrication the coverage gate exists to prevent. The resolved: line
  // already states which branch and sha were read.
  it('stays silent when the package publishes no gitHead', () => {
    const card = score('npm:foo-mcp', withGraded({
      branch: 'main', headCommitSha: 'abcdef1234567890', npmVersion: '1.2.3',
    }), '2026-09-22T00:00:00Z', resolved)
    expect(card.notes.some(n => n.includes('not the published'))).toBe(false)
  })

  it('stays silent when the head commit is unknown — a dormant repo, empty commit window', () => {
    const card = score('npm:foo-mcp', withGraded({
      branch: 'main', treeRefSha: 'ffff0000', npmVersion: '1.2.3', publishedGitHead: '9876543210fedcba',
    }), '2026-09-22T00:00:00Z', resolved)
    expect(card.notes.some(n => n.includes('not the published'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// renderTerminal — the header. Appended to the existing `resolved:` line, never
// reordered: tests/cli.test.ts asserts `toContain('resolved: github.com/acme/foo')`.
// ---------------------------------------------------------------------------

const baseCard: Scorecard = {
  ref: 'acme/foo', rubricVersion: '1.0.0', overall: 78, grade: 'B+',
  dimensions: [{ id: 'health', score: 86, confidence: 'high', available: 7, total: 7, findings: [] }],
  notes: [], generatedAt: '2026-09-22T00:00:00Z', insufficientData: false,
}

describe('renderTerminal — graded revision in the header (DF-4)', () => {
  it('names the published npm version and the revision that was read', () => {
    const out = renderTerminal({
      ...baseCard,
      resolved: {
        npmPackage: 'loreweave', npmVersion: '0.37.2',
        repo: { owner: 'x', name: 'y' },
        branch: 'main', commit: 'ba770d5aaaa1111222233334444555566667777',
        treeRefSha: 'tttt111122223333444455556666777788889999',
      },
    }, { color: false })
    expect(out).toContain('npm:loreweave@0.37.2')
    expect(out).toContain('github.com/x/y')
    expect(out).toContain('graded at main@ba770d5')
  })

  it('falls back to the tree-ref sha, labelled as a tree ref, when the commit is unknown', () => {
    const out = renderTerminal({
      ...baseCard,
      resolved: { repo: { owner: 'x', name: 'y' }, branch: 'trunk', treeRefSha: 'abcdef1234567890' },
    }, { color: false })
    expect(out).toContain('graded at trunk (tree ref abcdef1)')
  })

  // Absence must render as absence. A `graded at main@undefined` in a header
  // would be a worse bug than the one this fixes.
  it('renders the old header unchanged when no revision was collected', () => {
    const out = renderTerminal({ ...baseCard, resolved: { repo: { owner: 'acme', name: 'foo' } } }, { color: false })
    expect(out).toContain('resolved: github.com/acme/foo')
    expect(out).not.toContain('graded at')
    expect(out).not.toContain('undefined')
  })
})

// ---------------------------------------------------------------------------
// cli --json — the machine-readable end of the same fact.
// ---------------------------------------------------------------------------

describe('cli — resolved carries the graded revision (DF-4)', () => {
  const run = async (argv: string[]) => {
    const logs: string[] = [], errs: string[] = []
    const code = await main(argv, { http: assembleFake(), now: NOW, log: s => logs.push(s), err: s => errs.push(s) })
    return { code, out: logs.join('\n'), err: errs.join('\n') }
  }

  it('--json on a github ref carries branch, commit and tree sha', async () => {
    const r = await run(['acme/foo', '--json'])
    const card = JSON.parse(r.out)
    expect(card.resolved.branch).toBe('main')
    expect(card.resolved.commit).toBe(HEAD_SHA)
    expect(card.resolved.treeRefSha).toBe(TREE_REF_SHA)
  })

  it('--json on an npm ref carries the published version alongside the graded revision', async () => {
    const r = await run(['npm:foo-mcp', '--json'])
    const card = JSON.parse(r.out)
    expect(card.resolved.npmPackage).toBe('foo-mcp')
    expect(card.resolved.npmVersion).toBe('1.0.0')
    expect(card.resolved.commit).toBe(HEAD_SHA)
  })

  it('an npm ref graded at a branch that has moved past the release says so in the notes', async () => {
    const r = await run(['npm:foo-mcp'])
    expect(r.out).toMatch(/not the published foo-mcp@1\.0\.0/)
  })
})
