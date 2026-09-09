const CI = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^\.travis\.yml$/]
const TESTS = [/(^|\/)(tests?|__tests__|spec)(\/|$)/, /\.(test|spec)\.[jt]sx?$/, /_test\.py$/, /^test_.*\.py$/, /\/test_[^/]*\.py$/, /_test\.go$/]
// The lockfile each package manager commits. The signal is "a dependency
// lockfile is committed", whichever tool wrote it; bun.lock (Bun's text
// lockfile, the default since 1.2 in place of bun.lockb), deno.lock,
// packages.lock.json (NuGet), pdm.lock and npm-shrinkwrap.json were missing
// and read as "no lockfile".
const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'deno.lock',
  'uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock',
  'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'gradle.lockfile', 'packages.lock.json',
]

export function repoChecks(treePaths: string[]): { hasCI: boolean; hasTests: boolean; hasLockfile: boolean } {
  return {
    hasCI: treePaths.some(p => CI.some(rx => rx.test(p))),
    hasTests: treePaths.some(p => TESTS.some(rx => rx.test(p))),
    hasLockfile: treePaths.some(p => LOCKFILES.includes(p.split('/').pop() ?? '')),
  }
}
