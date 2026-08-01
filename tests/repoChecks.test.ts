import { describe, expect, it } from 'vitest'
import { repoChecks } from '../src/derive/repoChecks.js'

describe('repoChecks', () => {
  it('detects CI, tests, lockfile', () => {
    expect(repoChecks([
      '.github/workflows/ci.yml', 'tests/test_main.py', 'package-lock.json', 'src/index.ts',
    ])).toEqual({ hasCI: true, hasTests: true, hasLockfile: true })
  })
  it('detects *.test.ts style tests and pnpm lockfile', () => {
    const r = repoChecks(['src/foo.test.ts', 'pnpm-lock.yaml'])
    expect(r.hasTests).toBe(true)
    expect(r.hasLockfile).toBe(true)
    expect(r.hasCI).toBe(false)
  })
  it('all false on empty tree', () => {
    expect(repoChecks([])).toEqual({ hasCI: false, hasTests: false, hasLockfile: false })
  })
  it('detects Go tests via _test.go', () => {
    expect(repoChecks(['main_test.go'])).toEqual({ hasCI: false, hasTests: true, hasLockfile: false })
  })
  it('detects go.sum, Cargo.lock, Gemfile.lock, composer.lock, gradle.lockfile as lockfiles', () => {
    for (const lock of ['go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'gradle.lockfile']) {
      expect(repoChecks([lock]).hasLockfile).toBe(true)
    }
  })
})
