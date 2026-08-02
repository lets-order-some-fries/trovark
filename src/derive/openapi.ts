// V5 (coverage-spec §3.5): OpenAPI / generated-manifest extractors. Some
// servers ship their tool surface as generated JSON rather than inline
// source — notion's `scripts/notion-openapi.json` (a full OpenAPI 3 spec,
// one operationId per path+method) and sentry's `toolDefinitions.json` (a
// bare top-level array of `{name, description, inputSchema}` — the same
// shape `fromManifest` already reads under a `{tools:[...]}` wrapper, just
// without the wrapper). Both are pure, static JSON parses — no I/O.
import type { RepoFile } from '../collectors/github.js'
import type { ToolInfo } from '../types.js'

interface OpenApiOperation {
  operationId?: unknown
  summary?: unknown
  description?: unknown
}
interface OpenApiDoc {
  openapi?: unknown
  swagger?: unknown
  paths?: Record<string, unknown>
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const

/**
 * `fromOpenApi`: if the JSON parses to an object carrying an `openapi` or
 * `swagger` version key AND a `paths` object, enumerate every
 * `paths.<path>.<get|put|post|delete|patch>.operationId` as a tool name,
 * with `summary || description` as the tool description. Anything else
 * (malformed JSON, no openapi/swagger key, no paths) yields [].
 */
export function fromOpenApi(file: RepoFile): ToolInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(file.content)
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return []
  const d = doc as OpenApiDoc
  if ((d.openapi === undefined && d.swagger === undefined) || !d.paths || typeof d.paths !== 'object') return []

  const tools: ToolInfo[] = []
  for (const [path, methodsRaw] of Object.entries(d.paths)) {
    if (!methodsRaw || typeof methodsRaw !== 'object') continue
    const methods = methodsRaw as Record<string, OpenApiOperation>
    for (const method of HTTP_METHODS) {
      const op = methods[method]
      if (!op || typeof op !== 'object' || typeof op.operationId !== 'string') continue
      const description = typeof op.summary === 'string' ? op.summary : (typeof op.description === 'string' ? op.description : undefined)
      tools.push({ name: op.operationId, description, schemaText: JSON.stringify({ path, method, ...op }) })
    }
  }
  return tools
}

/**
 * `fromToolDefinitions`: a top-level JSON ARRAY of `{name, description,
 * inputSchema}` objects (sentry's toolDefinitions.json shape) -> those
 * tools. Entries missing a string `name` are dropped, not fabricated.
 *
 * Fix 2 (review, Important): a string `name` alone is not enough — ANY
 * top-level array whose entries merely have a `name` field (e.g. a config
 * array `[{name:'dev'}, {name:'staging'}]`) would otherwise pass. An entry
 * only counts if it also has a `description` string OR an `inputSchema`/
 * `parameters` object — some evidence it's actually describing a callable
 * tool, not an arbitrary named record.
 */
export function fromToolDefinitions(file: RepoFile): ToolInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(file.content)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  return doc
    .filter((t): t is { name: string; description?: string; inputSchema?: unknown; parameters?: unknown } => {
      if (!t || typeof t !== 'object' || typeof (t as { name?: unknown }).name !== 'string') return false
      const rec = t as { description?: unknown; inputSchema?: unknown; parameters?: unknown }
      const hasDescription = typeof rec.description === 'string'
      const hasSchema = (typeof rec.inputSchema === 'object' && rec.inputSchema !== null) ||
        (typeof rec.parameters === 'object' && rec.parameters !== null)
      return hasDescription || hasSchema
    })
    .map(t => ({ name: t.name, description: t.description, schemaText: JSON.stringify(t) }))
}
