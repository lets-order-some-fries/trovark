import type { RepoFile } from '../collectors/github.js'
import type { Dep } from '../collectors/osv.js'

// Committed lockfiles pin EXACT resolved versions (including transitive deps),
// unlike a manifest's semver range floor. Querying OSV at the floor
// over-reports CVEs already patched within the declared range and misses
// transitive deps entirely — parsing the lockfile fixes both. Pure function:
// malformed/unexpected content degrades to "no deps found" rather than
// throwing, matching the "absence lowers confidence, never fakes a value"
// constraint.

/**
 * npm `package-lock.json` v2/v3 `packages` map: each key is a path like
 * `node_modules/<name>` (or nested `node_modules/x/node_modules/y` for
 * transitive deps, including scoped names like `node_modules/@scope/pkg`).
 * The package name is the LAST `node_modules/` segment; `.version` is the
 * exact resolved version. The root project is keyed `""` and is skipped.
 */
function parsePackageLockJson(content: string): { deps: Dep[]; recognized: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { deps: [], recognized: false }
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages
  // No `packages` map means this is not a v2/v3 lockfile (a v1 keys its tree
  // off `dependencies`, which this parser does not read). DF-1 round 4: that
  // has to stay UNRECOGNIZED rather than "recognized, zero deps" — otherwise a
  // format we simply cannot read would publish as a clean dependency result.
  if (packages === null || typeof packages !== 'object') return { deps: [], recognized: false }

  const deps: Dep[] = []
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    if (key === '') continue // root project entry, not a dependency
    // npm workspaces key each member's own root by its repo-relative path
    // (e.g. "packages/api", "apps/x") with no "node_modules/" segment — that's
    // the workspace's own source, not an installed dependency. Sending its
    // path as a "package name" to OSV is bogus; skip anything that isn't
    // actually under node_modules/.
    if (!key.includes('node_modules/')) continue
    // DF-1 (2026-09-22): `dev: true` marks an entry that only a `npm install`
    // of the repo itself pulls in (vitest, esbuild, tsx...) — nobody who
    // installs the package receives it. The manifest path already scopes
    // OSV to the registry's runtime `dependencies`; the lockfile path must
    // not widen that into accusing a server of shipping its own test
    // runner's CVEs. Measured on loreweave: 302 entries, 161 dev-only, and
    // 4 of the first 8 lockfile-resolved findings were against dev-only
    // packages. `optional` and `peer` entries stay: they can be installed.
    if ((value as { dev?: unknown } | null)?.dev === true) continue
    const version = (value as { version?: unknown } | null)?.version
    if (typeof version !== 'string' || version === '') continue
    const segments = key.split('node_modules/')
    const name = segments[segments.length - 1]
    if (!name) continue
    deps.push({ name, version, ecosystem: 'npm' })
  }
  return { deps, recognized: true }
}

/**
 * `uv.lock` / `poetry.lock` (Python, TOML): a sequence of `[[package]]`
 * blocks each carrying `name = "..."` and `version = "..."`. Avoids a real
 * TOML parser (no new runtime deps) by splitting on the `[[package]]` table
 * marker and regex-extracting the two fields from each resulting chunk.
 */
function parseTomlPackages(content: string): { deps: Dep[]; recognized: boolean } {
  const deps: Dep[] = []
  try {
    const blocks = content.split(/(?=^\[\[package\]\])/m)
    for (const block of blocks) {
      const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)
      const versionMatch = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)
      if (nameMatch && versionMatch) {
        deps.push({ name: nameMatch[1], version: versionMatch[1], ecosystem: 'PyPI' })
      }
    }
  } catch {
    return { deps: [], recognized: false }
  }
  // DF-1 round 4: no `[[package]]` block parsed means nothing here was
  // recognizably a uv/poetry lock — declining is the honest answer. Unlike
  // package-lock.json there is no dev flag in either format, so a Python lock
  // this parser CAN read can only ever be emptied by having no packages.
  return { deps, recognized: deps.length > 0 }
}

function dedupe(deps: Dep[]): Dep[] {
  const seen = new Set<string>()
  const out: Dep[] = []
  for (const d of deps) {
    const key = `${d.ecosystem}:${d.name}@${d.version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

export interface LockfileScan {
  /** Exact resolved runtime deps, deduped, across every lockfile read. */
  deps: Dep[]
  /**
   * Ecosystems for which a lockfile was actually READ AND UNDERSTOOD — which
   * is NOT the same as `deps`' ecosystems.
   *
   * DF-1 round 4 (census defect 1). The dev-skip above can empty a
   * package-lock.json completely: `seleniumboot/selenium-mcp` and
   * `agentbodegastore/agentbodega` both commit locks whose every entry is
   * `dev: true`. Callers that inferred "a lockfile was read" from
   * `deps.length > 0` could not tell that from "no lockfile exists", so the
   * dependency-CVE check silently disappeared and selenium-mcp lost 5 points
   * for it. A lockfile that declares no runtime dependencies is a
   * MEASUREMENT — the package ships nothing that can carry a dependency CVE —
   * and this field is what lets assemble() say so. An unparseable or
   * unsupported lockfile is deliberately absent here, so it degrades to "no
   * lockfile read" instead of to a false clean bill.
   */
  ecosystems: Array<Dep['ecosystem']>
}

/** Reads any committed lockfiles in `files`: their resolved deps, and which ecosystems were understood. */
export function scanLockfiles(files: RepoFile[]): LockfileScan {
  const deps: Dep[] = []
  const ecosystems = new Set<Dep['ecosystem']>()
  for (const file of files) {
    const base = file.path.split('/').pop() ?? file.path
    try {
      if (base === 'package-lock.json') {
        const r = parsePackageLockJson(file.content)
        deps.push(...r.deps)
        if (r.recognized) ecosystems.add('npm')
      } else if (base === 'uv.lock' || base === 'poetry.lock') {
        const r = parseTomlPackages(file.content)
        deps.push(...r.deps)
        if (r.recognized) ecosystems.add('PyPI')
      }
    } catch {
      // never throw on malformed lockfile content — just contributes nothing
    }
  }
  return { deps: dedupe(deps), ecosystems: [...ecosystems] }
}

/** Parses any committed lockfiles found in `files` into exact resolved deps (deduped). */
export function parseLockfile(files: RepoFile[]): Dep[] {
  return scanLockfiles(files).deps
}
