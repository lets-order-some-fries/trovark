// D2 (threat-spec §D2, skeptic KEEP #57): the tool-surface OBSERVATORY.
// An artifact, not a detector: zero findings, zero score impact, and the
// drift feed never renders a diff across differing extractor versions —
// this repo's own history (v1.2→v1.4 moved 211→270 graded) proves parser
// churn would otherwise manufacture fake drift.
import { createHash } from 'node:crypto'
import type { ToolInfo } from '../types.js'

// Bump on ANY change to what extraction emits: src/derive/schema.ts,
// src/derive/lang/go.ts, src/derive/openapi.ts, or the sampler
// (selectRepoFiles in src/collectors/github.ts). The guard test in
// tests/surface.test.ts ('extractor-output guard') fails when recorded
// fixture output changes without a bump.
export const EXTRACTOR_VERSION = '1.0.0'

export type SurfaceSource = 'code' | 'readme-catalog'
export interface SurfaceTool { name: string; descriptionSha256: string; definitionSha256: string }
export interface ToolSurfaceSnapshot {
  ref: string
  scannedAt: string
  extractorVersion: string
  rubricVersion: string
  source: SurfaceSource
  tools: SurfaceTool[]
  surfaceSha256: string
}

const sha256 = (s: string): string =>
  createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

export function buildSurfaceSnapshot(
  ref: string, tools: ToolInfo[], scannedAt: string,
  rubricVersion: string, source: SurfaceSource,
): ToolSurfaceSnapshot {
  const surfaceTools: SurfaceTool[] = tools
    .map(t => ({
      name: t.name,
      descriptionSha256: sha256(t.description ?? ''),
      definitionSha256: sha256(t.schemaText),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.definitionSha256.localeCompare(b.definitionSha256))
  return {
    ref, scannedAt,
    extractorVersion: EXTRACTOR_VERSION,
    rubricVersion, source,
    tools: surfaceTools,
    surfaceSha256: sha256(JSON.stringify(surfaceTools)),
  }
}

export interface DriftEvent {
  kind: 'event'
  ref: string; prevScannedAt: string; scannedAt: string
  extractorVersion: string
  added: string[]; removed: string[]
  descriptionChanged: string[]; definitionChanged: string[]
}
export type DiffResult = DriftEvent
  | { kind: 'suppressed'; ref: string; reason: 'extractor-version-changed' | 'source-changed' }
  | { kind: 'unchanged' }

export function diffSurfaces(prev: ToolSurfaceSnapshot, next: ToolSurfaceSnapshot): DiffResult {
  if (prev.extractorVersion !== next.extractorVersion)
    return { kind: 'suppressed', ref: next.ref, reason: 'extractor-version-changed' }
  if (prev.source !== next.source)
    return { kind: 'suppressed', ref: next.ref, reason: 'source-changed' }
  if (prev.surfaceSha256 === next.surfaceSha256) return { kind: 'unchanged' }

  const byName = (ts: SurfaceTool[]) => {
    const m = new Map<string, SurfaceTool[]>()
    for (const t of ts) m.set(t.name, [...(m.get(t.name) ?? []), t])
    return m
  }
  const p = byName(prev.tools), n = byName(next.tools)
  const added: string[] = [], removed: string[] = []
  const descriptionChanged: string[] = [], definitionChanged: string[] = []
  for (const [name, ts] of n) {
    const old = p.get(name)
    if (!old) { added.push(...ts.map(() => name)); continue }
    // multiset count changes on a shared name count as add/remove
    if (ts.length > old.length) added.push(...Array(ts.length - old.length).fill(name))
    if (ts.length < old.length) removed.push(...Array(old.length - ts.length).fill(name))
    if (ts.length === 1 && old.length === 1) {
      if (ts[0].descriptionSha256 !== old[0].descriptionSha256) descriptionChanged.push(name)
      else if (ts[0].definitionSha256 !== old[0].definitionSha256) definitionChanged.push(name)
    }
  }
  for (const [name, ts] of p) if (!n.has(name)) removed.push(...ts.map(() => name))
  added.sort(); removed.sort(); descriptionChanged.sort(); definitionChanged.sort()
  return {
    kind: 'event', ref: next.ref,
    prevScannedAt: prev.scannedAt, scannedAt: next.scannedAt,
    extractorVersion: next.extractorVersion,
    added, removed, descriptionChanged, definitionChanged,
  }
}

// Neutral by construction: counts, a date, nothing else. The observatory
// publishes facts about change, never characterizations of it.
export function formatDriftEvent(e: DriftEvent): string {
  const parts: string[] = []
  const n = (c: number, sing: string, plur: string) => `${c} ${c === 1 ? sing : plur}`
  if (e.added.length) parts.push(`${n(e.added.length, 'tool', 'tools')} added`)
  if (e.removed.length) parts.push(`${n(e.removed.length, 'tool', 'tools')} removed`)
  if (e.descriptionChanged.length) parts.push(`${n(e.descriptionChanged.length, 'description', 'descriptions')} edited`)
  if (e.definitionChanged.length) parts.push(`${n(e.definitionChanged.length, 'definition', 'definitions')} changed`)
  return `Tool surface changed ${e.scannedAt.slice(0, 10)}: ${parts.join(', ')}.`
}
