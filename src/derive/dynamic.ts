// W6 (coverage-v1.5, wave2-spec §1a / Task W6 Part B): the "dynamic tool
// surface" terminal outcome — servers that legitimately have NO static tool
// list because they build it at runtime from upstream servers or a DB.
// Verified: duaraghav8/MCPJungle's internal/service/mcp/proxy.go does
// `AddTool(tool, m.MCPProxyToolCallHandler)` where `tool` comes from
// internal/service/mcp/tool.go's `m.db.Find(&tools)` over a gorm model —
// there is no authored tool list anywhere in the repo. Reporting that as a
// coverage failure ("insufficient data") is dishonest in the OTHER
// direction from a fabricated grade: the correct outcome is a distinct
// terminal state, not a withheld/failed one.
//
// This module is a pure function: no I/O, no network, no file-system access
// — it only classifies data the caller (src/assemble.ts) already fetched,
// and it is called ONLY once every static extractor (manifest/js/py/go/spec
// — NOT the README rung, see assemble.ts's ordering comment) has already
// returned zero tools for this repo.
//
// FIRE IFF: signal A (structural, sufficient alone) OR (signal B AND signal C).
// NEVER signal B alone — measured (wave2-spec, dyn_probe.mjs) 10 of 77 live
// repos match B, at least 7 of which are false: 1mcp-app/agent,
// sitbon/magg, RNVizion/rnv-color-mcp ("Nine deterministic colour tools"),
// Continuum-AI-Corp/orcarouter-mcp-server, Alepha188838884/context-firewall,
// aidc2026ai-melon/aidc-ai-mcp, hostodo/hostodo-mcp — every one of them has a
// real static surface. Only MCPJungle scores A (and, separately, would also
// score B).
import type { RepoFile } from '../collectors/github.js'

// Signal A — structural, REQUIRED unless B&&C. A registration call whose
// FIRST argument is a bare identifier (not a string/template literal — a
// real static registration always names its tool with a literal, see
// JS_TOOL_CALL_RE/PY_IMPERATIVE_RE in schema.ts) together with a
// persistence/deserialize marker, in the SAME DIRECTORY (not necessarily the
// same file — MCPJungle splits these across proxy.go and tool.go).
const DYN_REGISTER_RE = /\b(?:AddTool|AddTools|registerTool|add_tool)\(\s*(?!["'`])[A-Za-z_$][\w$.]*\s*[,)]/
const DYN_PERSIST_RE = /json\.Unmarshal|gorm\.io|\bdb\.(?:Find|First|Where)\(|\.Model\(|prisma\.|SELECT\s+.*\s+FROM/i

// Signal B — weak, NEVER sufficient alone (see the false-positive list
// above). Repo description/topics reading as a gateway/registry/proxy shape.
const DYN_META_RE = /(gateway|registry|aggregat|proxy|hub|router|multiplex|federat)/i

// Signal C — structural corroboration for B. Both a migrations directory AND
// a models/*tool*-shaped source file must be present (the AND is deliberate
// and measured — wave2-spec's own code comment defines C this way; a single
// one of the two is not corroboration enough given B's already-high false
// rate, and the marginal recall of loosening this is ~0 in the measured
// corpus since MCPJungle itself already fires on signal A alone).
const DYN_MIGRATIONS_DIR_RE = /(^|\/)migrations?\//
const DYN_MODEL_TOOL_FILE_RE = /(^|\/)(models?|entity|entities)\/[\w.-]*tool[\w.-]*\.(go|ts|py|js)$/i

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export interface DynamicContext {
  files: RepoFile[]
  // Full repo tree (never truncated by the fetch budget) when available —
  // signal C's migrations-dir / models-file check is a PATH-shape test, so
  // it should see every path GitHub reports, not just the sampled subset.
  // Falls back to the fetched files' own paths when the tree wasn't fetched.
  treePaths?: string[]
  description?: string
  topics?: string[]
}

export interface DynamicResult {
  dynamic: true
  note: string
}

const NOTE = 'Tools are registered at runtime from upstream servers; no static list exists. Health/reliability signals shown; no trust grade issued.'

/**
 * Fires ONLY on signal A alone, or (signal B AND signal C) together. Never on
 * B alone. The caller is responsible for only invoking this once every
 * static tool extractor has already returned zero tools for this repo.
 */
export function detectDynamic(ctx: DynamicContext): DynamicResult | null {
  const registerDirs = new Set(ctx.files.filter(f => DYN_REGISTER_RE.test(f.content)).map(f => dirOf(f.path)))
  const persistDirs = new Set(ctx.files.filter(f => DYN_PERSIST_RE.test(f.content)).map(f => dirOf(f.path)))
  const signalA = [...registerDirs].some(dir => persistDirs.has(dir))
  if (signalA) return { dynamic: true, note: NOTE }

  const metaText = `${ctx.description ?? ''} ${(ctx.topics ?? []).join(' ')}`
  const signalB = DYN_META_RE.test(metaText)
  if (!signalB) return null

  const paths = ctx.treePaths ?? ctx.files.map(f => f.path)
  const signalC = paths.some(p => DYN_MIGRATIONS_DIR_RE.test(p)) && paths.some(p => DYN_MODEL_TOOL_FILE_RE.test(p))
  if (!signalC) return null

  return { dynamic: true, note: NOTE }
}
