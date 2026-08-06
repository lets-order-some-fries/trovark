# D2 Tool-Surface Observatory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a per-server snapshot of every scanned MCP server's tool surface on each index scan, and publish a neutral, suppression-disciplined drift feed — making Trovark the only public index that remembers what every server's tool surface looked like last month.

**Architecture:** A pure derive module (`src/derive/surface.ts`) builds canonical, hash-based snapshots and diffs consecutive snapshots; a small I/O store (`index/surfaceStore.ts`) persists one JSON file per server under `index/surfaces/` plus an append-only `index/drift.json`; `index/scan.ts` wires them into the existing pool; `index/site.ts` renders the feed. Git history of the committed snapshot files **is** the longitudinal dataset.

**Tech Stack:** TypeScript ESM (NodeNext), `node:crypto` sha256, vitest. **No new dependencies.**

## Global Constraints

- Pre-vetted spec: `.superpowers/sdd/threat-spec.md` §D2. Skeptic verdict: *"KEEP — as a transparency product, not a security score."*
- **Artifact, not a detector. Zero `Finding`s. Zero score impact. Zero pejorative language — ever.** No `Signals` field added here may be read by any `SIGNALS[].evaluate` in `src/scoring/rubric.ts`.
- **Banned words in any D2 template string:** `rug pull`, `rug-pull`, `malicious`, `suspicious`, `attack`, `poison`, `backdoor`, `compromised`, `hijack`, `dangerous`. Lint STATIC template text only (the integrity-v1 Critical lesson: never lint interpolated content).
- **Diffs across differing `extractorVersion` are SUPPRESSED, not rendered** (threat-spec constraint 1: v1.2→v1.4 parser churn would have manufactured hundreds of fake diffs). Same rule for differing `source` (code vs readme-catalog).
- **Missing snapshot ≠ removal.** A server that becomes `notServer`/`dynamic`/`unresolved`/`insufficientData` produces no new snapshot and NO drift event.
- The postmark-mcp caveat must appear verbatim wherever the feed is published: *"The one confirmed in-the-wild malicious MCP server (postmark-mcp v1.0.16) added a BCC line in implementation code. Tool-surface diffing would not have caught it."*
- Deviation from the spec sketch, pre-registered here with reason: the spec's `schemaSha256` is named **`definitionSha256`** and hashes `ToolInfo.schemaText` (the extracted definition slice) — no structured `inputSchema` exists in extraction (`src/types.ts:31-35`), and the honest name says what is hashed.
- `RUBRIC_VERSION` does not change. `EXTRACTOR_VERSION` is a NEW constant starting `'1.0.0'`.
- **Precondition: branch `feat/observatory-d2` off `main` only AFTER `feat/coverage-w6` merges** — D2 consumes W6's `extractSchema` signature and the dynamic-surface gate.
- All 551 existing tests must stay green. `npm run build` clean.

## File Structure

- `src/derive/surface.ts` (new, pure, no I/O) — `EXTRACTOR_VERSION`, snapshot builder, differ, neutral formatter.
- `tests/surface.test.ts` (new) — determinism, hashing, suppression, banned-language.
- `src/types.ts` (modify) — `Signals.tools` + `Signals.toolSource`, artifact-only.
- `src/assemble.ts` (modify) — thread extracted tools into `Signals`.
- `index/surfaceStore.ts` (new, thin I/O) — load/save snapshots, append drift log.
- `tests/surfaceStore.test.ts` (new) — temp-dir round-trip + append semantics.
- `index/scan.ts` (modify) — build/diff/persist per ref inside the pool callback.
- `index/site.ts` (modify) — "Drift" feed section with baseline state.
- `docs/methodology.md`, `README.md` (modify) — the observatory section + caveat.

---

### Task 1: Pure snapshot builder (`buildSurfaceSnapshot`)

**Files:**
- Create: `src/derive/surface.ts`
- Test: `tests/surface.test.ts`

**Interfaces:**
- Consumes: `ToolInfo` from `src/types.ts` (`{ name: string; description?: string; schemaText: string }`).
- Produces (later tasks rely on these exact names):

```ts
export const EXTRACTOR_VERSION = '1.0.0'
export type SurfaceSource = 'code' | 'readme-catalog'
export interface SurfaceTool { name: string; descriptionSha256: string; definitionSha256: string }
export interface ToolSurfaceSnapshot {
  ref: string; scannedAt: string
  extractorVersion: string; rubricVersion: string
  source: SurfaceSource
  tools: SurfaceTool[]          // sorted by name, ties by definitionSha256
  surfaceSha256: string         // sha256 of canonical JSON of `tools`
}
export function buildSurfaceSnapshot(
  ref: string, tools: ToolInfo[], scannedAt: string,
  rubricVersion: string, source: SurfaceSource,
): ToolSurfaceSnapshot
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/surface.test.ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/surface.test.ts`
Expected: FAIL — `Cannot find module '../src/derive/surface.js'`

- [ ] **Step 3: Implement**

```ts
// src/derive/surface.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/surface.test.ts` — Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/derive/surface.ts tests/surface.test.ts
git commit -m "feat(surface): canonical tool-surface snapshot builder (D2, EXTRACTOR_VERSION 1.0.0)"
```

---

### Task 2: Differ + neutral formatter (`diffSurfaces`, `formatDriftEvent`)

**Files:**
- Modify: `src/derive/surface.ts`
- Test: `tests/surface.test.ts` (append)

**Interfaces:**
- Consumes: `ToolSurfaceSnapshot` from Task 1.
- Produces:

```ts
export interface DriftEvent {
  kind: 'event'
  ref: string; prevScannedAt: string; scannedAt: string
  extractorVersion: string
  added: string[]; removed: string[]
  descriptionChanged: string[]; definitionChanged: string[]  // names only, disjoint
}
export type DiffResult = DriftEvent
  | { kind: 'suppressed'; ref: string; reason: 'extractor-version-changed' | 'source-changed' }
  | { kind: 'unchanged' }
export function diffSurfaces(prev: ToolSurfaceSnapshot, next: ToolSurfaceSnapshot): DiffResult
export function formatDriftEvent(e: DriftEvent): string
```

- [ ] **Step 1: Write the failing tests** (append to `tests/surface.test.ts`)

```ts
import { diffSurfaces, formatDriftEvent, type DriftEvent } from '../src/derive/surface.js'

const snap = (tools: ToolInfo[], over: Partial<Parameters<typeof buildSurfaceSnapshot>> = {}) =>
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/surface.test.ts` — Expected: FAIL, `diffSurfaces` not exported.

- [ ] **Step 3: Implement** (append to `src/derive/surface.ts`)

```ts
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/surface.test.ts` — Expected: PASS (all Task 1+2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/derive/surface.ts tests/surface.test.ts
git commit -m "feat(surface): suppression-disciplined differ + neutral drift formatter (D2)"
```

---

### Task 3: Thread extracted tools through `Signals` (artifact-only)

**Files:**
- Modify: `src/types.ts` (inside `interface Signals`, after `integrityScanned`)
- Modify: `src/assemble.ts` (where `extractSchema`'s result is consumed — locate with `grep -n "schemaTokenEstimate = " src/assemble.ts`; set the new fields at BOTH the static-extraction site and the README-rung site)
- Test: `tests/assemble.test.ts` (append)

**Interfaces:**
- Produces: `Signals.tools?: ToolInfo[]` and `Signals.toolSource?: 'code' | 'readme-catalog'` — set together iff extraction produced ≥1 tool; both stay `undefined` otherwise (absence ≠ empty surface).

- [ ] **Step 1: Write the failing test** (append to `tests/assemble.test.ts`). That file already provides `makeRoutedHttp(routes: Record<string, unknown>, textFn: (url: string) => string): Http` and `fullFake(): Http` at lines 13 and 37, and `const NOW = new Date('2026-07-31T00:00:00Z')` at line 6 — use `fullFake()` exactly as the file's existing extraction tests do.

```ts
it('threads extracted tools + source into Signals as an artifact (never scored)', async () => {
  const s = await assemble({ ref: 'o/r', repo: { owner: 'o', name: 'r' } } as never, fullFake(), NOW, { hasToken: true })
  expect(s.tools).toBeDefined()
  expect(s.tools!.length).toBeGreaterThan(0)
  expect(s.toolSource).toBe('code')
  expect(s.tools![0]).toHaveProperty('name')
  expect(s.tools![0]).toHaveProperty('schemaText')
  // evidence is stripped: hashes must cover tool content, not our file paths
  expect(s.tools![0]).not.toHaveProperty('evidence')
})

it('rubric provably never reads Signals.tools/toolSource (artifact-only guarantee)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/scoring/rubric.ts', 'utf8')
  expect(/\btools\b|\btoolSource\b/.test(src)).toBe(false)
})
```

*(If `fullFake()`'s fixture repo does not itself extract tools, use `makeRoutedHttp` with the same routes the file's existing `extractSchema`-exercising test uses — copy that test's route object verbatim rather than inventing one. The second test is the load-bearing one: `rubric.ts` must never mention the new fields.)*

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/assemble.test.ts` — Expected: FAIL, `s.tools` undefined.

- [ ] **Step 3: Implement.** In `src/types.ts`, inside `Signals` after `integrityScanned`:

```ts
  // D2 (observatory, docs/superpowers/plans/2026-08-05-observatory-d2.md):
  // the extracted tool surface, threaded through for SNAPSHOTTING only —
  // an artifact, never a signal. No SIGNALS[].evaluate may read these
  // (asserted by tests/assemble.test.ts). Both undefined unless extraction
  // produced >=1 tool; absence != an empty surface.
  tools?: ToolInfo[]
  toolSource?: 'code' | 'readme-catalog'
```

In `src/assemble.ts`, at the static-extraction success site (where `s.schemaTokenEstimate`/`s.toolCount` are set from the schema result), add:

```ts
      if (schema.tools.length > 0) {
        s.tools = schema.tools.map(({ evidence: _evidence, ...t }) => t)  // strip evidence: hashes must cover content, not our file paths
        s.toolSource = 'code'
      }
```

At the README-rung success site (W6 added it; locate with `grep -n "fromReadmeCatalog\|readmeFile" src/assemble.ts`), the same two lines with `'readme-catalog'`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/assemble.test.ts` — Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
npx vitest run   # all green (551 + new)
git add src/types.ts src/assemble.ts tests/assemble.test.ts
git commit -m "feat(surface): thread extracted tools through Signals as artifact-only (D2)"
```

---

### Task 4: Snapshot store (`index/surfaceStore.ts`)

**Files:**
- Create: `index/surfaceStore.ts`
- Test: `tests/surfaceStore.test.ts`

**Interfaces:**
- Consumes: `ToolSurfaceSnapshot`, `DriftEvent` from Task 1/2.
- Produces:

```ts
export function refToFilename(ref: string): string            // 'o/r' → 'o__r.json'
export function loadSnapshot(dir: string, ref: string): ToolSurfaceSnapshot | undefined
export function saveSnapshot(dir: string, snap: ToolSurfaceSnapshot): void
export interface DriftLog { events: DriftEvent[] }
export function appendDriftEvents(file: string, events: DriftEvent[]): DriftLog  // returns full log after append
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/surfaceStore.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
    require('node:fs').writeFileSync(join(d, 'bad__file.json'), '{not json')
    expect(loadSnapshot(d, 'bad/file')).toBeUndefined()
  })
  it('appendDriftEvents creates the log, then appends, preserving prior events', () => {
    const d = dir(); const f = join(d, 'drift.json')
    expect(appendDriftEvents(f, [ev('a/b')]).events).toHaveLength(1)
    expect(appendDriftEvents(f, [ev('c/d')]).events).toHaveLength(2)
    expect(appendDriftEvents(f, []).events).toHaveLength(2)
  })
})
```

*(Note: use `import { writeFileSync } from 'node:fs'` at top instead of `require` — this is ESM; the snippet above marks intent, write it as a proper import.)*

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/surfaceStore.test.ts` — Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/surfaceStore.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index/surfaceStore.ts tests/surfaceStore.test.ts
git commit -m "feat(surface): snapshot store + append-only drift log (D2)"
```

---

### Task 5: Wire into `index/scan.ts`

**Files:**
- Modify: `index/scan.ts` (the pool callback at ~`index/scan.ts:157-172` and the write-out block at ~`:181`)
- Test: `tests/scan.test.ts` (append — this file already tests `summarize`; add a pure-helper test)

**Interfaces:**
- Consumes: everything above. Produces: `index/surfaces/*.json` + `index/drift.json` on every scan run; `console.error` one summary line: `surfaces: N written, E drift events, S suppressed`.
- Produces for Task 6: `IndexStats.driftEvents?: number` (count from THIS run only).

- [ ] **Step 1: Write the failing test** (append to `tests/scan.test.ts`)

```ts
import { recordSurfaces } from '../index/scan.js'
import { buildSurfaceSnapshot } from '../src/derive/surface.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('recordSurfaces', () => {
  const tools = [{ name: 'x', description: 'X', schemaText: 'def' }]
  it('first run writes snapshots, zero events (baseline); second identical run adds nothing; a change adds one event', () => {
    const d = mkdtempSync(join(tmpdir(), 'tv-scan-'))
    const r1 = recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-08-05T00:00:00.000Z', '1.5.0')
    expect(r1).toEqual({ written: 1, events: 0, suppressed: 0 })
    const r2 = recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-09-01T00:00:00.000Z', '1.5.0')
    expect(r2.events).toBe(0)
    const r3 = recordSurfaces(d, [{ ref: 'a/b', tools: [...tools, { name: 'y', schemaText: 'd2' }], source: 'code' as const }], '2026-10-01T00:00:00.000Z', '1.5.0')
    expect(r3.events).toBe(1)
  })
  it('a server absent from this run keeps its old snapshot and produces NO event (missing != removed)', () => {
    const d = mkdtempSync(join(tmpdir(), 'tv-scan-'))
    recordSurfaces(d, [{ ref: 'a/b', tools, source: 'code' as const }], '2026-08-05T00:00:00.000Z', '1.5.0')
    const r = recordSurfaces(d, [], '2026-09-01T00:00:00.000Z', '1.5.0')
    expect(r).toEqual({ written: 0, events: 0, suppressed: 0 })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/scan.test.ts` — Expected: FAIL, `recordSurfaces` not exported.

- [ ] **Step 3: Implement.** In `index/scan.ts`:

```ts
// near the other imports
import { buildSurfaceSnapshot, diffSurfaces, EXTRACTOR_VERSION } from '../src/derive/surface.js'
import type { DriftEvent, SurfaceSource } from '../src/derive/surface.js'
import { appendDriftEvents, loadSnapshot, saveSnapshot } from './surfaceStore.js'
import type { ToolInfo } from '../src/types.js'

// D2: pure-ish helper (all I/O confined to dir) so it is testable without a
// network scan. Called once per run, after the pool completes.
export function recordSurfaces(
  surfacesDir: string,
  extracted: Array<{ ref: string; tools: ToolInfo[]; source: SurfaceSource }>,
  scannedAt: string, rubricVersion: string,
): { written: number; events: number; suppressed: number } {
  const events: DriftEvent[] = []
  let suppressed = 0
  for (const { ref, tools, source } of extracted) {
    const next = buildSurfaceSnapshot(ref, tools, scannedAt, rubricVersion, source)
    const prev = loadSnapshot(surfacesDir, ref)
    if (prev) {
      const d = diffSurfaces(prev, next)
      if (d.kind === 'event') events.push(d)
      else if (d.kind === 'suppressed') suppressed++
    }
    saveSnapshot(surfacesDir, next)
  }
  if (events.length || !existsSync(join(surfacesDir, '..', 'drift.json'))) {
    appendDriftEvents(join(surfacesDir, '..', 'drift.json'), events)
  }
  return { written: extracted.length, events: events.length, suppressed }
}
```

*(Add `existsSync`/`join` to the existing `node:fs`/`node:path` imports — scan.ts already imports from `node:fs`.)*

Inside the pool callback, collect the surface inputs — after `const signals = await assemble(...)`:

```ts
      if (signals.tools && signals.toolSource && !signals.notServer && !signals.unresolved) {
        surfaceInputs.push({ ref, tools: signals.tools, source: signals.toolSource })
      }
```

with `const surfaceInputs: Array<{ ref: string; tools: ToolInfo[]; source: SurfaceSource }> = []` declared beside `let done = 0`. After the pool and before the payload write:

```ts
  const surf = recordSurfaces(join(dirname(outFile), 'surfaces'), surfaceInputs, now.toISOString(), RUBRIC_VERSION)
  console.error(`surfaces: ${surf.written} written, ${surf.events} drift events, ${surf.suppressed} suppressed`)
```

and add `driftEvents: surf.events` into the `stats` object in the payload (extend `IndexStats` with `driftEvents?: number`).

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/scan.test.ts` then the full suite `npx vitest run` — Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add index/scan.ts tests/scan.test.ts
git commit -m "feat(surface): record snapshots + drift on every index scan (D2)"
```

---

### Task 6: Site feed, extractor guard, and docs

**Files:**
- Modify: `index/site.ts` (add a Drift section to the generated page — follow the existing section-rendering pattern; locate with `grep -n "section\|<h2" index/site.ts`)
- Modify: `docs/methodology.md`, `README.md`
- Test: `tests/site.test.ts` (append), `tests/surface.test.ts` (append the guard), Create: `tests/fixtures/surface-guard.json`

**Interfaces:** consumes `DriftLog` via `index/drift.json` if present next to `results.json`; renders nothing but facts.

- [ ] **Step 1: Write the failing site test** (append to `tests/site.test.ts`). **Signature change required:** today `index/site.ts:71` is `export function renderSite(r: Results): string`. Widen it to `export function renderSite(r: Results, drift: DriftLog = { events: [] }): string` — an OPTIONAL second parameter, so all existing call sites in `tests/site.test.ts` (lines 20, 58, 89, 111, 123, 131) keep compiling unchanged. Reuse that file's existing `results` fixture object (line ~19).

```ts
import type { DriftLog } from '../index/surfaceStore.js'

it('renders the drift feed: baseline state when log is empty, neutral lines when not', () => {
  const htmlEmpty = renderSite(results)
  expect(htmlEmpty).toContain('Baseline recorded')
  expect(htmlEmpty).toContain('postmark-mcp')          // the honest caveat is ALWAYS on the page
  const log: DriftLog = { events: [{
    kind: 'event', ref: 'a/b', prevScannedAt: '2026-08-05T00:00:00.000Z', scannedAt: '2026-09-14T00:00:00.000Z',
    extractorVersion: '1.0.0', added: ['t1', 't2'], removed: [], descriptionChanged: ['t3'], definitionChanged: [],
  }] }
  const htmlWithEvent = renderSite(results, log)
  expect(htmlWithEvent).toContain('Tool surface changed 2026-09-14: 2 tools added, 1 description edited.')
  expect(/rug.?pull|malicious|suspicious/i.test(htmlWithEvent)).toBe(false)
})
```

Also update the CLI block at `index/site.ts:134-135` to load the log beside the results file and pass it through:

```ts
  const inPath = arg('--in', 'index/results.json')
  const results = JSON.parse(readFileSync(inPath, 'utf8')) as Results
  let drift: DriftLog = { events: [] }
  try { drift = JSON.parse(readFileSync(join(dirname(inPath), 'drift.json'), 'utf8')) as DriftLog } catch { /* no log yet: baseline state */ }
```

then pass `drift` as `renderSite(results, drift)`. Add `join`/`dirname` from `node:path` to the imports.

- [ ] **Step 2: Write the failing extractor-output guard** (append to `tests/surface.test.ts`)

```ts
import guard from './fixtures/surface-guard.json'
import { extractSchema } from '../src/derive/schema.js'

describe('extractor-output guard (EXTRACTOR_VERSION discipline)', () => {
  it('recorded fixture surface is stable — if this fails, extraction output changed: bump EXTRACTOR_VERSION in src/derive/surface.ts and re-record', () => {
    const files = guard.files as Array<{ path: string; content: string }>
    const result = extractSchema(files)
    const snap = buildSurfaceSnapshot('guard/fixture', result.tools, '2026-01-01T00:00:00.000Z', 'n/a', 'code')
    if (guard.extractorVersion === EXTRACTOR_VERSION) {
      expect(snap.surfaceSha256).toBe(guard.surfaceSha256)
    } else {
      // version was bumped: re-record and update the fixture in the same commit
      expect(guard.surfaceSha256).not.toBe(snap.surfaceSha256)
    }
  })
})
```

Create `tests/fixtures/surface-guard.json` by running a one-off script: take 3 representative fixture files ALREADY used in `tests/schema.test.ts` (one TS `registerTool` fixture, one Python `@mcp.tool` fixture, one manifest fixture — copy their exact `content` strings), run `extractSchema` + `buildSurfaceSnapshot` on them, and record `{ "extractorVersion": "1.0.0", "surfaceSha256": "<computed>", "files": [ ...the 3 files... ] }`. The fixture must be committed with the recorded hash.

*(Scope note, stated honestly in the fixture's own `_comment` field: this guard covers `schema.ts`-layer changes. Sampler changes are already caught by `tests/fixtures/sampling-corpus.json`; add one line to THAT test's failure message: "if intentional, also bump EXTRACTOR_VERSION (D2)".)*

- [ ] **Step 3: Implement the site section.** In `index/site.ts`, read the log beside the results file (`join(dirname(resultsPath), 'drift.json')`, tolerate absence → `{ events: [] }`), and render, following the page's existing HTML conventions:

- Heading: `Tool-surface drift`
- Intro line (verbatim): `The index remembers what every server's tool surface looked like on each scan. Changes between scans of the same extractor version are listed here as facts — counts and dates, nothing more.`
- Caveat line (verbatim, always rendered): `Scope note: the one confirmed in-the-wild malicious MCP server (postmark-mcp v1.0.16) added a BCC line in implementation code. Tool-surface diffing would not have caught it.`
- Empty state: `Baseline recorded <date of generatedAt>. Drift reporting begins with the next scan.`
- Non-empty: the most recent 50 events, newest first, each as `<ref> — <formatDriftEvent(e)>`, using `formatDriftEvent` imported from `../src/derive/surface.js`.

- [ ] **Step 4: Docs.** Append to `docs/methodology.md` (new section `## Tool-surface observatory (D2)`): what a snapshot contains (hashes, not content), the `EXTRACTOR_VERSION` suppression rule and WHY (v1.2→v1.4 parser churn manufactured 211→270 graded — real history, would have been fake drift), missing-snapshot ≠ removal, the postmark caveat verbatim, and the sentence: `The drift feed publishes facts about change — counts, names, dates. It never characterizes intent.` Add a short README section `### The observatory` with the one-line pitch (`the only public index that remembers what every server's tool surface looked like last month`) linking to the methodology section.

- [ ] **Step 5: Run everything** — `npx vitest run` (all green) and `npm run build` (clean).

- [ ] **Step 6: Commit**

```bash
git add index/site.ts tests/site.test.ts tests/surface.test.ts tests/fixtures/surface-guard.json docs/methodology.md README.md
git commit -m "feat(surface): drift feed on the index page + extractor-output guard + methodology (D2)"
```

---

## Verification gates (whole-branch, before merge)

1. Full suite green; build clean.
2. Live run: `GITHUB_TOKEN=$(gh auth token) npx tsx index/scan.ts` → expect `surfaces: ~300+ written, 0 drift events, 0 suppressed` (first run is the baseline by construction — any event on run 1 is a bug).
3. Immediately re-run the scan → any drift events now printed are REAL upstream changes that happened between the two runs (minutes apart, expect 0); investigate every one before commit.
4. Grade diff vs previous `results.json`: `IndexEntry` grades must be untouched by D2 (only `stats.driftEvents` is new).
5. `git status` shows `index/surfaces/` populated; spot-open 3 snapshot files — hashes only, no description text, no evidence paths.
6. Commit scan artifacts; merge gate is the standard whole-branch adversarial review.
