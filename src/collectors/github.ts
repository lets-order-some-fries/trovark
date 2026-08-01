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

// v1.3 (V1 — monorepo sampling overhaul, coverage-spec §3.3 + §4): FILE_CAP is
// no longer a fixed constant. Manifest-heavy / workspace monorepos (context7,
// cloudflare, awslabs, metatool) were starving tool source before it was ever
// reached — see the dynamic-budget block inside collectGithub below.
const SIZE_CAP = 300_000 // raised 100_000→300_000 (V1 change 5); firecrawl's 104KB src/index.ts was skipped entirely at the old cap.
// PRIMARY manifests: spec-era detection + secrets-relevant, always worth a
// budget slot ahead of source. Deliberately excludes lockfiles — see
// LOCKFILES below and the final-review fix note on `wanted`.
const ALWAYS_FETCH = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'mcp.json', 'server.json', 'smithery.yaml',
  'go.mod', 'Cargo.toml', 'build.gradle', 'build.gradle.kts', 'pom.xml',
])
// V1 change 2 (isManifest tightening): mcp.json/server.json are only real
// manifests at the repo ROOT — nested copies under editor config dirs
// (.cursor/mcp.json, .vscode/mcp.json) are IDE settings, not server specs,
// and were false-positive "manifests" crowding out source (sentry). Other
// manifest kinds (package.json, go.mod, Cargo.toml, pyproject.toml, .csproj)
// are legitimately nested in workspace/multi-module repos, so they keep the
// basename-anywhere match.
const ROOT_ONLY_MANIFEST = new Set(['mcp.json', 'server.json'])
const EXCLUDED_MANIFEST_PATH_RE = /(^|\/)(\.cursor|\.vscode)\//
const EXCLUDED_MANIFEST_DATA_DIR_RE = /(^|\/)data\//
// Fix (final review): committed lockfiles let assemble() query OSV at exact
// resolved versions (incl. transitive deps) instead of manifest-range floors
// (see P7 / src/derive/lockfile.ts) — but they are DATA that only feeds CVE
// lookup, never tool extraction. The previous single ALWAYS_FETCH bucket put
// lockfiles in the SAME first-priority tier as source-critical manifests, so
// under FILE_CAP=12 a repo with a big lockfile plus many source files could
// have the lockfile crowd out source needed for the gate (tool extraction).
// Lockfiles now rank in their own LAST bucket — fetched only if budget
// remains after PRIMARY manifests and SOURCE files. SIZE_CAP below still
// skips oversized blobs either way.
const LOCKFILES = new Set(['package-lock.json', 'uv.lock', 'poetry.lock'])
const SOURCE_HINT = /(src\/|server|tool|index|main)/
// V1 change 1: adds go/rs/java/cs/kt so wave-1/2 language extractors (V3+)
// actually get source to parse. Fetching them now is harmless even before
// their extractors are wired.
const SOURCE_EXT = /\.(ts|js|mjs|py|go|rs|java|cs|kt)$/
// V1 change 5 (entrypoint size relaxation): a single-file entrypoint
// (server/index/main.<ext>) that exceeds SIZE_CAP is fetched-and-truncated
// rather than skipped outright — the alternative is losing the ENTIRE tool
// surface of a monolithic-entrypoint server. Non-entrypoint oversized blobs
// are still skipped by the plain size check.
const ENTRYPOINT_RE = /(server|index|main)\.(ts|js|mjs|py|go)$/
const isEntrypointPath = (path: string): boolean => ENTRYPOINT_RE.test(path)
// V1 change 6: local, github.ts-scoped copy of the non-server-path notion
// used by src/derive/schema.ts's classifier (kept separate — collectors must
// not import from derive/ — see the module-boundary note above the fetch
// loop). Extended with 'samples' per coverage-spec §3.1/§4 (csharp-sdk
// samples/** should read the same as examples/** for ranking purposes).
const NON_SERVER_DIR_RE = /(^|\/)(tests|__tests__|examples|docs|docs_src|samples)\//
const NON_SERVER_FILE_RE = /(?:^|\/)[^/]*(?:_test\.[^/]+|\.test\.[^/]+)$/
const isNonServerPath = (path: string): boolean => NON_SERVER_DIR_RE.test(path) || NON_SERVER_FILE_RE.test(path)
// V1 change 4: replaces the old shortest-path tie-break with a tool-signal
// score (coverage-spec §3.3c) — deep one-tool-per-file / tools-registry
// layouts were losing to shorter, unrelated files (or to a generic
// `index.ts`) purely on path length. `pkgName` is resolved from the ROOT
// package.json only (not every nested workspace member's package.json) —
// deep per-package name resolution would require fetching every nested
// package.json purely for ranking before we know which ones survive the
// budget, which is a real cost for a marginal signal; the common case (a
// single-package repo, or the root package IS the `-mcp` package, e.g.
// `@upstash/context7-mcp`) is still covered.
const TOOLS_DIR_RE = /(^|\/)tools?\//
const DOT_TOOLS_TS_RE = /\.tools\.ts$/
const TOOL_REGISTRY_RE = /(tools?-registry|admin-mcp|toolDefinitions)/i
const MCP_DIR_RE = /\/mcp\//
function toolSignalScore(path: string, pkgName: string | undefined): number {
  let s = 0
  if (TOOLS_DIR_RE.test(path)) s += 5
  if (DOT_TOOLS_TS_RE.test(path)) s += 5
  if (TOOL_REGISTRY_RE.test(path)) s += 6
  if (MCP_DIR_RE.test(path) || /-mcp$/.test(pkgName ?? '')) s += 4
  if (isEntrypointPath(path)) s += 2
  if (isNonServerPath(path)) s -= 10
  return s
}
// V1 change 3: manifest selection priority — root (fewest path segments)
// first, then shallower nested manifests before deeper ones. Ties broken by
// path length. Used both to pick the MANIFEST_QUOTA-preferred set and, in
// reverse, as the eviction order (deepest/lowest-priority evicted first).
function manifestPriority(path: string): [number, number] {
  return [path.split('/').length, path.length]
}

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

  // V1 change 5: entrypoints are fetchable even past SIZE_CAP — fetched then
  // truncated below, rather than skipped outright.
  const fetchable = (p: { path: string; size?: number }) => (p.size ?? 0) <= SIZE_CAP || isEntrypointPath(p.path)
  // Basename match (not full-path) so workspace/monorepo manifests nested under
  // e.g. packages/x/package.json are still always-fetched, not just root ones.
  // .csproj filenames vary (MyServer.csproj), so basename-Set membership can't
  // catch them — fall back to an extension check for that ecosystem.
  // V1 change 2: mcp.json/server.json are root-only; .cursor/, .vscode/, and
  // any **/data/** path are never manifests regardless of basename (kills
  // .cursor/mcp.json / .vscode/mcp.json editor-config false positives).
  const isManifest = (p: string): boolean => {
    if (EXCLUDED_MANIFEST_PATH_RE.test(p) || EXCLUDED_MANIFEST_DATA_DIR_RE.test(p)) return false
    const base = p.split('/').pop() ?? ''
    if (!ALWAYS_FETCH.has(base) && !p.endsWith('.csproj')) return false
    if (ROOT_ONLY_MANIFEST.has(base)) return p === base
    return true
  }
  const isLockfile = (p: string) => LOCKFILES.has(p.split('/').pop() ?? '')
  const rawUrl = (p: string) => `https://raw.githubusercontent.com/${owner}/${name}/${meta.default_branch}/${p}`

  // V1 change 3 (dynamic budget, coverage-spec §3.3b): a fixed FILE_CAP=12 let
  // 7-26 manifest files (context7, cloudflare, awslabs, metatool) eat the
  // entire budget before any tool source was reached. Manifest candidates are
  // computed FIRST (path-only, no fetch needed) so the cap can react to repo
  // shape; the root package.json is then fetched once, both to detect
  // `workspaces` (npm/yarn monorepo signal) and to resolve the root package
  // name for the `-mcp` toolSignalScore bonus. That single fetch is cached and
  // reused by the main loop below — never fetched twice.
  const manifestCandidates = blobs
    .filter(b => fetchable(b) && isManifest(b.path))
    .sort((a, b) => {
      const [da, la] = manifestPriority(a.path)
      const [db, lb] = manifestPriority(b.path)
      return da - db || la - lb
    })
  const manifestCount = manifestCandidates.length

  let hasWorkspaces = false
  let rootPkgName: string | undefined
  let rootPkgContent: string | undefined
  const rootPkgBlob = blobs.find(b => b.path === 'package.json' && fetchable(b))
  if (rootPkgBlob) {
    try {
      rootPkgContent = await http.text(rawUrl('package.json'))
      const parsed = JSON.parse(rootPkgContent) as { name?: string; workspaces?: unknown }
      rootPkgName = parsed.name
      hasWorkspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces.length > 0 : Boolean(parsed.workspaces)
    } catch { /* malformed/unfetchable root package.json — treat as no signal */ }
  }

  const FILE_CAP = (manifestCount > 3 || hasWorkspaces) ? 24 : 12
  const MANIFEST_QUOTA = Math.min(manifestCount, 3) // root + 2, per coverage-spec §3.3b
  const SOURCE_FLOOR = Math.ceil(FILE_CAP * 0.66)

  const envBlobs = blobs.filter(b => fetchable(b) && /(^|\/)\.env[^/]*$/.test(b.path))
  // V1 change 4: tool-signal score replaces the old shortest-path tie-break.
  const rankedSource = blobs
    .filter(b => fetchable(b) && SOURCE_EXT.test(b.path) && SOURCE_HINT.test(b.path))
    .sort((a, b) => toolSignalScore(b.path, rootPkgName) - toolSignalScore(a.path, rootPkgName) || a.path.length - b.path.length)

  // Manifests start at full candidate strength (not pre-capped to
  // MANIFEST_QUOTA) — most repos have few enough manifests that no eviction is
  // ever needed, and pre-capping would needlessly drop legitimate nested
  // manifests (go.mod, .csproj, per-workspace package.json) in small repos
  // that were never actually starving source. Eviction only kicks in — lowest
  // priority (deepest/longest path) first — when the ranked-source budget
  // would otherwise fall below SOURCE_FLOOR, and never below MANIFEST_QUOTA.
  let manifestsSelected = manifestCandidates
  const sourceTarget = Math.min(SOURCE_FLOOR, rankedSource.length)
  const availableSourceSlots = () => Math.max(0, FILE_CAP - envBlobs.length - manifestsSelected.length)
  while (availableSourceSlots() < sourceTarget && manifestsSelected.length > MANIFEST_QUOTA) {
    manifestsSelected = manifestsSelected.slice(0, -1)
  }

  // Fix (final review): three priority buckets, in order — (1) PRIMARY
  // manifests + .env matches, (2) ranked SOURCE files, (3) LOCKFILES last —
  // so lockfiles (CVE-lookup data only) never outrank source (needed for tool
  // extraction → gate) under a tight FILE_CAP.
  const wanted = [
    ...envBlobs,
    ...manifestsSelected,
    ...rankedSource,
    ...blobs.filter(b => fetchable(b) && isLockfile(b.path)),
  ]
  const seen = new Set<string>()
  const files: RepoFile[] = []
  for (const b of wanted) {
    if (files.length >= FILE_CAP) break
    if (seen.has(b.path)) continue
    seen.add(b.path)
    try {
      const content = b.path === 'package.json' && rootPkgContent !== undefined
        ? rootPkgContent
        : await http.text(rawUrl(b.path))
      files.push({ path: b.path, content: content.length > SIZE_CAP ? content.slice(0, SIZE_CAP) : content })
    } catch { /* skip unfetchable file */ }
  }

  return {
    owner, name, defaultBranch: meta.default_branch,
    stars: meta.stargazers_count, archived: meta.archived, pushedAt: meta.pushed_at,
    latestReleaseAt, commitsLast90Days, busFactor, medianIssueResponseDays,
    treePaths, files,
  }
}
