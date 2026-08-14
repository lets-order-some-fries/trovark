import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSurfaceSnapshot } from '../src/derive/surface.js'
import type { DriftEvent } from '../src/derive/surface.js'
import { refToFilename, loadSnapshot, saveSnapshot, appendDriftEvents } from '../index/surfaceStore.js'

const dir = () => mkdtempSync(join(tmpdir(), 'tv-surf-'))
const snap = (ref: string) => buildSurfaceSnapshot(ref,
  [{ name: 'x', description: 'X', schemaText: 'def' }], '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
const ev = (ref: string): DriftEvent => ({
  kind: 'event', ref, prevScannedAt: '2026-08-05T00:00:00.000Z', scannedAt: '2026-09-01T00:00:00.000Z',
  extractorVersion: '1.0.0', added: ['a'], removed: [], descriptionChanged: [], definitionChanged: [],
})

describe('surfaceStore', () => {
  it('refToFilename maps owner/repo to a flat, collision-safe name', () => {
    expect(refToFilename('acme/mcp-server')).toBe('acme__mcp-server.json')
  })
  it('save → load round-trips byte-identically; load of unknown ref is undefined', () => {
    const d = dir(); const s = snap('acme/mcp-server')
    saveSnapshot(d, s)
    expect(loadSnapshot(d, 'acme/mcp-server')).toEqual(s)
    expect(loadSnapshot(d, 'nobody/nothing')).toBeUndefined()
  })
  it('load of a corrupt file is undefined, never a throw (first scan must not die on bad state)', () => {
    const d = dir()
    writeFileSync(join(d, 'bad__file.json'), '{not json')
    expect(loadSnapshot(d, 'bad/file')).toBeUndefined()
  })
  it('appendDriftEvents creates the log, then appends, preserving prior events', () => {
    const d = dir(); const f = join(d, 'drift.json')
    expect(appendDriftEvents(f, [ev('a/b')]).events).toHaveLength(1)
    expect(appendDriftEvents(f, [ev('c/d')]).events).toHaveLength(2)
    expect(appendDriftEvents(f, []).events).toHaveLength(2)
  })
})
