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

// Measured at f7f4f34: bun.lock, deno.lock, packages.lock.json and pdm.lock
// all returned hasLockfile=false while bun.lockb, pnpm-lock.yaml and
// yarn.lock returned true. Each is the dependency lockfile its tool commits
// — Bun's text lockfile (the default since 1.2, replacing bun.lockb), Deno's,
// NuGet's, PDM's — and npm-shrinkwrap.json is npm's publishable lockfile.
// The signal is "a lockfile is committed"; it does not care which tool.
describe('repoChecks — lockfiles the signal did not recognise', () => {
  it.each(['bun.lock', 'deno.lock', 'packages.lock.json', 'pdm.lock', 'npm-shrinkwrap.json'])('%s counts as a committed lockfile', (lock) => {
    expect(repoChecks([lock, 'src/index.ts']).hasLockfile).toBe(true)
  })
  it('still recognises every lockfile it already did', () => {
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock',
      'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'gradle.lockfile']) {
      expect(repoChecks([lock]).hasLockfile).toBe(true)
    }
  })
  it('a lockfile-shaped name that is not one is still not one', () => {
    for (const notLock of ['lock.json', 'package.json', 'deno.json', 'bun.lockb.bak', 'flake.lock']) {
      expect(repoChecks([notLock]).hasLockfile).toBe(false)
    }
  })
})
