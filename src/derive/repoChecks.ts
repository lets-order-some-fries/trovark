const CI = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^\.travis\.yml$/]
const TESTS = [/(^|\/)(tests?|__tests__|spec)(\/|$)/, /\.(test|spec)\.[jt]sx?$/, /_test\.py$/, /^test_.*\.py$/, /\/test_[^/]*\.py$/]
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock']

export function repoChecks(treePaths: string[]): { hasCI: boolean; hasTests: boolean; hasLockfile: boolean } {
  return {
    hasCI: treePaths.some(p => CI.some(rx => rx.test(p))),
    hasTests: treePaths.some(p => TESTS.some(rx => rx.test(p))),
    hasLockfile: treePaths.some(p => LOCKFILES.includes(p.split('/').pop() ?? '')),
  }
}
