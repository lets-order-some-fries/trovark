import type { Http } from '../util/http.js'
import type { ServerIdentity } from '../resolver.js'

export interface RepoFile { path: string; content: string }

export interface RepoSnapshot {
  owner: string; name: string; defaultBranch: string
  stars: number; archived: boolean
  pushedAt: string
  latestReleaseAt?: string
  commitsLast90Days?: number
  busFactor?: number
  medianIssueResponseDays?: number
  treePaths?: string[]
  files: RepoFile[]
}

const FILE_CAP = 12
const SIZE_CAP = 100_000
const ALWAYS_FETCH = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'mcp.json', 'server.json', 'smithery.yaml',
  'go.mod', 'Cargo.toml', 'build.gradle', 'build.gradle.kts', 'pom.xml',
])
const SOURCE_HINT = /(src\/|server|tool|index|main)/
const SOURCE_EXT = /\.(ts|js|mjs|py)$/
// Fix 7 (tool-signal ranking): among source candidates that already passed
// SOURCE_HINT, prefer paths that look like a tool-registration/entry-point
// file over merely-short ones — deep one-tool-per-file layouts (tools/x.ts)
// were previously starved by short unrelated files (util/log.ts) under pure
// shortest-path sort, silently undercounting tools. No extra fetches — path
// hint only; FILE_CAP stays unchanged (minimal version of audit item 11).
const TOOL_SIGNAL_HINT = /(^|\/)(tools?|server|index|main)(\.|\/|$)/i
const toolSignalScore = (path: string): number => (TOOL_SIGNAL_HINT.test(path) ? 1 : 0)

interface GhCommit { commit: { author?: { date?: string } }; author?: { login?: string } | null }

const COMMIT_PAGE_CAP = 10 // safety net against runaway pagination on huge repos

/** Parses the `Link` response header for a `rel="next"` target URL (RFC 8288 / GitHub pagination). */
function parseNextLink(headers: Headers): string | undefined {
  const link = headers.get('link')
  if (!link) return undefined
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (m) return m[1]
  }
  return undefined
}

export async function collectGithub(
  identity: ServerIdentity, http: Http, now: Date, opts: { hasToken?: boolean } = {},
): Promise<RepoSnapshot> {
  if (!identity.repo) throw new Error(`No GitHub repo known for "${identity.ref}"`)
  const { owner, name } = identity.repo
  const api = `https://api.github.com/repos/${owner}/${name}`

  interface GhRepo { stargazers_count: number; archived: boolean; pushed_at: string; default_branch: string }
  const meta = await http.json<GhRepo>(api)

  const since365 = new Date(now.getTime() - 365 * 86_400_000).toISOString()
  const cutoff365Ms = now.getTime() - 365 * 86_400_000
  // Paginate the FULL 365-day commit window: a single 100-commit page on an
  // active repo can span only weeks, truncating the intended window and
  // undercounting bus factor / recent activity. Follow `Link: rel="next"`
  // until a page's oldest commit is already past the cutoff, or the page cap
  // is hit (huge-repo safety net) — whichever comes first. Deliberately NOT
  // using /contributors (all-time totals, wrong window) or /stats/contributors
  // (202 async placeholder that requires polling and isn't guaranteed fresh).
  // Fetch failure → undefined signals (absence ≠ zero); an infra hiccup must not read as a dead repo.
  let commits: GhCommit[] | undefined
  try {
    const acc: GhCommit[] = []
    let url: string | undefined = `${api}/commits?since=${since365}&per_page=100`
    for (let page = 0; page < COMMIT_PAGE_CAP && url; page++) {
      const { data, headers } = await http.jsonWithHeaders<GhCommit[]>(url)
      acc.push(...data)
      const oldestOnPage = data[data.length - 1]?.commit.author?.date
      if (oldestOnPage !== undefined && new Date(oldestOnPage).getTime() < cutoff365Ms) break
      url = parseNextLink(headers)
    }
    commits = acc
  } catch {
    commits = undefined
  }
  const cutoff90 = now.getTime() - 90 * 86_400_000
  const commitsLast90Days = commits?.filter(c => {
    const d = c.commit.author?.date
    return d !== undefined && new Date(d).getTime() >= cutoff90
  }).length
  let busFactor: number | undefined
  if (commits) {
    const byAuthor = new Map<string, number>()
    for (const c of commits) {
      const login = c.author?.login
      if (login) byAuthor.set(login, (byAuthor.get(login) ?? 0) + 1)
    }
    busFactor = [...byAuthor.values()].filter(n => n >= 3).length
  }

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
        const n = deltas.length
        medianIssueResponseDays = n % 2
          ? deltas[(n - 1) / 2]
          : (deltas[n / 2 - 1] + deltas[n / 2]) / 2
      }
    } catch { /* leave undefined */ }
  }

  interface GhTree { tree: Array<{ path: string; type: string; size?: number }> }
  const tree = await http
    .json<GhTree>(`${api}/git/trees/${meta.default_branch}?recursive=1`)
    .catch(() => undefined)
  const blobs = tree?.tree.filter(t => t.type === 'blob') ?? []
  const treePaths = tree ? blobs.map(b => b.path) : undefined

  const fetchable = (p: { path: string; size?: number }) => (p.size ?? 0) <= SIZE_CAP
  // Basename match (not full-path) so workspace/monorepo manifests nested under
  // e.g. packages/x/package.json are still always-fetched, not just root ones.
  // .csproj filenames vary (MyServer.csproj), so basename-Set membership can't
  // catch them — fall back to an extension check for that ecosystem.
  // Manifests are listed ahead of source below and FILE_CAP is unchanged, so
  // they win budget naturally; at the current cap this is fine, but a repo with
  // many nested manifests could start crowding out source files — revisit if
  // that shows up (tracked for P4).
  const isManifest = (p: string) => ALWAYS_FETCH.has(p.split('/').pop() ?? '') || p.endsWith('.csproj')
  const wanted = [
    ...blobs.filter(b => fetchable(b) && (isManifest(b.path) || /(^|\/)\.env[^/]*$/.test(b.path))),
    ...blobs
      .filter(b => fetchable(b) && SOURCE_EXT.test(b.path) && SOURCE_HINT.test(b.path))
      .sort((a, b) => toolSignalScore(b.path) - toolSignalScore(a.path) || a.path.length - b.path.length),
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
