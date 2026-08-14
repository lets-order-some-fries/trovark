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
