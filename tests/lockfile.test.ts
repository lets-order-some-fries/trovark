import { describe, expect, it } from 'vitest'
import { parseLockfile } from '../src/derive/lockfile.js'

const packageLockV3 = JSON.stringify({
  name: 'foo',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'foo', version: '1.0.0' }, // root — must be skipped
    'node_modules/zod': { version: '3.22.5' }, // direct dep
    'node_modules/zod/node_modules/nested-dep': { version: '9.9.9' }, // transitive dep
    'node_modules/no-version-pkg': {}, // no version — must be skipped
  },
})

const uvLock = `
version = 1
requires-python = ">=3.10"

[[package]]
name = "httpx"
version = "0.27.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "anyio" },
]

[[package]]
name = "anyio"
version = "4.4.0"
source = { registry = "https://pypi.org/simple" }
`

const poetryLock = `
[[package]]
name = "requests"
version = "2.31.0"
description = "Python HTTP for Humans."
category = "main"

[[package]]
name = "certifi"
version = "2024.6.2"
description = "Python package for providing Mozilla's CA Bundle."
`

describe('parseLockfile', () => {
  it('extracts exact versions from a package-lock.json v3, including a transitive dep', () => {
    const deps = parseLockfile([{ path: 'package-lock.json', content: packageLockV3 }])
    expect(deps).toContainEqual({ name: 'zod', version: '3.22.5', ecosystem: 'npm' })
    expect(deps).toContainEqual({ name: 'nested-dep', version: '9.9.9', ecosystem: 'npm' })
    expect(deps.find(d => d.name === 'foo')).toBeUndefined() // root skipped
    expect(deps.find(d => d.name === 'no-version-pkg')).toBeUndefined() // versionless skipped
    expect(deps).toHaveLength(2)
  })

  it('extracts name+version PyPI deps from a uv.lock', () => {
    const deps = parseLockfile([{ path: 'uv.lock', content: uvLock }])
    expect(deps).toContainEqual({ name: 'httpx', version: '0.27.0', ecosystem: 'PyPI' })
    expect(deps).toContainEqual({ name: 'anyio', version: '4.4.0', ecosystem: 'PyPI' })
    expect(deps).toHaveLength(2)
  })

  it('extracts name+version PyPI deps from a poetry.lock', () => {
    const deps = parseLockfile([{ path: 'poetry.lock', content: poetryLock }])
    expect(deps).toContainEqual({ name: 'requests', version: '2.31.0', ecosystem: 'PyPI' })
    expect(deps).toContainEqual({ name: 'certifi', version: '2024.6.2', ecosystem: 'PyPI' })
    expect(deps).toHaveLength(2)
  })

  it('malformed package-lock.json JSON never throws — yields []', () => {
    expect(() => parseLockfile([{ path: 'package-lock.json', content: '{ not: valid json' }])).not.toThrow()
    expect(parseLockfile([{ path: 'package-lock.json', content: '{ not: valid json' }])).toEqual([])
  })

  it('ignores unrelated files and returns a de-duplicated result across a mixed file set', () => {
    const deps = parseLockfile([
      { path: 'README.md', content: 'not a lockfile' },
      { path: 'package-lock.json', content: packageLockV3 },
      { path: 'nested/package-lock.json', content: packageLockV3 }, // duplicate content — must dedupe
    ])
    expect(deps).toHaveLength(2)
  })

  it('returns [] for an empty file list', () => {
    expect(parseLockfile([])).toEqual([])
  })
})
