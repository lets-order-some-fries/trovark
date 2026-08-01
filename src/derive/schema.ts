import { encode } from 'gpt-tokenizer'
import type { RepoFile } from '../collectors/github.js'
import type { Finding, ToolInfo } from '../types.js'

export interface SchemaResult {
  extracted: boolean
  tools: ToolInfo[]
  toolSurfaceRisk: 'none' | 'low' | 'medium' | 'high' | undefined
  schemaTokenEstimate: number | undefined
  findings: Finding[]
}

type Risk = 'none' | 'low' | 'medium' | 'high'
const RISK_ORDER: Risk[] = ['none', 'low', 'medium', 'high']

const HIGH = /exec|spawn|shell|child_process|subprocess|os\.system|eval\(/i
const MEDIUM = /write|delete|remove|unlink|\brm\b|drop/i
const LOW = /fetch|http|request|url|download/i

function classify(text: string): Risk {
  if (HIGH.test(text)) return 'high'
  if (MEDIUM.test(text)) return 'medium'
  if (LOW.test(text)) return 'low'
  return 'none'
}

// Fix 5: paths that aren't part of the shipped server — test fixtures, example
// snippets, and docs source — commonly define fake/sample "tools" that would
// otherwise fabricate cost/security signals for framework and SDK repos.
const NON_SERVER_DIR = /(^|\/)(tests|__tests__|examples|docs|docs_src)\//
const NON_SERVER_FILE = /(?:^|\/)[^/]*(?:_test\.[^/]+|\.test\.[^/]+)$/
function isNonServerPath(path: string): boolean {
  return NON_SERVER_DIR.test(path) || NON_SERVER_FILE.test(path)
}

// Scans from `openIdx` (which must point at `openCh`) and returns the
// substring through the matching `closeCh`, honoring nesting depth. Used to
// pull a whole `{...}`/`(...)` literal out of source text without a real
// parser. Bounded by `maxLen` so a malformed/huge file can't force a long scan.
function captureBalanced(text: string, openIdx: number, openCh: string, closeCh: string, maxLen = 4000): string {
  if (text[openIdx] !== openCh) return ''
  let depth = 0
  const end = Math.min(text.length, openIdx + maxLen)
  for (let i = openIdx; i < end; i++) {
    if (text[i] === openCh) depth++
    else if (text[i] === closeCh) {
      depth--
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return text.slice(openIdx, end)
}

// Finds the smallest `{...}` object literal that encloses `pos` (e.g. the
// position of a `name:` match), by walking backward to the nearest unmatched
// `{` and then forward to its matching `}`.
function enclosingObjectSpan(text: string, pos: number): [number, number] | undefined {
  let depth = 0
  let start = -1
  for (let i = pos; i >= 0; i--) {
    if (text[i] === '}') depth++
    else if (text[i] === '{') {
      if (depth === 0) { start = i; break }
      depth--
    }
  }
  if (start === -1) return undefined
  depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return [start, i]
    }
  }
  return undefined
}

function fromManifest(f: RepoFile): ToolInfo[] {
  try {
    const doc = JSON.parse(f.content) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> }
    if (!Array.isArray(doc.tools)) return []
    return doc.tools
      .filter((t): t is { name: string; description?: string; inputSchema?: unknown } => typeof t.name === 'string')
      .map(t => ({ name: t.name, description: t.description, schemaText: JSON.stringify(t) }))
  } catch { return [] }
}

// Fix 1: modern high-level SDK `server.registerTool("name", {...})` alongside
// the legacy `server.tool("name", "description", ...)` form.
const JS_TOOL_CALL_RE = /\.(?:registerTool|tool)\(\s*["'`]([\w.-]+)["'`]\s*(?:,\s*["'`]([^"'`]*)["'`])?/g

// Fix 4: low-level SDK `Tool(...)`/`types.Tool(...)` constructor literals
// (JS positional-object and Python kwargs both land here — the captured args
// text is searched for `name`/`description` regardless of `:` vs `=`).
function fromLowLevelToolCalls(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(/\b(?:new\s+)?(?:types\.)?Tool\(/g)) {
    const openIdx = m.index + m[0].length - 1
    const call = captureBalanced(content, openIdx, '(', ')')
    if (!call) continue
    const nameMatch = call.match(/name\s*[:=]\s*["'`]([\w-]+)["'`]/)
    if (!nameMatch) continue
    const descMatch = call.match(/description\s*[:=]\s*["'`]([^"'`]*)["'`]/)
    tools.push({ name: nameMatch[1], description: descMatch?.[1], schemaText: m[0] + call })
  }
  return tools
}

function fromJsSource(f: RepoFile): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of f.content.matchAll(JS_TOOL_CALL_RE)) {
    const afterName = m.index + m[0].length
    let schemaText = m[0]
    let description = m[2]
    // registerTool's second arg is typically a config object, not a bare
    // string — pull it in so a description like "Execute a shell command"
    // buried in the config is still visible to classify().
    if (description === undefined) {
      const skip = /^\s*,?\s*/.exec(f.content.slice(afterName))
      const objStart = afterName + (skip ? skip[0].length : 0)
      if (f.content[objStart] === '{') {
        const obj = captureBalanced(f.content, objStart, '{', '}')
        schemaText += obj
        const descMatch = obj.match(/description\s*:\s*["'`]([^"'`]*)["'`]/)
        if (descMatch) description = descMatch[1]
      }
    }
    tools.push({ name: m[1], description, schemaText })
  }

  // Fix 3: the ListToolsRequestSchema fallback only counts a `name:"x"` when
  // the SAME object literal also has an adjacent `description:`/`inputSchema:`
  // sibling — this drops logger/config `name:` phantoms AND the
  // `new Server({name})` identity phantom, without losing real tool entries.
  if (f.content.includes('ListToolsRequestSchema')) {
    const SIBLING_RE = /\b(?:description|inputSchema)\s*:/
    for (const m of f.content.matchAll(/name:\s*["'`]([\w-]+)["'`]/g)) {
      if (tools.some(t => t.name === m[1])) continue
      const span = enclosingObjectSpan(f.content, m.index)
      if (!span) continue
      const objText = f.content.slice(span[0], span[1] + 1)
      if (!SIBLING_RE.test(objText)) continue
      tools.push({ name: m[1], schemaText: objText })
    }
  }

  for (const t of fromLowLevelToolCalls(f.content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  return tools
}

// Fix 2: Python imperative registration forms — `self.tool(name="x")`,
// `mcp.add_tool(name="x")` — plus bare `@mcp.tool` decorators (no parens),
// tolerating a decorator that's separated from its `def` by other decorators,
// comments, or blank lines.
const PY_DECORATOR_RE = /@(?:\w+\.)?tool\b(?:\([^)]*\))?[\s\S]{0,200}?\b(?:async\s+)?def\s+(\w+)\s*\(/g
const PY_IMPERATIVE_RE = /\b(?:add_tool|tool)\(\s*name\s*=\s*["']([\w-]+)["'](?:\s*,\s*description\s*=\s*["']([^"']*)["'])?/g

function fromPySource(f: RepoFile): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of f.content.matchAll(PY_DECORATOR_RE)) {
    tools.push({ name: m[1], schemaText: m[0] })
  }
  for (const m of f.content.matchAll(PY_IMPERATIVE_RE)) {
    if (tools.some(t => t.name === m[1])) continue
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }
  for (const t of fromLowLevelToolCalls(f.content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  return tools
}

// Fix 6: an arbitrary-shell-exec server whose tool schema didn't extract
// (unsupported framework, obfuscated registration, etc.) must not fall through
// to `toolSurfaceRisk: undefined` and let security renormalize onto secrets
// alone. Any fetched file importing a process-execution API floors the risk
// at medium — a defensible conservative floor, not a confident tier.
const SHELL_IMPORT_RE = /\bchild_process\b|\bspawn\b|\bexecSync\b|\bsubprocess\b|os\.system\(/
function findShellImportFile(files: RepoFile[]): RepoFile | undefined {
  return files.find(f => SHELL_IMPORT_RE.test(f.content))
}

export function extractSchema(files: RepoFile[]): SchemaResult {
  const serverFiles = files.filter(f => !isNonServerPath(f.path))
  const manifest = serverFiles.filter(f => /(^|\/)(mcp|server)\.json$/.test(f.path))
  const js = serverFiles.filter(f => /\.(ts|js|mjs)$/.test(f.path))
  const py = serverFiles.filter(f => f.path.endsWith('.py'))

  let tools: Array<ToolInfo & { evidence: string }> = []
  for (const level of [
    () => manifest.flatMap(f => fromManifest(f).map(t => ({ ...t, evidence: f.path }))),
    () => js.flatMap(f => fromJsSource(f).map(t => ({ ...t, evidence: f.path }))),
    () => py.flatMap(f => fromPySource(f).map(t => ({ ...t, evidence: f.path }))),
  ]) {
    tools = level()
    if (tools.length > 0) break
  }

  // Fix 5 (dedup half): the same tool name registered in multiple files (or
  // matched by more than one pattern in the same file) counts once for
  // tool-surface classification and token estimation.
  const seenNames = new Set<string>()
  tools = tools.filter(t => {
    if (seenNames.has(t.name)) return false
    seenNames.add(t.name)
    return true
  })

  if (tools.length === 0) {
    const shellFile = findShellImportFile(files)
    if (shellFile) {
      return {
        extracted: false, tools: [], toolSurfaceRisk: 'medium', schemaTokenEstimate: undefined,
        findings: [{
          id: 'security/shell-import-no-tools', dimension: 'security', severity: 'medium',
          message: 'A fetched file imports a shell/process-execution API but no tool schema could be extracted; tool surface risk is floored at medium so this cannot score a clean security bill on secrets-absence alone.',
          evidence: shellFile.path,
        }],
      }
    }
    return { extracted: false, tools: [], toolSurfaceRisk: undefined, schemaTokenEstimate: undefined, findings: [] }
  }

  const findings: Finding[] = []
  let worst: Risk = 'none'
  for (const t of tools) {
    const risk = classify(`${t.name} ${t.description ?? ''} ${t.schemaText}`)
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst)) worst = risk
    if (risk === 'high') {
      findings.push({
        id: 'security/shell-exec-tool', dimension: 'security', severity: 'high',
        message: `Tool "${t.name}" appears to execute commands or code.`, evidence: t.evidence,
      })
    } else if (risk === 'medium') {
      findings.push({
        id: 'security/destructive-tool', dimension: 'security', severity: 'medium',
        message: `Tool "${t.name}" appears to write or delete data.`, evidence: t.evidence,
      })
    }
  }

  return {
    extracted: true,
    tools: tools.map(({ evidence: _e, ...t }) => t),
    toolSurfaceRisk: worst,
    schemaTokenEstimate: encode(JSON.stringify(tools.map(({ evidence: _e, ...t }) => t))).length,
    findings,
  }
}
