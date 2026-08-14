import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSurfaceSnapshot, EXTRACTOR_VERSION, diffSurfaces, formatDriftEvent, type DriftEvent } from '../src/derive/surface.js'
import { extractSchema } from '../src/derive/schema.js'
import type { ToolInfo } from '../src/types.js'

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')
const t = (name: string, description: string | undefined, schemaText: string): ToolInfo =>
  ({ name, ...(description !== undefined ? { description } : {}), schemaText })

describe('buildSurfaceSnapshot', () => {
  it('is deterministic: same input twice → byte-identical JSON', () => {
    const tools = [t('b_tool', 'Bee', 'reg(b)'), t('a_tool', 'Ay', 'reg(a)')]
    const a = buildSurfaceSnapshot('o/r', tools, '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    const b = buildSurfaceSnapshot('o/r', [...tools], '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
  it('sorts tools by name and hashes description + definition separately', () => {
    const s = buildSurfaceSnapshot('o/r',
      [t('zz', 'Z', 'def-z'), t('aa', 'A', 'def-a')],
      '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    expect(s.tools.map(x => x.name)).toEqual(['aa', 'zz'])
    expect(s.tools[0].descriptionSha256).toBe(sha('A'))
    expect(s.tools[0].definitionSha256).toBe(sha('def-a'))
    expect(s.extractorVersion).toBe(EXTRACTOR_VERSION)
    expect(s.source).toBe('code')
  })
  it('missing description hashes the empty string (absence is stable, never fabricated)', () => {
    const s = buildSurfaceSnapshot('o/r', [t('x', undefined, 'def')], '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    expect(s.tools[0].descriptionSha256).toBe(sha(''))
  })
  it('duplicate names are kept (multiset), ties broken by definitionSha256', () => {
    const s = buildSurfaceSnapshot('o/r',
      [t('dup', 'one', 'zzz'), t('dup', 'two', 'aaa')],
      '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    expect(s.tools).toHaveLength(2)
    expect(s.tools[0].definitionSha256 < s.tools[1].definitionSha256).toBe(true)
  })
  it('surfaceSha256 covers tools only — scannedAt does not change it', () => {
    const tools = [t('a', 'A', 'def')]
    const s1 = buildSurfaceSnapshot('o/r', tools, '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    const s2 = buildSurfaceSnapshot('o/r', tools, '2026-09-05T00:00:00.000Z', '1.5.0', 'code')
    expect(s1.surfaceSha256).toBe(s2.surfaceSha256)
  })
  it('astral/multibyte content hashes by UTF-8 bytes without error', () => {
    const s = buildSurfaceSnapshot('o/r', [t('emoji', '🏴‍☠️ desc', 'def🏴')], '2026-08-05T00:00:00.000Z', '1.5.0', 'code')
    expect(s.tools[0].descriptionSha256).toBe(sha('🏴‍☠️ desc'))
  })
})

const snap = (tools: ToolInfo[]) =>
  buildSurfaceSnapshot('o/r', tools, '2026-08-05T00:00:00.000Z', '1.5.0', 'code')

describe('diffSurfaces', () => {
  it('unchanged surface → kind unchanged (no event, ever, for a quiet server)', () => {
    const a = snap([t('x', 'X', 'def')])
    expect(diffSurfaces(a, { ...a, scannedAt: '2026-09-01T00:00:00.000Z' }).kind).toBe('unchanged')
  })
  it('reports added and removed by name', () => {
    const r = diffSurfaces(snap([t('keep', 'K', 'd1'), t('old', 'O', 'd2')]),
                           snap([t('keep', 'K', 'd1'), t('new', 'N', 'd3')])) as DriftEvent
    expect(r.kind).toBe('event')
    expect(r.added).toEqual(['new'])
    expect(r.removed).toEqual(['old'])
  })
  it('description change reported as descriptionChanged, NOT also definitionChanged', () => {
    // description text appears inside schemaText too — the more specific
    // category wins so one edit is not double-reported.
    const r = diffSurfaces(snap([t('x', 'old words', 'reg(x, "old words")')]),
                           snap([t('x', 'new words', 'reg(x, "new words")')])) as DriftEvent
    expect(r.descriptionChanged).toEqual(['x'])
    expect(r.definitionChanged).toEqual([])
  })
  it('definition-only change (same description) → definitionChanged', () => {
    const r = diffSurfaces(snap([t('x', 'same', 'reg(x, a)')]),
                           snap([t('x', 'same', 'reg(x, b)')])) as DriftEvent
    expect(r.definitionChanged).toEqual(['x'])
    expect(r.descriptionChanged).toEqual([])
  })
  it('SUPPRESSED when extractorVersion differs — parser churn must never render as drift', () => {
    const a = snap([t('x', 'X', 'd')])
    const b = { ...snap([t('x', 'X', 'd'), t('y', 'Y', 'e')]), extractorVersion: '9.9.9' }
    expect(diffSurfaces(a, b)).toEqual({ kind: 'suppressed', ref: 'o/r', reason: 'extractor-version-changed' })
  })
  it('SUPPRESSED when source differs (code vs readme-catalog)', () => {
    const a = snap([t('x', 'X', 'd')])
    const b = { ...a, source: 'readme-catalog' as const, scannedAt: '2026-09-01T00:00:00.000Z' }
    expect(diffSurfaces(a, b)).toEqual({ kind: 'suppressed', ref: 'o/r', reason: 'source-changed' })
  })
})

describe('formatDriftEvent', () => {
  const ev: DriftEvent = {
    kind: 'event', ref: 'o/r', prevScannedAt: '2026-08-05T00:00:00.000Z',
    scannedAt: '2026-09-14T00:00:00.000Z', extractorVersion: '1.0.0',
    added: ['a', 'b'], removed: [], descriptionChanged: ['c'], definitionChanged: [],
  }
  it('renders the spec example shape: counts + date, neutral', () => {
    expect(formatDriftEvent(ev)).toBe('Tool surface changed 2026-09-14: 2 tools added, 1 description edited.')
  })
  it('singular/plural + removed + definition wording', () => {
    expect(formatDriftEvent({ ...ev, added: ['a'], removed: ['x'], descriptionChanged: [], definitionChanged: ['y'] }))
      .toBe('Tool surface changed 2026-09-14: 1 tool added, 1 tool removed, 1 definition changed.')
  })
  it('NEVER uses verdict language (static template lint)', () => {
    const BANNED = /rug.?pull|malicious|suspicious|attack|poison|backdoor|compromised|hijack|dangerous/i
    // formatDriftEvent interpolates only counts, dates and tool NAMES it is
    // given; lint the rendered output of a benign event as a proxy for the
    // static template (the integrity-v1 lesson: never lint hostile content).
    expect(BANNED.test(formatDriftEvent(ev))).toBe(false)
  })
})

describe('extractor-output guard (EXTRACTOR_VERSION discipline)', () => {
  const guardPath = fileURLToPath(new URL('./fixtures/surface-guard.json', import.meta.url))
  const guard = JSON.parse(readFileSync(guardPath, 'utf8')) as {
    _comment: string
    extractorVersion: string
    surfaceSha256: string
    files: Array<{ path: string; content: string }>
  }
  it('recorded fixture surface is stable — if this fails, extraction output changed: bump EXTRACTOR_VERSION in src/derive/surface.ts and re-record', () => {
    // One extractSchema call PER file, not one call over all three: the
    // extraction ladder stops at the first rung that yields tools, so a
    // single call would only ever exercise the manifest rung and the TS/
    // Python fixtures would contribute nothing to the recorded hash.
    const tools = guard.files.flatMap(f => extractSchema([f]).tools)
    const snap = buildSurfaceSnapshot('guard/fixture', tools, '2026-01-01T00:00:00.000Z', 'n/a', 'code')
    expect(tools.length).toBeGreaterThanOrEqual(3) // all three extractors contributed
    if (guard.extractorVersion === EXTRACTOR_VERSION) {
      expect(snap.surfaceSha256).toBe(guard.surfaceSha256)
    } else {
      // version was bumped: re-record and update the fixture in the same commit
      expect(guard.surfaceSha256).not.toBe(snap.surfaceSha256)
    }
  })
})
