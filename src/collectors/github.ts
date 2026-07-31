import type { Http } from '../util/http.js'
import type { ServerIdentity } from '../resolver.js'

export interface RepoFile { path: string; content: string }

export interface RepoSnapshot {
  owner: string; name: string; defaultBranch: string
  stars: number; archived: boolean
  pushedAt: string
  latestReleaseAt?: string
  commitsLast90Days: number
  busFactor: number
  medianIssueResponseDays?: number
  treePaths: string[]
  files: RepoFile[]
}

const FILE_CAP = 12
const SIZE_CAP = 100_000
const ALWAYS_FETCH = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'mcp.json', 'server.json', 'smithery.yaml',
])
const SOURCE_HINT = /(src\/|server|tool|index|main)/
const SOURCE_EXT = /\.(ts|js|mjs|py)$/

interface GhCommit { commit: { author?: { date?: string } }; author?: { login?: string } | null }

export async function collectGithub(
  identity: ServerIdentity, http: Http, now: Date, opts: { hasToken?: boolean } = {},
): Promise<RepoSnapshot> {
  if (!identity.repo) throw new Error(`No GitHub repo known for "${identity.ref}"`)
  const { owner, name } = identity.repo
  const api = `https://api.github.com/repos/${owner}/${name}`

  interface GhRepo { stargazers_count: number; archived: boolean; pushed_at: string; default_branch: string }
  const meta = await http.json<GhRepo>(api)

  const since365 = new Date(now.getTime() - 365 * 86_400_000).toISOString()
  const commits = await http.json<GhCommit[]>(`${api}/commits?since=${since365}&per_page=100`).catch(() => [])
  const cutoff90 = now.getTime() - 90 * 86_400_000
  const commitsLast90Days = commits.filter(c => {
    const d = c.commit.author?.date
    return d !== undefined && new Date(d).getTime() >= cutoff90
  }).length
  const byAuthor = new Map<string, number>()
  for (const c of commits) {
    const login = c.author?.login
    if (login) byAuthor.set(login, (byAuthor.get(login) ?? 0) + 1)
  }
  const busFactor = [...byAuthor.values()].filter(n => n >= 3).length

  const latestReleaseAt = await http
    .json<{ published_at?: string }>(`${api}/releases/latest`)
    .then(r => r.published_at)
    .catch(() => undefined)

  // Issue responsiveness needs per-issue comment fetches — only with a token, cap 10 issues.
  let medianIssueResponseDays: number | undefined
  if (opts.hasToken) {
    try {
      interface GhIssue { number: number; comments: number; created_at: string; pull_request?: unknown }
      const issues = (await http.json<GhIssue[]>(`${api}/issues?state=all&sort=created&direction=desc&per_page=30`))
        .filter(i => !i.pull_request && i.comments > 0)
        .slice(0, 10)
      const deltas: number[] = []
      for (const i of issues) {
        const [first] = await http.json<Array<{ created_at: string }>>(
          `${api}/issues/${i.number}/comments?per_page=1`,
        )
        if (first) deltas.push((new Date(first.created_at).getTime() - new Date(i.created_at).getTime()) / 86_400_000)
      }
      if (deltas.length > 0) {
        deltas.sort((a, b) => a - b)
        medianIssueResponseDays = deltas[Math.floor(deltas.length / 2)]
      }
    } catch { /* leave undefined */ }
  }

  interface GhTree { tree: Array<{ path: string; type: string; size?: number }> }
  const tree = await http
    .json<GhTree>(`${api}/git/trees/${meta.default_branch}?recursive=1`)
    .catch(() => ({ tree: [] as GhTree['tree'] }))
  const blobs = tree.tree.filter(t => t.type === 'blob')
  const treePaths = blobs.map(b => b.path)

  const fetchable = (p: { path: string; size?: number }) => (p.size ?? 0) <= SIZE_CAP
  const wanted = [
    ...blobs.filter(b => fetchable(b) && (ALWAYS_FETCH.has(b.path) || /(^|\/)\.env[^/]*$/.test(b.path))),
    ...blobs
      .filter(b => fetchable(b) && SOURCE_EXT.test(b.path) && SOURCE_HINT.test(b.path))
      .sort((a, b) => a.path.length - b.path.length),
  ]
  const seen = new Set<string>()
  const files: RepoFile[] = []
  for (const b of wanted) {
    if (files.length >= FILE_CAP) break
    if (seen.has(b.path)) continue
    seen.add(b.path)
    try {
      const content = await http.text(
        `https://raw.githubusercontent.com/${owner}/${name}/${meta.default_branch}/${b.path}`,
      )
      files.push({ path: b.path, content })
    } catch { /* skip unfetchable file */ }
  }

  return {
    owner, name, defaultBranch: meta.default_branch,
    stars: meta.stargazers_count, archived: meta.archived, pushedAt: meta.pushed_at,
    latestReleaseAt, commitsLast90Days, busFactor, medianIssueResponseDays,
    treePaths, files,
  }
}
