import { encode } from 'gpt-tokenizer'
import type { RepoFile } from '../collectors/github.js'
import type { Finding, ToolInfo } from '../types.js'
import { fromGoSource } from './lang/go.js'

export interface SchemaResult {
  extracted: boolean
  tools: ToolInfo[]
  toolSurfaceRisk: 'none' | 'low' | 'medium' | 'high' | undefined
  schemaTokenEstimate: number | undefined
  findings: Finding[]
}

type Risk = 'none' | 'low' | 'medium' | 'high'
const RISK_ORDER: Risk[] = ['none', 'low', 'medium', 'high']

// Fix (P4): the old classifier tested these as UNANCHORED SUBSTRINGS over
// name+description+schemaText, so `exec` matched inside the noun "execution"
// (get_execution_status → high) and `drop` matched inside "dropdown"
// (list_dropdown_options → medium), while genuinely risky tools with no
// substring hit (edit_file, run_notebook, bash_command, run_python,
// fork_repository) fell through to 'none'. Fixed by:
//  - tokenizing the tool NAME on `_`/camelCase and matching token-SET
//    membership (exact equality, never substring) — the strong signal.
//  - matching the free-text (description + schemaText) with `\b`-anchored
//    word regexes — catches a real word ("delete") without matching inside
//    an unrelated word ("dropdown").
// Overall per-tool risk is the max of the two; overall server risk is the
// max across all tools (unchanged).
//
// Fix (P4 review): `run` and `code` as bare standalone HIGH tokens were
// themselves too ambiguous — they over-tiered zip_code_lookup,
// area_code_finder, run_report, run_query to HIGH, and tiered benign prose
// ("status code", "runs in the background") HIGH too. Both are removed from
// HIGH_TOKENS; the unambiguous HIGH tokens (exec, execute, spawn, eval,
// shell, bash, terminal, sh, python, interpreter, notebook, command, cmd)
// stay put. `run`/`code` are re-admitted to HIGH only via the co-occurrence
// rule below, which requires an execution-shaped token AND a code/script-
// shaped token inside the SAME token group (i.e. the same compound
// identifier, like `run_code` or `execute_script`) — not merely present
// somewhere in a longer sentence. That's what keeps "status code ... of the
// run" (unrelated words in one sentence) from tripping the rule while still
// catching `run_code`.
const HIGH_TOKENS = new Set([
  'exec', 'execute', 'spawn', 'eval', 'shell', 'bash', 'terminal', 'sh',
  'python', 'interpreter', 'notebook', 'command', 'cmd',
])
// 'fork' isn't in the plan's literal MEDIUM list, but is required to
// correctly tier `fork_repository` (forking duplicates/creates a repo — a
// create-like mutation, not a process-fork/spawn, hence MEDIUM not HIGH).
const MEDIUM_TOKENS = new Set([
  'write', 'delete', 'remove', 'unlink', 'rm', 'drop', 'edit', 'create',
  'update', 'modify', 'put', 'patch', 'append', 'upload', 'move', 'rename',
  'overwrite', 'push', 'merge', 'fork',
])
const LOW_TOKENS = new Set([
  'fetch', 'http', 'request', 'url', 'download', 'get', 'read', 'list',
  'search', 'query',
])
// child_process/subprocess are identifiers (module names), not English
// words a tool-namer would choose — checked directly against the free text
// rather than folded into HIGH_TOKENS, per the plan's "(+ child_process/
// subprocess appearing in text)" addendum. Unaffected by the tokenization
// fix below: these are single compound identifiers with no ambiguous
// standalone-word reading, so a `\b`-anchored match on the raw text is fine.
const SHELL_MODULE_RE = /\bchild_process\b|\bsubprocess\b/i

// Fix (final review): schemaText is the serialized inputSchema — i.e.
// PARAMETER NAMES, not prose a human wrote to describe what the tool does.
// Applying the full HIGH/MEDIUM/LOW vocabulary there produced false positives
// on entirely benign tools: a `command` string parameter on `get_config`
// (HIGH, "executes commands") or an `update_frequency`/`create_time` param
// (MEDIUM, "write"/"create") — because those are substrings/tokens that mean
// something very different as a schema property name than as a verb in a
// description. schemaText is instead scanned with a STRONG, unambiguous
// process-execution-only subset: these tokens (plus the existing shell-module
// text checks) are never legitimate parameter-name fragments for a benign
// tool, so a hit there is real signal. No MEDIUM/LOW tier and none of the
// softer HIGH tokens (command, python, run, code, notebook, interpreter,
// terminal, cmd) apply to this channel — those are common enough as innocuous
// property names (command palette, python_version, run_id, area_code) that
// they're only trustworthy signal in the name/description channel.
const STRONG_EXEC_TOKENS = new Set([
  'exec', 'execute', 'spawn', 'shell', 'bash', 'eval', 'sh', 'subprocess', 'childprocess',
])
const SCHEMA_TEXT_SHELL_RE = /\bchild_process\b|os\.system\(|\bexecSync\b|\bspawnSync\b/i

// schemaText-only classifier: 'high' on a strong exec signal, else 'none'.
// Tokenized the same way as riskFromText (per whitespace-delimited word, then
// split on non-alnum/camelCase) so `shell_exec(cmd)` still matches even
// though it's not English prose.
function riskFromSchemaText(schemaText: string): Risk {
  if (SCHEMA_TEXT_SHELL_RE.test(schemaText) || SHELL_MODULE_RE.test(schemaText)) return 'high'
  for (const word of schemaText.split(/\s+/)) {
    if (!word) continue
    for (const tok of tokenize(word)) {
      if (STRONG_EXEC_TOKENS.has(tok)) return 'high'
    }
  }
  return 'none'
}

// Co-occurrence re-admission for the demoted `run`/`code` tokens: both an
// execution-shaped token and a code/script-shaped token must appear in the
// SAME token group (the tokens produced by splitting one identifier/word) —
// e.g. `run_code` → ['run','code'] both present → HIGH; `execute_script` →
// ['execute','script'] both present → HIGH (redundant with 'execute' already
// being a direct HIGH token, but harmless). `run_report` → ['run','report']
// only one side present → no elevation.
const RUN_LIKE_TOKENS = new Set(['run', 'exec', 'execute', 'eval', 'invoke'])
const CODE_LIKE_TOKENS = new Set(['code', 'script'])
function hasRunCodeCoOccurrence(tokens: string[]): boolean {
  let hasRun = false
  let hasCode = false
  for (const tok of tokens) {
    if (RUN_LIKE_TOKENS.has(tok)) hasRun = true
    else if (CODE_LIKE_TOKENS.has(tok)) hasCode = true
    if (hasRun && hasCode) return true
  }
  return false
}

// Splits text on `_`/`-`/`.`/whitespace/other non-alphanumeric characters and
// camelCase boundaries into lowercase tokens, e.g. "runPython" / "run_python"
// both → ["run","python"]. Used for the tool NAME and, per-word, for the
// free-text channel (description + schemaText) — see riskFromText.
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean)
}

// Shared tier logic over an already-tokenized group: the co-occurrence rule
// first (it can only elevate to 'high'), then plain token-SET membership
// (exact equality, never substring).
function riskFromTokens(tokens: string[]): Risk {
  if (hasRunCodeCoOccurrence(tokens)) return 'high'
  let worst: Risk = 'none'
  for (const tok of tokens) {
    if (HIGH_TOKENS.has(tok)) return 'high' // can't exceed high; short-circuit
    if (MEDIUM_TOKENS.has(tok)) worst = 'medium'
    else if (LOW_TOKENS.has(tok) && worst === 'none') worst = 'low'
  }
  return worst
}

function riskFromName(name: string): Risk {
  return riskFromTokens(tokenize(name))
}

// Fix (P4 review): the previous `\b`-anchored word-regex match on the raw
// description treated `_` as a word character, so `\bshell\b` never matched
// inside `shell_exec` — a snake_case mention sailed through undetected.
// Fixed by tokenizing the free text with the SAME tokenizer used for the name
// (so `_`/camelCase boundaries split it) and matching token-SET membership.
// The text is walked one whitespace-delimited word at a time (not tokenized
// as one flat bag) so the co-occurrence rule only fires when run-like and
// code-like tokens come from the SAME compound word — "shell_exec" (one
// word) co-occurs; "status code ... of the run" (run/code as separate,
// unrelated words in a sentence) does not. Single-token HIGH/MEDIUM/LOW
// matches ("delete", "shell") still work anywhere in the text since every
// word is checked. `execution`/`dropdown` stay safe: neither is itself a
// member of any token set.
//
// Fix (final review): this is now the DESCRIPTION-only channel (human prose
// about what the tool does). schemaText (inputSchema property names) has its
// own STRONG-only channel below — see riskFromSchemaText — because a
// parameter name like `command` or `update_frequency` isn't a claim about
// tool behavior the way a description sentence is.
function riskFromText(text: string): Risk {
  if (SHELL_MODULE_RE.test(text)) return 'high'
  let worst: Risk = 'none'
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const risk = riskFromTokens(tokenize(word))
    if (risk === 'high') return 'high'
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst)) worst = risk
  }
  return worst
}

// NAME is the strong signal (token-set, exact match); DESCRIPTION is
// corroborating free text (full HIGH/MEDIUM/LOW vocabulary, tokenized the
// same way, per word); SCHEMATEXT (serialized inputSchema / property names)
// is classified separately with only the strong process-execution subset —
// see riskFromSchemaText for why. Any of the three can independently
// establish a tier; the tool's overall risk is the max of all three.
function classify(name: string, description: string, schemaText: string): Risk {
  const nameRisk = riskFromName(name)
  const textRisk = riskFromText(description)
  const schemaRisk = riskFromSchemaText(schemaText)
  let worst = nameRisk
  if (RISK_ORDER.indexOf(textRisk) > RISK_ORDER.indexOf(worst)) worst = textRisk
  if (RISK_ORDER.indexOf(schemaRisk) > RISK_ORDER.indexOf(worst)) worst = schemaRisk
  return worst
}

// Fix 5: paths that aren't part of the shipped server — test fixtures, example
// snippets, and docs source — commonly define fake/sample "tools" that would
// otherwise fabricate cost/security signals for framework and SDK repos.
// V2 (coverage-spec §3.1/§4): added `samples` — csharp-sdk ships its example
// servers under samples/** rather than examples/**; without this, signal #2
// (idiom-only-in-excluded-paths) would misread csharp-sdk's example-only
// registrations as real tools instead of the library signal they are.
const NON_SERVER_DIR = /(^|\/)(tests|__tests__|examples|docs|docs_src|samples)\//
const NON_SERVER_FILE = /(?:^|\/)[^/]*(?:_test\.[^/]+|\.test\.[^/]+)$/
// Exported for src/derive/classify.ts (V2): classifyLibrary's idiom-only-in-
// excluded-paths signal needs the SAME notion of "not part of the shipped
// server" that extractSchema itself filters on, so the two can never drift.
export function isNonServerPath(path: string): boolean {
  return NON_SERVER_DIR.test(path) || NON_SERVER_FILE.test(path)
}

// Scans from `openIdx` (which must point at `openCh`) and returns the
// substring through the matching `closeCh`, honoring nesting depth. Used to
// pull a whole `{...}`/`(...)` literal out of source text without a real
// parser. Bounded by `maxLen` so a malformed/huge file can't force a long scan.
// Exported for src/derive/lang/go.ts (V3): the Go idioms need the same
// balanced-brace/paren capture (composite `mcp.Tool{...}` literals, nested
// `NewTool(...)`/`WithDescription(...)` calls) rather than a second,
// drifting copy of the scanner.
export function captureBalanced(text: string, openIdx: number, openCh: string, closeCh: string, maxLen = 4000): string {
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
// the legacy `server.tool("name", "description", ...)` form. V4 (coverage-
// spec §3.4 TS #1): also match fastmcp's `.addTool("name", ...)` — same
// quoted-first-arg method-call shape, so it flows through the existing
// config-object description fallback below for free.
const JS_TOOL_CALL_RE = /\.(?:registerTool|tool|addTool)\(\s*["'`]([\w.-]+)["'`]\s*(?:,\s*["'`]([^"'`]*)["'`])?/g

// V4 #1/#4 (coverage-spec §3.4 TS): metatool/sentry's `defineTool(...)` is
// usually called bare (an imported function, not a method), so it needs its
// own alternation rather than living in JS_TOOL_CALL_RE's `\.`-anchored
// form. This single regex covers both the "add a bare-call form for
// defineTool" extension from #1 and the positional name+description form
// from #4 (`defineTool("run_workflow", "Runs a saved workflow")`) —
// description is optional so a name-only call still extracts.
const DEFINE_TOOL_CALL_RE = /\bdefineTool\(\s*["'`]([\w-]+)["'`]\s*(?:,\s*["'`]([^"'`]*)["'`])?/g

// V4 #2 (coverage-spec §3.4 TS): object-literal FIRST arg — fastmcp
// `server.addTool({name,...})`, sentry `defineTool({name:...})`. Distinct
// from JS_TOOL_CALL_RE's config-object fallback (which fires on the SECOND
// arg, after an already-quoted name as arg 1): here there is no quoted name
// at the call site at all, the whole tool is described by the object.
const OBJECT_ARG_CALL_RE = /\b(?:addTool|defineTool)\(\s*\{/g

// V4 #3 (coverage-spec §3.4 TS): keyed-factory — supabase's
// `list_organizations: tool({...})`, where the object KEY (not a string
// literal anywhere in the call) is the tool name. This shape is
// indistinguishable from an arbitrary `foo: bar({...})` object property by
// regex alone, so it is gated by MCP_UTILS_TOOL_IMPORT_RE / GET_TOOLS_FN_RE
// below — it never fires unqualified (see the guard in fromJsSource).
const KEYED_FACTORY_RE = /([\w-]+)\s*:\s*tool\(/g
const MCP_UTILS_TOOL_IMPORT_RE = /import\s*\{[^}]*\btool\b[^}]*\}\s*from\s*["'][^"']*mcp-utils[^"']*["']/
const GET_TOOLS_FN_RE = /(?:function\s+(get\w*Tools)\s*\([^)]*\)\s*\{|(?:export\s+)?(?:const|let)\s+(get\w*Tools)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{)/g

// V4 #5 (coverage-spec §3.4 TS): class-based tool (mongodb) — a class
// extending some `*Tool*Base` whose body sets `name`/`toolName` and
// `description` instance fields rather than passing them to a call.
const CLASS_TOOL_RE = /class\s+\w+\s+extends\s+[\w.]*Tool[\w.]*Base\b[^{]*\{/g
const CLASS_NAME_FIELD_RE = /(?:static\s+)?(?:toolName|name)\s*=\s*["'`]([\w-]+)["'`]/
const CLASS_DESC_FIELD_RE = /(?:public\s+)?description\s*=\s*["'`]([^"'`]*)["'`]/

// V4 #6 (coverage-spec §3.4 TS): wrapper member-expression name (cloudflare)
// — `server.accountTool(NAME_MAP.key, {...})`. The name isn't a string
// literal at the call site; resolveWrapperName below resolves it via a
// sibling `const NAME_MAP = { key: 'literal' }` map when one exists, else
// falls back to the raw identifier text.
const WRAPPER_TOOL_CALL_RE = /\.\w*[Tt]ool\(\s*([A-Z_][\w.]*)\s*,\s*\{/g

// V4 #7 (coverage-spec §3.4 TS): the ListToolsRequestSchema sibling-check
// scan below is also the right shape for discogs-style FastMCP object
// literals that never funnel through a single quoted-name call site (a
// `tools = [{name, parameters, ...}]` array iterated into `.addTool(t)`).
// Trigger the scan whenever the file imports fastmcp too, not only when
// ListToolsRequestSchema is present.
const FASTMCP_IMPORT_RE = /['"]fastmcp['"]/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// V4 #3 helper: spans (start/end index of the `{...}` body) of every
// `function getXTools(...) { ... }` / `const getXTools = (...) => { ... }`
// declaration in the file, so the keyed-factory guard can check whether a
// given match position falls inside one of the supabase/cloudflare
// `getXTools()` factory-function bodies.
function findGetToolsFnSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const m of content.matchAll(GET_TOOLS_FN_RE)) {
    const braceIdx = m.index + m[0].length - 1
    const body = captureBalanced(content, braceIdx, '{', '}')
    if (body) spans.push([braceIdx, braceIdx + body.length - 1])
  }
  return spans
}

// V4 #6 helper: resolves a captured wrapper identifier (e.g. `TOOLS.list`)
// to the string literal it points at, via a sibling `const TOOLS = { list:
// 'accounts_list' }` map. Falls back to the raw identifier when there's no
// dotted member access, no matching const map, or the key isn't a string
// literal in that map — "accept the identifier as the name" per spec.
function resolveWrapperName(content: string, ident: string): string {
  const dotIdx = ident.indexOf('.')
  if (dotIdx === -1) return ident
  const objectName = ident.slice(0, dotIdx)
  const key = ident.slice(dotIdx + 1)
  const mapMatch = new RegExp(`\\bconst\\s+${escapeRegExp(objectName)}\\s*(?::[^=]+)?=\\s*\\{`).exec(content)
  if (!mapMatch) return ident
  const braceIdx = mapMatch.index + mapMatch[0].length - 1
  const body = captureBalanced(content, braceIdx, '{', '}')
  const keyMatch = body.match(new RegExp(`\\b${escapeRegExp(key)}\\s*:\\s*["'\`]([\\w.-]+)["'\`]`))
  return keyMatch ? keyMatch[1] : ident
}

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

// Exported for src/derive/classify.ts (V2): signal #2 (idiom-only-in-
// excluded-paths) needs to run the SAME idiom detectors extractSchema uses,
// over the FULL (unfiltered-by-path) file set, so it can tell "an idiom
// exists but only under examples/" apart from "no idiom anywhere" — reusing
// these instead of a second, drifting copy of the regexes.
export function fromJsSource(f: RepoFile): ToolInfo[] {
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

  // V4 #1/#4: bare/positional defineTool("name"[, "description"]) — the
  // dot-anchored JS_TOOL_CALL_RE above can't see this since it's usually an
  // imported function, not a method call.
  for (const m of f.content.matchAll(DEFINE_TOOL_CALL_RE)) {
    if (tools.some(t => t.name === m[1])) continue
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }

  // V4 #2: object-literal first arg — addTool({name,...}) / defineTool({name}).
  for (const m of f.content.matchAll(OBJECT_ARG_CALL_RE)) {
    const braceIdx = m.index + m[0].length - 1
    const obj = captureBalanced(f.content, braceIdx, '{', '}')
    const nameMatch = obj.match(/\bname\s*:\s*["'`]([\w.-]+)["'`]/)
    if (!nameMatch) continue
    if (tools.some(t => t.name === nameMatch[1])) continue
    const descMatch = obj.match(/\bdescription\s*:\s*["'`]([^"'`]*)["'`]/)
    tools.push({ name: nameMatch[1], description: descMatch?.[1], schemaText: m[0] + obj })
  }

  // V4 #3: keyed-factory `key: tool({...})` — the object KEY is the tool
  // name. Guarded: only runs when `tool` is imported from an *mcp-utils*
  // module, or (checked per-match) the match sits inside a `getXTools()`
  // factory function body — never on an arbitrary `foo: bar({...})`.
  if (MCP_UTILS_TOOL_IMPORT_RE.test(f.content) || /get\w*Tools\(/.test(f.content)) {
    const mcpUtilsImport = MCP_UTILS_TOOL_IMPORT_RE.test(f.content)
    const fnSpans = mcpUtilsImport ? [] : findGetToolsFnSpans(f.content)
    for (const m of f.content.matchAll(KEYED_FACTORY_RE)) {
      const insideGetToolsFn = fnSpans.some(([s, e]) => m.index >= s && m.index <= e)
      if (!mcpUtilsImport && !insideGetToolsFn) continue
      if (tools.some(t => t.name === m[1])) continue
      tools.push({ name: m[1], schemaText: m[0] })
    }
  }

  // V4 #5: class-based tool — `class FindTool extends MongoDBToolBase {
  // name = 'find'; description = '...' }`.
  for (const m of f.content.matchAll(CLASS_TOOL_RE)) {
    const braceIdx = m.index + m[0].length - 1
    const body = captureBalanced(f.content, braceIdx, '{', '}')
    const nameMatch = body.match(CLASS_NAME_FIELD_RE)
    if (!nameMatch) continue
    if (tools.some(t => t.name === nameMatch[1])) continue
    const descMatch = body.match(CLASS_DESC_FIELD_RE)
    tools.push({ name: nameMatch[1], description: descMatch?.[1], schemaText: m[0] + body })
  }

  // V4 #6: wrapper member-expression name — `server.accountTool(NAME_MAP.key,
  // {...})`, resolved via a sibling const map (or the raw identifier).
  for (const m of f.content.matchAll(WRAPPER_TOOL_CALL_RE)) {
    const name = resolveWrapperName(f.content, m[1])
    if (tools.some(t => t.name === name)) continue
    tools.push({ name, schemaText: m[0] })
  }

  // Fix 3 / V4 #7: the ListToolsRequestSchema fallback only counts a
  // `name:"x"` when the SAME object literal also has an adjacent
  // `description:`/`inputSchema:`/`parameters:` sibling — this drops
  // logger/config `name:` phantoms AND the `new Server({name})` identity
  // phantom, without losing real tool entries. V4 #7 drops the
  // ListToolsRequestSchema precondition: the same scan now also runs when
  // the file imports fastmcp or calls `.addTool(`, so discogs-shaped
  // FastMCP tool-array object literals are picked up even without an
  // explicit ListToolsRequestSchema handler; the sibling set is broadened to
  // include `parameters:` (fastmcp/zod-style schemas use that key instead of
  // `inputSchema:`).
  if (f.content.includes('ListToolsRequestSchema') || FASTMCP_IMPORT_RE.test(f.content) || f.content.includes('.addTool(')) {
    const SIBLING_RE = /\b(?:description|inputSchema|parameters)\s*:/
    // Fix (idiom 7 false-positive review): resources and prompts share the
    // exact same `{name, description}` shape as tools, and dropping the
    // ListToolsRequestSchema precondition (above) means this scan now runs
    // over the WHOLE file whenever fastmcp is imported or `.addTool(` is
    // called — so without a negative check it fabricates a "tool" for every
    // resource/prompt object too, inflating toolCount and tool-surface risk.
    // A false tool is worse than a miss, so two independent guards reject a
    // candidate before it's accepted:
    const REGISTRATION_KEY_RE = /\b(resources|prompts|resourceTemplates|tools)\s*:\s*[[{]/g
    const RESOURCE_SHAPE_RE = /\b(?:uri|uriTemplate|mimeType)\s*:/
    for (const m of f.content.matchAll(/name:\s*["'`]([\w-]+)["'`]/g)) {
      if (tools.some(t => t.name === m[1])) continue
      const span = enclosingObjectSpan(f.content, m.index)
      if (!span) continue
      const objText = f.content.slice(span[0], span[1] + 1)
      if (!SIBLING_RE.test(objText)) continue
      // Guard 1 (registration-key exclusion): find the nearest `<key>: [`/
      // `<key>: {` before the match — if it's `resources:`/`prompts:`/
      // `resourceTemplates:` rather than `tools:`, this object is lexically
      // inside a resource/prompt collection, not a tool one. No match found
      // at all falls through to guard 2.
      let nearestKey: string | undefined
      let nearestKeyIdx = -1
      for (const km of f.content.matchAll(REGISTRATION_KEY_RE)) {
        if (km.index >= m.index) break
        if (km.index > nearestKeyIdx) { nearestKeyIdx = km.index; nearestKey = km[1] }
      }
      if (nearestKey && nearestKey !== 'tools') continue
      // Guard 2 (resource-shape exclusion): tools never carry uri/
      // uriTemplate/mimeType fields — those are resource/prompt-specific.
      if (RESOURCE_SHAPE_RE.test(objText)) continue
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

export function fromPySource(f: RepoFile): ToolInfo[] {
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
// Fix (P7 review): P7 added lockfiles (package-lock.json/uv.lock/poetry.lock)
// to the fetched-file set. Those are DATA, not source — a manifest/lockfile
// merely recording the ubiquitous transitive npm dep `cross-spawn` (its name
// alone contains "spawn") is not evidence the repo imports a shell-exec API.
// Restrict the floor scan to files that are actual source code so a
// committed lockfile/package.json/*.toml can never trip it.
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs)$/i
function findShellImportFile(files: RepoFile[]): RepoFile | undefined {
  return files.find(f => SRC_EXT.test(f.path) && SHELL_IMPORT_RE.test(f.content))
}

export function extractSchema(files: RepoFile[]): SchemaResult {
  const serverFiles = files.filter(f => !isNonServerPath(f.path))
  const manifest = serverFiles.filter(f => /(^|\/)(mcp|server)\.json$/.test(f.path))
  const js = serverFiles.filter(f => /\.(ts|js|mjs)$/.test(f.path))
  const py = serverFiles.filter(f => f.path.endsWith('.py'))
  // V3 (coverage-spec §3.2): Go is its own bucket in the ladder, tried after
  // manifest/js/py so it never changes precedence for the already-graded
  // JS/Python servers (those extensions are disjoint from .go, so in practice
  // this only ever fires for repos where manifest/js/py found nothing).
  const go = serverFiles.filter(f => f.path.endsWith('.go'))

  let tools: Array<ToolInfo & { evidence: string }> = []
  for (const level of [
    () => manifest.flatMap(f => fromManifest(f).map(t => ({ ...t, evidence: f.path }))),
    () => js.flatMap(f => fromJsSource(f).map(t => ({ ...t, evidence: f.path }))),
    () => py.flatMap(f => fromPySource(f).map(t => ({ ...t, evidence: f.path }))),
    () => go.flatMap(f => fromGoSource(f).map(t => ({ ...t, evidence: f.path }))),
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
    const risk = classify(t.name, t.description ?? '', t.schemaText)
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
