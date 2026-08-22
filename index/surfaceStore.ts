// index/surfaceStore.ts
// D2 observatory persistence. One JSON file per server under index/surfaces/
// plus an append-only drift log. Committed to git: THE GIT HISTORY OF THESE
// FILES IS THE LONGITUDINAL DATASET — never rewrite, only append/overwrite
// forward.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DriftEvent, ToolSurfaceSnapshot } from '../src/derive/surface.js'

export function refToFilename(ref: string): string {
  return `${ref.replace(/\//g, '__')}.json`
}

export function loadSnapshot(dir: string, ref: string): ToolSurfaceSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, refToFilename(ref)), 'utf8')) as ToolSurfaceSnapshot
    return typeof parsed?.surfaceSha256 === 'string' && Array.isArray(parsed?.tools) ? parsed : undefined
  } catch { return undefined }
}

export function saveSnapshot(dir: string, snap: ToolSurfaceSnapshot): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, refToFilename(snap.ref)), JSON.stringify(snap, null, 2) + '\n')
}

export interface DriftLog { events: DriftEvent[] }

export function appendDriftEvents(file: string, events: DriftEvent[]): DriftLog {
  let log: DriftLog = { events: [] }
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as DriftLog
      if (Array.isArray(parsed?.events)) log = parsed
    } catch { /* corrupt log: start fresh rather than crash the scan */ }
  }
  log.events.push(...events)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(log, null, 2) + '\n')
  return log
}
