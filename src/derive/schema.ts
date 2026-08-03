import { encode } from 'gpt-tokenizer'
import { SPEC_BASENAME_RE } from '../collectors/github.js'
import type { RepoFile } from '../collectors/github.js'
import type { Finding, ToolInfo } from '../types.js'
import { fromGoSource } from './lang/go.js'
import { fromOpenApi, fromToolDefinitions } from './openapi.js'

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

// Fix (final review, Fix 3): schemaText for a JS-source-extracted candidate
// is the raw captured object-literal source, which includes its own
// code-STRUCTURE property keys (the handler/callback the tool is registered
// with) — not just user-meaningful content. FastMCP's `Tool` shape mandates
// an `execute:` key on every single tool, so `execute` (itself a
// STRONG_EXEC_TOKENS member) tokenized out of that key and flagged EVERY
// tool in a FastMCP-shaped server (e.g. cswkim/discogs-mcp-server) 'high'
// regardless of what the tool actually does. Fixed by stripping these
// structural/handler key positions (each only when immediately followed by
// `:`, i.e. genuinely in key position, not as a free word) before
// tokenizing. Genuine content is untouched: `execSync(`/`child_process`
// (checked separately below), a param named `shell_command`, or `execute`
// appearing anywhere other than immediately before a colon.
const STRUCTURAL_SCHEMA_KEY_RE = /\b(?:execute|handler|callback|run|fn|method|cb|resolve|invoke)\s*:/gi

// schemaText-only classifier: 'high' on a strong exec signal, else 'none'.
// Tokenized the same way as riskFromText (per whitespace-delimited word, then
// split on non-alnum/camelCase) so `shell_exec(cmd)` still matches even
// though it's not English prose.
function riskFromSchemaText(schemaText: string): Risk {
  const cleaned = schemaText.replace(STRUCTURAL_SCHEMA_KEY_RE, '')
  if (SCHEMA_TEXT_SHELL_RE.test(cleaned) || SHELL_MODULE_RE.test(cleaned)) return 'high'
  for (const word of cleaned.split(/\s+/)) {
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

// Fix 3 (review): the bare-top-level-ARRAY branch here was unreachable —
// fromJsonFile always tries fromToolDefinitions (openapi.ts) first, which
// applies an identical/tighter filter to any top-level array before
// fromManifest is ever called with one. Only the `{tools:[...]}` object
// shape is fromManifest's actual job.
type ManifestTool = { name?: unknown; description?: string; inputSchema?: unknown }
function toolsFromManifestDoc(doc: unknown): ManifestTool[] | undefined {
  if (doc && typeof doc === 'object' && Array.isArray((doc as { tools?: unknown }).tools)) {
    return (doc as { tools: ManifestTool[] }).tools
  }
  return undefined
}

function fromManifest(f: RepoFile): ToolInfo[] {
  try {
    const doc = JSON.parse(f.content) as unknown
    const list = toolsFromManifestDoc(doc)
    if (!list) return []
    return list
      .filter((t): t is { name: string; description?: string; inputSchema?: unknown } => typeof t.name === 'string')
      .map(t => ({ name: t.name, description: t.description, schemaText: JSON.stringify(t) }))
  } catch { return [] }
}

// V5 (coverage-spec §3.5): per-.json-file dispatch, tried in order from most
// to least specific — an OpenAPI/Swagger spec, then a bare toolDefinitions
// array, then the {tools:[...]} manifest shape. Only reached for files whose
// basename is in TOOL_JSON_BASENAME_RE (see extractSchema below); package.json
// and other incidental JSON never reach this function at all.
function fromJsonFile(f: RepoFile): ToolInfo[] {
  const openapi = fromOpenApi(f)
  if (openapi.length > 0) return openapi
  const toolDefs = fromToolDefinitions(f)
  if (toolDefs.length > 0) return toolDefs
  return fromManifest(f)
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
// sibling `const NAME_MAP = { key: 'literal' }` map when one exists.
// I6: the callee alternation matched ANY `*Tool(` member call, including
// USES of an already-registered tool (`.callTool(`, `.getTool(`,
// `.removeTool(`, `.hasTool(`) — reviewer verified
// `client.callTool(TOOL_REQUEST, {cursor:1})` published a fake tool named
// `TOOL_REQUEST`. The regex still matches the general `*Tool(` shape (it
// can't distinguish registration verbs from use verbs by shape alone); the
// exclusion is applied in code via WRAPPER_EXCLUDED_METHODS below.
// W3 (coverage-v1.4, R3): widened from [A-Z_][\w.]* to also match a lowercase
// bare identifier — brave's `mcpServer.registerTool(name, {...})` where `name`
// is `export const name = 'brave_web_search'`. WRAPPER_EXCLUDED_METHODS below
// and "unresolvable identifier => emit nothing" (resolveWrapperName) are
// unaffected and still apply to the widened match.
const WRAPPER_TOOL_CALL_RE = /\.(\w*[Tt]ool)\(\s*([A-Za-z_$][\w.$]*)\s*,\s*\{/g
const WRAPPER_EXCLUDED_METHODS = new Set(['callTool', 'getTool', 'removeTool', 'hasTool', 'listTools'])

// V4 #7 (coverage-spec §3.4 TS): the ListToolsRequestSchema sibling-check
// scan below is also the right shape for discogs-style FastMCP object
// literals that never funnel through a single quoted-name call site (a
// `tools = [{name, parameters, ...}]` array iterated into `.addTool(t)`).
// Trigger the scan whenever the file imports fastmcp too, not only when
// ListToolsRequestSchema is present.
const FASTMCP_IMPORT_RE = /['"]fastmcp['"]/

// Coverage-v1.3 review (idiom 7 rewrite): the three POSITIVE containment
// sources a `{name,...}` candidate can be reached from. Each produces a set
// of balanced [start, end] spans (via captureBalanced); a candidate is
// accepted only if its `name:` match falls inside at least one span from at
// least one of the three.
//
// (a) a tool-registration CALL's argument span: `.addTool(`, `.registerTool(`,
// `.tool(`, or bare `defineTool(`. Note this deliberately excludes
// addPrompt/prompt/addResource/addResourceTemplate/resource — those calls'
// argument spans are never scanned, so anything nested inside them (including
// a prompt's own `arguments: [{name,...}]`) is unreachable and rejected.
const REGISTRATION_CALL_ARG_RE = /\.(?:addTool|registerTool|tool)\(|\bdefineTool\(/g
// (b) the VALUE span of a `tools:` key, array- or object-shaped — e.g.
// `{ tools: [{name,...}] }` or a `tools: { ... }` map, at any nesting depth.
const TOOLS_KEY_RE = /\btools\s*:\s*([[{])/g
// (c) an array-literal span assigned to an identifier whose name matches
// /tool/i — e.g. `const toolDefs = [...]`, `const TOOLS = [...]`. This is
// what makes the discogs-style `for (const t of toolDefs) server.addTool(t)`
// pattern work: the per-item `.addTool(t)` call argument is just `t`, so (a)
// alone can't see inside the array — (c) captures the array itself, and
// every object literal in it (however many) is reachable.
const TOOL_NAMED_ARRAY_RE = /\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*\[/g

// (d) W3 (coverage-v1.4, R1 — measured highest single yield, 13 repos/5
// unique): a standalone `const <ident> = {...}` object literal that is
// itself the whole tool, with no wrapping registration call at all in this
// file (browserbase ships one `const actSchema: ToolSchema<...> = {...}` per
// file; the call that registers it lives elsewhere and is never sampled).
// Accepted iff tokenize(ident) includes 'tool'/'tools' OR the type
// annotation matches /\bTool\b|\bTool[A-Z<]/ — the type half is load-bearing:
// `actSchema` tokenizes to ['act','schema'] (no 'tool' token) and is only
// identifiable via `: ToolSchema<typeof ActInputSchema>`.
const TOOL_NAMED_OBJECT_RE = /\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*([^=\n]+?))?\s*=\s*\{/g
const TOOL_TYPE_ANNOTATION_RE = /\bTool\b|\bTool[A-Z<]/

// W3 (R4): a factory function whose body is just `return [ ...tool
// literals... ]` — executeautomation's `createToolDefinitions()`. Gated the
// same way as TOOL_NAMED_ARRAY_RE above (identifier must tokenize to
// tool/tools).
const TOOL_FACTORY_RETURN_RE = /\bfunction\s+(\w+)\s*\([^)]*\)\s*(?::[^{]+?)?\{\s*return\s*\[/g

// W3 (R1 / R5a): siblings that mark a `{name,...}` candidate as tool-shaped —
// used both to gate a TOOL_NAMED_OBJECT_RE span at acceptance time (R1) and,
// further below, to gate an individual `name:` candidate found inside any
// accepted span. `schema`/`inputShape` added for R5a: olostep and figwright
// use those keys instead of `inputSchema`.
const SIBLING_RE = /\b(?:description|inputSchema|parameters|schema|inputShape)\s*:/
// Tools never carry uri/uriTemplate/mimeType fields — those are
// resource/prompt-specific, even for an otherwise-accepted candidate (e.g. a
// stray resource object mixed into a tools array, or an R1 object span that
// turns out to be a resource literal).
const RESOURCE_SHAPE_RE = /\b(?:uri|uriTemplate|mimeType)\s*:/

// (a, extended) Live spot-check regression: discogs-mcp-server (a real
// fastmcp flagship server, not a synthetic test case) never passes an object
// literal to `.addTool(` at all — every tool is a top-level named const
// (`export const searchTool: Tool<...> = { name: 'search', ... }`) registered
// by bare-identifier reference (`server.addTool(searchTool)`). The call's own
// argument span is just the identifier, so rule (a) alone can't see the
// object — without resolving the reference, positive scoping would reject
// 100% of this (very common) idiom's tools. Mirrors resolveWrapperName's
// sibling-const-lookup approach (V4 #6) but for a plain `const IDENT = {...}`
// object declaration instead of a `{ key: 'literal' }` map.
function findConstObjectSpan(content: string, ident: string): [number, number] | undefined {
  const declRe = new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(ident)}\\b\\s*(?::[^=\\n]+)?=\\s*\\{`)
  const m = declRe.exec(content)
  if (!m) return undefined
  const braceIdx = m.index + m[0].length - 1
  const obj = captureBalanced(content, braceIdx, '{', '}')
  if (!obj) return undefined
  return [braceIdx, braceIdx + obj.length - 1]
}

// Computes the accepted-containment spans (a)/(b)/(c) described above for one
// file's content. Returns balanced [start, end] index pairs (inclusive of the
// delimiters); a `name:` match is accepted iff its index falls inside any one
// of them.
function acceptedToolSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []

  for (const m of content.matchAll(REGISTRATION_CALL_ARG_RE)) {
    const openIdx = m.index + m[0].length - 1 // m[0] ends with '('
    const call = captureBalanced(content, openIdx, '(', ')')
    if (!call) continue
    spans.push([openIdx, openIdx + call.length - 1])
    // Bare-identifier argument (e.g. `server.addTool(searchTool)`) — resolve
    // to its declaring top-level object-literal const, if any (see
    // findConstObjectSpan above).
    const argIdent = call.slice(1, -1).trim()
    if (/^[\w$]+$/.test(argIdent)) {
      const declSpan = findConstObjectSpan(content, argIdent)
      if (declSpan) spans.push(declSpan)
    }
  }

  for (const m of content.matchAll(TOOLS_KEY_RE)) {
    const openCh = m[1]
    const closeCh = openCh === '[' ? ']' : '}'
    const openIdx = m.index + m[0].length - 1 // m[0] ends with the open delimiter
    const val = captureBalanced(content, openIdx, openCh, closeCh)
    if (val) spans.push([openIdx, openIdx + val.length - 1])
  }

  for (const m of content.matchAll(TOOL_NAMED_ARRAY_RE)) {
    // Fix (final review): a raw /tool/i SUBSTRING test accepted identifiers
    // like `toolbarItems`/`toolkitConfig`/`MyToolboxOptions` — "tool" is a
    // substring of "toolbar"/"toolkit"/"toolbox" but not the identifier's
    // meaning. Require an identifier-BOUNDARY match instead: tokenize (same
    // tokenizer as risk classification — splits on `_`/`-`/camelCase) and
    // accept only if a token is exactly `tool` or `tools`. `coolTools` still
    // matches (it genuinely contains the token `tools`); `toolbarItems` does
    // not (`toolbar`/`items`, neither is the token `tool(s)`).
    const identTokens = tokenize(m[1])
    if (!identTokens.includes('tool') && !identTokens.includes('tools')) continue
    const openIdx = m.index + m[0].length - 1 // m[0] ends with '['
    const arr = captureBalanced(content, openIdx, '[', ']')
    if (arr) spans.push([openIdx, openIdx + arr.length - 1])
  }

  // (d) W3 (R1): see TOOL_NAMED_OBJECT_RE above. Uses the 400_000 cap (not
  // the 4000 default) — measured live: browserbase's `actSchema`/`session`
  // objects and similar single-tool-per-file consts are small, but nothing
  // caps how large a hand-written tool-config object can get.
  for (const m of content.matchAll(TOOL_NAMED_OBJECT_RE)) {
    const identTokens = tokenize(m[1])
    const typeAnnotation = m[2]
    const tokenMatch = identTokens.includes('tool') || identTokens.includes('tools')
    const typeMatch = typeAnnotation !== undefined && TOOL_TYPE_ANNOTATION_RE.test(typeAnnotation)
    if (!tokenMatch && !typeMatch) continue
    const openIdx = m.index + m[0].length - 1 // m[0] ends with '{'
    const obj = captureBalanced(content, openIdx, '{', '}', 400_000)
    if (!obj) continue
    // Required at span-acceptance time (not just later, per-candidate): a
    // const object that merely tokenizes to 'tool(s)' but carries none of
    // the tool-shaped sibling keys is something else entirely — e.g.
    // cloudflare's `const TOOLS = { list: 'accounts_list', get: '...' }`
    // name-map, which tokenizes to ['tools'] but has no description/schema.
    if (!SIBLING_RE.test(obj)) continue
    if (RESOURCE_SHAPE_RE.test(obj)) continue
    spans.push([openIdx, openIdx + obj.length - 1])
  }

  // (e) W3 (R4): see TOOL_FACTORY_RETURN_RE above. Uses the 400_000 cap —
  // the 4000 default clips executeautomation's 19KB createToolDefinitions()
  // array at ~4 tools instead of all 33.
  for (const m of content.matchAll(TOOL_FACTORY_RETURN_RE)) {
    const identTokens = tokenize(m[1])
    if (!identTokens.includes('tool') && !identTokens.includes('tools')) continue
    const openIdx = m.index + m[0].length - 1 // m[0] ends with '['
    const arr = captureBalanced(content, openIdx, '[', ']', 400_000)
    if (arr) spans.push([openIdx, openIdx + arr.length - 1])
  }

  return spans
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Fix (final review, Fix 2): once a candidate's enclosing span is accepted
// (registration call / tools: value / tool-named array), there was no
// exclusion for a `{name,description}` object nested inside a NON-TOOL
// sub-key of that accepted span — e.g. a param object under
// `inputSchema.properties.<field>`, or an array element under a
// `parameters:` array. The old (deleted) guard explicitly excluded
// properties/arguments for exactly this; positive scoping alone did not
// subsume it. Fixed with a scope-aware (containment-based, not text-index)
// walk: within the accepted span, find each enclosing bracket from the
// candidate's own object outward, and reject if any of them is the value of
// a properties:/arguments:/inputSchema:/parameters: key. Bounded at the
// accepted span's own start (`floor`) so this can never leak across sibling
// statements the way the deleted "nearest preceding key by text index"
// heuristic did.
const EXCLUDED_NESTED_KEYS = new Set(['properties', 'arguments', 'inputschema', 'parameters'])
const BRACKET_CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

// Generalization of enclosingObjectSpan's backward walk to all three bracket
// kinds (`{`, `[`, `(`): scans backward from `pos` and returns the nearest
// unmatched OPENING bracket at or after `floor`, skipping over any balanced
// nested pairs along the way. Returns undefined if none is found before
// `floor` is reached.
function nearestEnclosingBracket(text: string, pos: number, floor: number): { idx: number; open: string } | undefined {
  const stack: string[] = []
  for (let i = pos; i >= floor; i--) {
    const c = text[i]
    if (c === '}' || c === ']' || c === ')') {
      stack.push(c)
    } else if (c === '{' || c === '[' || c === '(') {
      if (stack.length > 0 && BRACKET_CLOSERS[c] === stack[stack.length - 1]) {
        stack.pop()
      } else {
        return { idx: i, open: c }
      }
    }
  }
  return undefined
}

// Looks immediately before `bracketIdx` for the `key:` this bracket is the
// value of (e.g. `properties: {` → 'properties'). Returns undefined when the
// bracket isn't directly preceded by a key — a call's `(`, an array element
// separated by `,`, or a bare top-level declaration's `=`.
function precedingKeyOf(text: string, bracketIdx: number): string | undefined {
  const before = text.slice(Math.max(0, bracketIdx - 100), bracketIdx)
  const m = /([\w$]+)\s*:\s*$/.exec(before)
  return m?.[1]?.toLowerCase()
}

// Walks outward from `objSpan` (the candidate's own enclosing object, as
// returned by enclosingObjectSpan) through each enclosing bracket, stopping
// at `floor` (the accepted span's own start — never walking past it, so this
// can't leak across sibling statements). Returns true if any level along the
// way is the value of an excluded key.
function isNestedUnderExcludedKey(content: string, objSpan: [number, number], floor: number): boolean {
  let pos = objSpan[0]
  while (pos > floor) {
    const bracket = nearestEnclosingBracket(content, pos - 1, floor)
    if (!bracket || bracket.idx <= floor) return false
    const key = precedingKeyOf(content, bracket.idx)
    if (key && EXCLUDED_NESTED_KEYS.has(key)) return true
    pos = bracket.idx
  }
  return false
}

// W3: shared by the literal-name and R1b scalar-name candidate loops in
// fromJsSource below. Given a `name:` match's index, returns its enclosing
// object's source text iff the candidate is tool-shaped (SIBLING_RE),
// reachable from a registration context (acceptedSpans containment,
// honoring the properties:/arguments:/inputSchema:/parameters: nested-key
// exclusion), and not resource/prompt-shaped (RESOURCE_SHAPE_RE) — else
// undefined. Factored out of the single literal-name loop that used to be
// the only caller, so R1b's scalar-identifier loop can reuse the exact same
// acceptance logic instead of a second, drifting copy.
function acceptedCandidateObjectText(
  content: string, matchIndex: number, acceptedSpans: Array<[number, number]>
): string | undefined {
  const span = enclosingObjectSpan(content, matchIndex)
  if (!span) return undefined
  const objText = content.slice(span[0], span[1] + 1)
  if (!SIBLING_RE.test(objText)) return undefined
  if (!acceptedSpans.some(([s, e]) =>
    matchIndex >= s && matchIndex <= e && !isNestedUnderExcludedKey(content, span, s)
  )) return undefined
  if (RESOURCE_SHAPE_RE.test(objText)) return undefined
  return objText
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

// W3 (R1b / R3, shared helper): resolves a same-file scalar const
// declaration (`const IDENT = "literal"`) to its string value. Used both
// when an accepted span's `name:` is an identifier rather than a literal
// (R1b — figwright's `name: PING_TOOL_NAME` alongside `export const
// PING_TOOL_NAME = 'ping'`) and as resolveWrapperName's fallback for a bare,
// non-dotted wrapper identifier (R3 — brave's `registerTool(name, {...})`
// where `name` is `export const name = 'brave_web_search'`). Verified 4/4
// live on figwright: PING_TOOL_NAME->"ping", get-node->"get_node",
// add-page->"add_page", clone-node->"clone_node".
function resolveScalarConst(content: string, ident: string): string | undefined {
  const re = new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(ident)}\\s*(?::[^=\\n]+)?=\\s*["'\`]([^"'\`]+)["'\`]`
  )
  return re.exec(content)?.[1]
}

// V4 #6 helper: resolves a captured wrapper identifier (e.g. `TOOLS.list`)
// to the string literal it points at, via a sibling `const TOOLS = { list:
// 'accounts_list' }` map. I6: no longer falls back to the raw identifier —
// when there's no dotted member access, no matching const map, or the key
// isn't a string literal in that map, returns undefined so the caller emits
// NO tool. A miss beats a garbage name (e.g. `TOOL_NAMES.search` published
// verbatim as a "tool").
// W3 (R3): a bare (non-dotted) identifier no longer falls straight through
// to undefined — it's tried against the R1b scalar-const resolver first
// (brave's plain `registerTool(name, {...})`, no NAME_MAP involved at all).
function resolveWrapperName(content: string, ident: string): string | undefined {
  const dotIdx = ident.indexOf('.')
  if (dotIdx === -1) return resolveScalarConst(content, ident)
  const objectName = ident.slice(0, dotIdx)
  const key = ident.slice(dotIdx + 1)
  const mapMatch = new RegExp(`\\bconst\\s+${escapeRegExp(objectName)}\\s*(?::[^=]+)?=\\s*\\{`).exec(content)
  if (!mapMatch) return undefined
  const braceIdx = mapMatch.index + mapMatch[0].length - 1
  const body = captureBalanced(content, braceIdx, '{', '}')
  const keyMatch = body.match(new RegExp(`\\b${escapeRegExp(key)}\\s*:\\s*["'\`]([\\w.-]+)["'\`]`))
  return keyMatch?.[1]
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
  // {...})`, resolved via a sibling const map. I6: excludes USE verbs
  // (callTool/getTool/removeTool/hasTool/listTools — see
  // WRAPPER_EXCLUDED_METHODS) and emits no tool at all when the identifier
  // can't be resolved (see resolveWrapperName).
  for (const m of f.content.matchAll(WRAPPER_TOOL_CALL_RE)) {
    if (WRAPPER_EXCLUDED_METHODS.has(m[1])) continue
    const name = resolveWrapperName(f.content, m[2])
    if (name === undefined) continue
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
  // Fix (coverage-v1.3 review): the prior version of this scan rejected a
  // `{name,...}` candidate via NEGATIVE guards — "what's the nearest
  // preceding key/call by raw text index?" — with no brace/scope awareness.
  // That silently DROPPED legitimate tools: one tool's `inputSchema.properties`
  // key became the "nearest preceding key" for every later tool in the same
  // array, and an unrelated `.addPrompt(...)` call earlier in the file became
  // the "nearest preceding call" for the entire rest of the tool surface.
  // Losing real tools is worse than the over-extraction the guards were meant
  // to prevent.
  //
  // Replaced with POSITIVE, scope-aware containment: a candidate is accepted
  // only if it is genuinely reachable from a tool-registration context,
  // computed via real brace/paren-balanced spans (not text-index proximity)
  // — see acceptedToolSpans. A resource-shape check (uri/uriTemplate/
  // mimeType) remains as a cheap secondary safety net, applied only to
  // already-accepted candidates. See acceptedCandidateObjectText above.
  //
  // W3 (R5b): entry gate widened. It used to require one of
  // ListToolsRequestSchema / a fastmcp import / a literal '.addTool(' before
  // even computing acceptedSpans — olostep's `.registerTool(` (and, more
  // generally, any file whose ONLY tool evidence is an R1 object-const or an
  // R4 factory array, neither of which implies any of those three strings)
  // matched none of them, so the whole positive-containment scan below never
  // ran even though acceptedToolSpans() was fully capable of finding it.
  // acceptedSpans is now computed unconditionally and its own non-emptiness
  // is the general-purpose gate condition — positive containment already IS
  // the proof that a registration context exists, so the old three checks
  // are logically redundant with it; they're kept (plus the two new literal
  // checks) only as a cheap, harmless short-circuit for the common cases.
  const acceptedSpans = acceptedToolSpans(f.content)
  if (
    f.content.includes('ListToolsRequestSchema') ||
    FASTMCP_IMPORT_RE.test(f.content) ||
    f.content.includes('.addTool(') ||
    f.content.includes('.registerTool(') ||
    f.content.includes('.tool(') ||
    f.content.includes('defineTool(') ||
    acceptedSpans.length > 0
  ) {
    for (const m of f.content.matchAll(/name:\s*["'`]([\w-]+)["'`]/g)) {
      if (tools.some(t => t.name === m[1])) continue
      const objText = acceptedCandidateObjectText(f.content, m.index, acceptedSpans)
      if (objText === undefined) continue
      tools.push({ name: m[1], schemaText: objText })
    }

    // W3 (R1b): `name:` is an identifier rather than a string literal
    // (figwright's `name: PING_TOOL_NAME`) — resolve it via a same-file
    // scalar const. Same acceptance logic (span/sibling/containment/
    // resource-shape) as the literal-name loop above, via
    // acceptedCandidateObjectText; only the name SOURCE differs.
    for (const m of f.content.matchAll(/\bname\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) {
      const resolved = resolveScalarConst(f.content, m[1])
      if (resolved === undefined) continue
      if (tools.some(t => t.name === resolved)) continue
      const objText = acceptedCandidateObjectText(f.content, m.index, acceptedSpans)
      if (objText === undefined) continue
      tools.push({ name: resolved, schemaText: objText })
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

// V5 (coverage-spec §3.4 Python #1): serena's class-subclass idiom —
// `class ReadFileTool(Tool):` / `class DeleteLinesTool(EditingTool):`.
// GUARD (high-FP rule, per plan Global Constraints): the class name must
// end in `Tool` AND the base-class list must mention Tool/EditingTool*/
// BaseTool — an arbitrary `class HelperThing(Base):` matches neither half
// and is never touched by this idiom.
const PY_CLASS_SUBCLASS_RE = /class\s+(\w+Tool)\s*\([^)]*\b(?:Tool|EditingTool\w*|BaseTool)\b[^)]*\)\s*:/g
// Bounded, best-effort lookup of the `apply()` method's docstring first
// line, searched in the window after the class header up to (not
// including) the next top-level `class` — so a docstring picked up here can
// never belong to a different, later class.
const PY_APPLY_DOCSTRING_RE = /def\s+apply\s*\([^)]*\)\s*(?:->[^:]+)?:\s*("""|''')([\s\S]*?)\1/

// serena derives the tool name from the class name by stripping the
// trailing `Tool` suffix and converting CamelCase -> snake_case:
// ReadFileTool -> ReadFile -> read_file; DeleteLinesTool -> DeleteLines -> delete_lines.
function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function findApplyDocstring(content: string, afterIdx: number): string | undefined {
  const rest = content.slice(afterIdx)
  const nextClassIdx = rest.search(/\n(?=class\s)/)
  const window = rest.slice(0, nextClassIdx === -1 ? 4000 : Math.min(nextClassIdx, 4000))
  const m = PY_APPLY_DOCSTRING_RE.exec(window)
  if (!m) return undefined
  return m[2].split('\n').map(l => l.trim()).find(l => l.length > 0)
}

function fromClassSubclass(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(PY_CLASS_SUBCLASS_RE)) {
    const name = camelToSnake(m[1].replace(/Tool$/, ''))
    const description = findApplyDocstring(content, m.index + m[0].length)
    tools.push({ name, description, schemaText: m[0] })
  }
  return tools
}

// V5 (coverage-spec §3.4 Python #2): awslabs' call-decorator idiom —
// `mcp.tool()(docs.search_agentcore_docs)` registers an already-defined
// function object rather than decorating a `def` in place; the tool name is
// the last dotted segment of the referenced identifier.
const PY_CALL_DECORATOR_RE = /\bmcp\.tool\([^)]*\)\(\s*([\w.]+)\s*\)/g

function fromCallDecorator(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(PY_CALL_DECORATOR_RE)) {
    const segments = m[1].split('.')
    tools.push({ name: segments[segments.length - 1], schemaText: m[0] })
  }
  return tools
}

// V5 (coverage-spec §3.4 Python #3): registration-surface SIGNAL, not a
// tool. awslabs-shaped servers register their tool functions via
// `register_search_tools(mcp)` in a file that may not itself contain any of
// the idioms above (the @mcp.tool()-decorated / mcp.tool()(...)-registered
// functions can live in a sibling module that wasn't sampled). This must
// NEVER fabricate a ToolInfo — fromPySource does not call it — it is
// exported solely for src/derive/classify.ts (V2) to treat as an
// "this repo IS MCP-related" signal, so classifyLibrary's signal 3
// (no-MCP-anywhere -> not-server) doesn't fire on such a repo. See the
// wiring in classify.ts.
const PY_REGISTER_TOOLS_SURFACE_RE = /\bregister_\w+_tools\(\s*\w+\s*\)/
export function hasPythonToolRegistrationSurface(files: RepoFile[]): boolean {
  return files.some(f => f.path.endsWith('.py') && PY_REGISTER_TOOLS_SURFACE_RE.test(f.content))
}

export function fromPySource(f: RepoFile): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of f.content.matchAll(PY_DECORATOR_RE)) {
    tools.push({ name: m[1], schemaText: m[0] })
  }
  for (const m of f.content.matchAll(PY_IMPERATIVE_RE)) {
    if (tools.some(t => t.name === m[1])) continue
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }
  for (const t of fromClassSubclass(f.content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  for (const t of fromCallDecorator(f.content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
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

// Only these JSON files are treated as tool sources. A bare `.json` bucket let an
// unrelated "tools" field in package.json fabricate a fake tool surface.
// C3: split into two buckets, tried at OPPOSITE ends of the ladder below.
// mcp.json/server.json/toolDefinitions.json are hand-authored manifests that
// directly declare the server's tool surface — authoritative, so they stay
// FIRST. openapi.json/swagger.json are commonly a VENDORED REST client spec
// (e.g. a generated API client checked in alongside the MCP server) with no
// relationship to the actual MCP tool surface — parsing them first let a
// vendored spec entirely REPLACE a server's real `server.tool()`
// registrations and fabricate security findings from REST operationIds.
// They now run LAST, only when no source extractor (JS/Py/Go) found anything.
// W2 (coverage-v1.4, R7): added `tools` — olostep ships a bare `tools.json`
// manifest. Still a narrow, explicit basename allowlist (never a bare
// `.json` bucket) — package.json's basename is "package", not "tools", so
// the CRITICAL GUARD test above (an unrelated "tools" field in package.json)
// is untouched by this addition.
const MANIFEST_JSON_BASENAME_RE = /^(mcp|server|toolDefinitions|tools)\.json$/i
// W2: imported from src/collectors/github.ts so the fetch-side gate and this
// extraction-side gate can never drift apart — see that file's SPEC_BASENAME_RE
// comment for the full rationale (prefixed/suffixed basenames, YAML handled
// gracefully by JSON.parse failing closed).
const SPEC_JSON_BASENAME_RE = SPEC_BASENAME_RE

export function extractSchema(files: RepoFile[]): SchemaResult {
  const serverFiles = files.filter(f => !isNonServerPath(f.path))
  // Fix (review, Critical): re-scoped from ANY fetched .json file back to a
  // known manifest/spec basename allowlist. The any-.json bucket let an
  // unrelated "tools" field in package.json (fetched for nearly every JS/TS
  // repo) fabricate a fake tool surface via fromManifest's {tools:[...]}
  // shape. mcp.json/server.json (pre-V5 scoping) plus V5's new spec files
  // (openapi.json/swagger.json/toolDefinitions.json) are the only basenames
  // that reach the ladder now.
  const manifestJson = serverFiles.filter(f => MANIFEST_JSON_BASENAME_RE.test(f.path.split('/').pop() ?? ''))
  const specJson = serverFiles.filter(f => SPEC_JSON_BASENAME_RE.test(f.path.split('/').pop() ?? ''))
  const js = serverFiles.filter(f => /\.(ts|js|mjs)$/.test(f.path))
  const py = serverFiles.filter(f => f.path.endsWith('.py'))
  // V3 (coverage-spec §3.2): Go is its own bucket in the ladder, tried after
  // manifest/js/py so it never changes precedence for the already-graded
  // JS/Python servers (those extensions are disjoint from .go, so in practice
  // this only ever fires for repos where manifest/js/py found nothing).
  const go = serverFiles.filter(f => f.path.endsWith('.go'))

  let tools: Array<ToolInfo & { evidence: string }> = []
  for (const level of [
    () => manifestJson.flatMap(f => fromJsonFile(f).map(t => ({ ...t, evidence: f.path }))),
    () => js.flatMap(f => fromJsSource(f).map(t => ({ ...t, evidence: f.path }))),
    () => py.flatMap(f => fromPySource(f).map(t => ({ ...t, evidence: f.path }))),
    () => go.flatMap(f => fromGoSource(f).map(t => ({ ...t, evidence: f.path }))),
    // C3: openapi/swagger LAST — only fires when no manifest and no source
    // extractor found a single tool, so a vendored REST spec can never
    // outrank a server's real tool registrations.
    () => specJson.flatMap(f => fromJsonFile(f).map(t => ({ ...t, evidence: f.path }))),
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
