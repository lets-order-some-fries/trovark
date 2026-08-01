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
function parsePackageLockJson(content: string): Dep[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages
  if (packages === null || typeof packages !== 'object') return []

  const deps: Dep[] = []
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    if (key === '') continue // root project entry, not a dependency
    // npm workspaces key each member's own root by its repo-relative path
    // (e.g. "packages/api", "apps/x") with no "node_modules/" segment — that's
    // the workspace's own source, not an installed dependency. Sending its
    // path as a "package name" to OSV is bogus; skip anything that isn't
    // actually under node_modules/.
    if (!key.includes('node_modules/')) continue
    const version = (value as { version?: unknown } | null)?.version
    if (typeof version !== 'string' || version === '') continue
    const segments = key.split('node_modules/')
    const name = segments[segments.length - 1]
    if (!name) continue
    deps.push({ name, version, ecosystem: 'npm' })
  }
  return deps
}

/**
 * `uv.lock` / `poetry.lock` (Python, TOML): a sequence of `[[package]]`
 * blocks each carrying `name = "..."` and `version = "..."`. Avoids a real
 * TOML parser (no new runtime deps) by splitting on the `[[package]]` table
 * marker and regex-extracting the two fields from each resulting chunk.
 */
function parseTomlPackages(content: string): Dep[] {
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
    return []
  }
  return deps
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

/** Parses any committed lockfiles found in `files` into exact resolved deps (deduped). */
export function parseLockfile(files: RepoFile[]): Dep[] {
  const deps: Dep[] = []
  for (const file of files) {
    const base = file.path.split('/').pop() ?? file.path
    try {
      if (base === 'package-lock.json') {
        deps.push(...parsePackageLockJson(file.content))
      } else if (base === 'uv.lock' || base === 'poetry.lock') {
        deps.push(...parseTomlPackages(file.content))
      }
    } catch {
      // never throw on malformed lockfile content — just contributes nothing
    }
  }
  return dedupe(deps)
}
