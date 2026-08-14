import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { buildSurfaceSnapshot, EXTRACTOR_VERSION } from '../src/derive/surface.js'
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
