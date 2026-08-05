import { encode } from 'gpt-tokenizer'
import { SPEC_BASENAME_RE, isToolFanoutPath } from '../collectors/github.js'
import type { RepoFile } from '../collectors/github.js'
import type { Finding, ToolInfo } from '../types.js'
import { fromGoSource } from './lang/go.js'
import { fromOpenApi, fromToolDefinitions } from './openapi.js'

export interface SchemaResult {
  extracted: boolean
  // D1 (integrity-v1, trap #6): evidence (the source file each tool was
  // extracted from) is retained here — D1 (src/derive/integrity.ts) cites it
  // so a tool-surface hit can point at the file it came from. It must NOT
  // leak into schemaTokenEstimate's JSON.stringify (see the return
  // statement below) or every cost score in the index would shift.
  tools: Array<ToolInfo & { evidence: string }>
  toolSurfaceRisk: 'none' | 'low' | 'medium' | 'high' | undefined
  schemaTokenEstimate: number | undefined
  findings: Finding[]
  // W5 (coverage-v1.5, wave2-spec §2.3): true when the full repo tree
  // contains MORE tool-fanout-shaped files than were actually sampled (e.g.
  // figwright's 133 one-tool-per-file modules vs. ~20 reachable under a
  // 24-file cap). assemble.ts reads this and leaves toolCount/
  // schemaTokenEstimate undefined rather than publishing a count derived
  // from a provably incomplete sample — see assemble.ts for the security-
  // stays-graded reasoning (max-risk classification is monotone under
  // sampling, so it is safe to keep grading security on the partial sample).
  surfacePartial: boolean
  // W6 (Task W6 Part A): true when `tools` came from the LAST-rung README
  // catalog extractor (fromReadmeCatalog) rather than any code/manifest/spec
  // source. assemble.ts reads this to keep reliability's schema-parseable
  // signal at its "not verified against source" value even though a list
  // was technically extracted — README prose can drift from the shipped
  // surface in a way a parsed manifest/source file cannot (wave2-spec §3
  // R6). Also used to attach a transparency finding pointing at the README.
  readmeSourced: boolean
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

// FABRICATION FIX (coverage-v1.4, closes a phantom-tool vector that bit
// twice — once against the Go extractor, now against the JS/TS one too):
// every bracket-counting helper below used to count `{ } [ ] ( )` characters
// as raw text, with zero awareness of string literals or comments. A stray
// `}`/`]`/`)` sitting inside a description string desyncs the depth count —
// e.g. `description:'unbalanced } here'` decrements depth one level early,
// so a LATER nested object (`metadata:{name:'phantom',...}`) gets
// mis-measured as sitting at the span's own top level and is fabricated as a
// second, phantom tool. The mirror-image bug also occurs: a stray `{` inside
// a description makes `captureBalanced` return an early, truncated span,
// silently losing whatever real tool data was supposed to follow it.
//
// Fixed with ONE shared lexical-state scanner (`lexSpans` below) that both
// `captureBalanced`/`bracketDepthAt`/`enclosingObjectSpan` (bracket counting)
// and `stripComments` (comment neutralization ahead of all the idiom
// regexes) are built on, so the three counting helpers and the
// comment-safety pass can never drift into disagreeing about what counts as
// real code.
type Lang = 'js' | 'py'
type LexKind = 'code' | 'string' | 'comment'

// The one low-level lexer. Walks `text` over [start, end) and yields
// contiguous [spanStart, spanEnd, kind) runs — 'code' for genuine source,
// 'string' for the interior of a string/template literal (delimiters
// included), 'comment' for a line or block comment (delimiters included).
// Yielding whole runs (not one index at a time) keeps this a single forward
// pass with allocation proportional to the number of tokens, not characters.
//
// Rules (deliberately generic — no per-language branching beyond `lang`):
//  - '...' and "..." — backslash-escaped strings (\\, \', \", ...). Correct
//    for JS/TS string literals and for Go's interpreted "..." strings / rune
//    literals, which also process backslash escapes.
//  - `...` (backtick) — treated as OPAQUE raw text with NO escape
//    processing at all: scanned straight through to the very next backtick,
//    full stop. This is exactly Go's raw-string semantics (no escaping, no
//    interpolation — required for the Go path per the fix spec) and is a
//    deliberate, documented SIMPLIFICATION for JS template literals: `${...}`
//    interpolation is NOT re-entered as code, the whole template is skipped
//    end to end. Trade-off accepted: a bracket meant to close something
//    OUTSIDE the template but typed inside a `${}` expression would also be
//    skipped — never observed in practice for tool name/description text,
//    which is plain string content, not template expressions.
//  - `//...` to end-of-line, and `/* ... */` — line/block comments. Always
//    active; both JS and Go use this syntax and neither uses `#` for
//    anything that would collide with it.
//  - (lang==='py' only) `#...` to end-of-line, and '''...'''/"""..."""
//    triple-quoted strings (also backslash-escape aware). Gated strictly
//    behind lang==='py' so a JS private class field (`#name = 'x'`) is never
//    mistaken for a comment — only Python content ever requests 'py' mode.
function* lexSpans(text: string, start: number, end: number, lang: Lang): Generator<[number, number, LexKind]> {
  let i = start
  while (i < end) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const s = i
      i += 2
      while (i < end && text[i] !== '\n') i++
      yield [s, i, 'comment']
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const s = i
      i += 2
      while (i < end && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(end, i + 2)
      yield [s, i, 'comment']
      continue
    }
    if (lang === 'py' && ch === '#') {
      const s = i
      i++
      while (i < end && text[i] !== '\n') i++
      yield [s, i, 'comment']
      continue
    }
    if (lang === 'py' && (ch === "'" || ch === '"') && text[i + 1] === ch && text[i + 2] === ch) {
      const s = i
      const q = ch
      i += 3
      while (i < end && !(text[i] === q && text[i + 1] === q && text[i + 2] === q)) {
        if (text[i] === '\\') i++
        i++
      }
      i = Math.min(end, i + 3)
      yield [s, i, 'string']
      continue
    }
    if (ch === "'" || ch === '"') {
      const s = i
      const q = ch
      i++
      while (i < end && text[i] !== q) {
        if (text[i] === '\\') i++
        i++
      }
      i = Math.min(end, i + 1)
      yield [s, i, 'string']
      continue
    }
    if (ch === '`') {
      const s = i
      i++
      // No escape processing at all — see the backtick rule above.
      while (i < end && text[i] !== '`') i++
      i = Math.min(end, i + 1)
      yield [s, i, 'string']
      continue
    }
    // Plain code run: consume up to the next character that ACTUALLY starts
    // a string/comment/template span, in either language mode — mirroring
    // the exact conditions checked above. Deliberately NOT "any `/`": a bare
    // `/` that isn't followed by another `/` or `*` (division, a regex
    // literal, a path separator) is ordinary code and must not stop the run,
    // or `i` never advances and this becomes an infinite loop (confirmed
    // live — a single stray `/` anywhere in real source, e.g. `a / b`, spun
    // this forever until `parts.push` in `stripComments` overflowed the
    // array-length limit).
    const s = i
    while (i < end) {
      const c = text[i]
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break
      if (c === "'" || c === '"' || c === '`') break
      if (lang === 'py' && c === '#') break
      i++
    }
    yield [s, i, 'code']
  }
}

// Comment-safety preprocessing pass: returns a copy of `text` with every
// comment span blanked to spaces (embedded newlines preserved so line-based
// reasoning elsewhere is unaffected) while CODE and STRING content — the
// only text callers actually inspect for names/descriptions — passes through
// byte-for-byte. Length- and index-preserving, so every downstream regex
// `.matchAll` index and `captureBalanced`/`enclosingObjectSpan` offset
// computed against the stripped text still lines up with the original.
//
// This is what makes a commented-out registration call
// (`// server.addTool({name:'x'})`) invisible to the idiom regexes: they
// never see the literal text at all once it's been blanked, rather than
// relying on each regex loop to separately re-check "was my match inside a
// comment?".
export function stripComments(text: string, lang: Lang = 'js'): string {
  const parts: string[] = []
  for (const [s, e, kind] of lexSpans(text, 0, text.length, lang)) {
    parts.push(kind === 'comment' ? text.slice(s, e).replace(/[^\n]/g, ' ') : text.slice(s, e))
  }
  return parts.join('')
}

// Scans from `openIdx` (which must point at `openCh`) and returns the
// substring through the matching `closeCh`, honoring nesting depth AND
// lexical state — brackets inside a string literal or comment are ignored,
// so a stray `}`/`]`/`)` in a description can no longer desync the count
// (see the FABRICATION FIX note above `lexSpans`). Used to pull a whole
// `{...}`/`(...)` literal out of source text without a real parser. Bounded
// by `maxLen` so a malformed/huge file can't force a long scan.
// Exported for src/derive/lang/go.ts (V3): the Go idioms need the same
// balanced-brace/paren capture (composite `mcp.Tool{...}` literals, nested
// `NewTool(...)`/`WithDescription(...)` calls) rather than a second,
// drifting copy of the scanner. `lang` defaults to 'js', which is also
// correct for Go source (same comment syntax, same escape-aware quoting,
// backtick treated as an opaque raw string — exactly Go's own semantics).
export function captureBalanced(text: string, openIdx: number, openCh: string, closeCh: string, maxLen = 4000, lang: Lang = 'js'): string {
  if (text[openIdx] !== openCh) return ''
  const end = Math.min(text.length, openIdx + maxLen)
  let depth = 0
  for (const [s, e, kind] of lexSpans(text, openIdx, end, lang)) {
    if (kind !== 'code') continue
    for (let i = s; i < e; i++) {
      const ch = text[i]
      if (ch === openCh) depth++
      else if (ch === closeCh) {
        depth--
        if (depth === 0) return text.slice(openIdx, i + 1)
      }
    }
  }
  return text.slice(openIdx, end)
}

// Finds the smallest `{...}` object literal that encloses `pos` (e.g. the
// position of a `name:` match), by walking forward from the start of the
// file maintaining a stack of unmatched `{` positions (equivalent to, but
// lexically safe unlike, a naive backward scan — string/comment state is
// only well-defined scanning forward) then forward again from the top of
// that stack to the matching `}`. Both passes skip brackets inside strings
// and comments via `lexSpans`.
function enclosingObjectSpan(text: string, pos: number, lang: Lang = 'js'): [number, number] | undefined {
  const stack: number[] = []
  for (const [s, e, kind] of lexSpans(text, 0, pos, lang)) {
    if (kind !== 'code') continue
    for (let i = s; i < e; i++) {
      const ch = text[i]
      if (ch === '{') stack.push(i)
      else if (ch === '}') stack.pop()
    }
  }
  const start = stack.length > 0 ? stack[stack.length - 1] : undefined
  if (start === undefined) return undefined
  let depth = 0
  for (const [s, e, kind] of lexSpans(text, start, text.length, lang)) {
    if (kind !== 'code') continue
    for (let i = s; i < e; i++) {
      const ch = text[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return [start, i]
      }
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

// Fix (final review, Fix 2 — W4 coverage-v1.4 review, Part B): once a
// candidate's enclosing span is accepted (registration call / tools: value /
// tool-named array), there was no exclusion for a `{name,description}`
// object nested inside a NON-TOOL sub-key of that accepted span — e.g. a
// param object under `inputSchema.properties.<field>`, an array element
// under a `parameters:` array, or (reviewer-verified, and the reason this was
// rewritten) an arbitrary `metadata:{name,description}` bag. The original fix
// here was an EXCLUDED_NESTED_KEYS allowlist of 4 literal key names
// (properties/arguments/inputSchema/parameters) — necessarily incomplete,
// since any OTHER key a real codebase happens to nest a sub-object under
// (metadata, config, whatever) was never in the list and still fabricated a
// phantom tool.
//
// Replaced with a principled, SHAPE-based rule instead of an allowlist: a
// candidate is accepted only when its own enclosing object sits at the
// accepted span's OWN top-level — never any deeper, regardless of what key
// the deeper nesting sits under. Concretely, walking forward from the span's
// own opening bracket (`floor`) to the candidate's enclosing object's own
// opening bracket, counting bracket depth along the way:
//  - if the span itself opens with `{` (a resolved const-object arg, an R1
//    object-const, a `tools: {...}` value) — the span IS the tool's own
//    object, so only its OWN direct properties (depth 0, i.e. the
//    candidate's enclosing object literally IS the span) are accepted;
//  - if the span opens with `[` or `(` (a `tools:` array, a tool-named array
//    literal, or a registration call's argument list) — the tool objects are
//    one bracket further in (direct array ELEMENTS, or a call's direct
//    argument), so depth 1 is accepted.
// Anything strictly deeper — `metadata:{name,...}`, `inputSchema.properties.
// <field>`, a `parameters:` array entry — sits at depth ≥2 (object-shaped
// span) or ≥2 (array/call-shaped span) and is rejected, for ANY intervening
// key name. Bounded at the accepted span's own start (`floor`), same as
// before, so this can never leak across sibling statements.
// FABRICATION FIX: this used to count brackets as raw characters over
// [floor, pos), so a stray `}` inside an intervening description STRING
// (e.g. `description:'unbalanced } here'`) decremented depth one level
// early — miscounting a later nested object (`metadata:{...}`) as sitting at
// depth 1 (the span's own tool level) instead of its true depth 2, and
// fabricating it as a phantom tool. Now routed through `lexSpans`, which
// skips brackets inside string literals and comments, so only genuine code
// brackets are counted.
function bracketDepthAt(content: string, floor: number, pos: number, lang: Lang = 'js'): number {
  let depth = 0
  for (const [s, e, kind] of lexSpans(content, floor, pos, lang)) {
    if (kind !== 'code') continue
    for (let i = s; i < e; i++) {
      const c = content[i]
      if (c === '{' || c === '[' || c === '(') depth++
      else if (c === '}' || c === ']' || c === ')') depth--
    }
  }
  return depth
}

function isAtSpanOwnToolLevel(content: string, objSpan: [number, number], floor: number): boolean {
  const targetDepth = content[floor] === '{' ? 0 : 1
  return bracketDepthAt(content, floor, objSpan[0]) === targetDepth
}

// W3: shared by the literal-name and R1b scalar-name candidate loops in
// fromJsSource below. Given a `name:` match's index, returns its enclosing
// object's source text iff the candidate is tool-shaped (SIBLING_RE),
// reachable from a registration context (acceptedSpans containment, honoring
// the depth-based own-tool-level rule above), and not resource/prompt-shaped
// (RESOURCE_SHAPE_RE) — else undefined. Factored out of the single
// literal-name loop that used to be the only caller, so R1b's scalar-
// identifier loop can reuse the exact same acceptance logic instead of a
// second, drifting copy.
function acceptedCandidateObjectText(
  content: string, matchIndex: number, acceptedSpans: Array<[number, number]>
): string | undefined {
  const span = enclosingObjectSpan(content, matchIndex)
  if (!span) return undefined
  const objText = content.slice(span[0], span[1] + 1)
  if (!SIBLING_RE.test(objText)) return undefined
  if (!acceptedSpans.some(([s, e]) =>
    matchIndex >= s && matchIndex <= e && isAtSpanOwnToolLevel(content, span, s)
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
// `lang` is threaded through to `captureBalanced` since this one helper is
// shared by both `fromJsSource` (lang 'js') and `fromPySource` (lang 'py') —
// Python callers need '''/"""-string and `#`-comment awareness too.
function fromLowLevelToolCalls(content: string, lang: Lang = 'js'): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(/\b(?:new\s+)?(?:types\.)?Tool\(/g)) {
    const openIdx = m.index + m[0].length - 1
    const call = captureBalanced(content, openIdx, '(', ')', 4000, lang)
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
  // COMMENT-SAFETY FIX (coverage-v1.4): every regex below used to scan
  // `f.content` directly, so a commented-out registration
  // (`// server.addTool({name:'x'})`) matched exactly like a live one — none
  // of these idiom regexes know what a comment is. Scanning `content`
  // (comments blanked to spaces, code/strings byte-identical — see
  // `stripComments`) instead means a commented-out call is simply invisible
  // text now, with no per-loop "was this inside a comment?" check needed.
  const content = stripComments(f.content)
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(JS_TOOL_CALL_RE)) {
    const afterName = m.index + m[0].length
    let schemaText = m[0]
    let description = m[2]
    // registerTool's second arg is typically a config object, not a bare
    // string — pull it in so a description like "Execute a shell command"
    // buried in the config is still visible to classify().
    if (description === undefined) {
      const skip = /^\s*,?\s*/.exec(content.slice(afterName))
      const objStart = afterName + (skip ? skip[0].length : 0)
      if (content[objStart] === '{') {
        const obj = captureBalanced(content, objStart, '{', '}')
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
  for (const m of content.matchAll(DEFINE_TOOL_CALL_RE)) {
    if (tools.some(t => t.name === m[1])) continue
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }

  // V4 #2: object-literal first arg — addTool({name,...}) / defineTool({name}).
  for (const m of content.matchAll(OBJECT_ARG_CALL_RE)) {
    const braceIdx = m.index + m[0].length - 1
    const obj = captureBalanced(content, braceIdx, '{', '}')
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
  if (MCP_UTILS_TOOL_IMPORT_RE.test(content) || /get\w*Tools\(/.test(content)) {
    const mcpUtilsImport = MCP_UTILS_TOOL_IMPORT_RE.test(content)
    const fnSpans = mcpUtilsImport ? [] : findGetToolsFnSpans(content)
    for (const m of content.matchAll(KEYED_FACTORY_RE)) {
      const insideGetToolsFn = fnSpans.some(([s, e]) => m.index >= s && m.index <= e)
      if (!mcpUtilsImport && !insideGetToolsFn) continue
      if (tools.some(t => t.name === m[1])) continue
      tools.push({ name: m[1], schemaText: m[0] })
    }
  }

  // V4 #5: class-based tool — `class FindTool extends MongoDBToolBase {
  // name = 'find'; description = '...' }`.
  for (const m of content.matchAll(CLASS_TOOL_RE)) {
    const braceIdx = m.index + m[0].length - 1
    const body = captureBalanced(content, braceIdx, '{', '}')
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
  for (const m of content.matchAll(WRAPPER_TOOL_CALL_RE)) {
    if (WRAPPER_EXCLUDED_METHODS.has(m[1])) continue
    const name = resolveWrapperName(content, m[2])
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
  const acceptedSpans = acceptedToolSpans(content)
  if (
    content.includes('ListToolsRequestSchema') ||
    FASTMCP_IMPORT_RE.test(content) ||
    content.includes('.addTool(') ||
    content.includes('.registerTool(') ||
    content.includes('.tool(') ||
    content.includes('defineTool(') ||
    acceptedSpans.length > 0
  ) {
    for (const m of content.matchAll(/name:\s*["'`]([\w-]+)["'`]/g)) {
      if (tools.some(t => t.name === m[1])) continue
      const objText = acceptedCandidateObjectText(content, m.index, acceptedSpans)
      if (objText === undefined) continue
      tools.push({ name: m[1], schemaText: objText })
    }

    // W3 (R1b): `name:` is an identifier rather than a string literal
    // (figwright's `name: PING_TOOL_NAME`) — resolve it via a same-file
    // scalar const. Same acceptance logic (span/sibling/containment/
    // resource-shape) as the literal-name loop above, via
    // acceptedCandidateObjectText; only the name SOURCE differs.
    for (const m of content.matchAll(/\bname\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) {
      const resolved = resolveScalarConst(content, m[1])
      if (resolved === undefined) continue
      if (tools.some(t => t.name === resolved)) continue
      const objText = acceptedCandidateObjectText(content, m.index, acceptedSpans)
      if (objText === undefined) continue
      tools.push({ name: resolved, schemaText: objText })
    }
  }

  for (const t of fromLowLevelToolCalls(content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  return tools
}

// Fix 2: Python imperative registration forms — `self.tool(name="x")`,
// `mcp.add_tool(name="x")` — plus bare `@mcp.tool` decorators (no parens),
// tolerating a decorator that's separated from its `def` by other decorators,
// comments, or blank lines.
const PY_DECORATOR_RE = /@(?:\w+\.)?tool\b(?:\([^)]*\))?[\s\S]{0,200}?\b(?:async\s+)?def\s+(\w+)\s*\(/g
// W4 (coverage-v1.4, R2 — best ratio in the wave: 5 repos, all unique).
// Replaces the old form (which anchored `name=` directly after the opening
// paren) with one that also handles:
//  - LEADING POSITIONAL ARGS before the `name=` kwarg — qdrant-server's
//    `self.add_tool(self.find, name="qdrant-find", description="...")`
//    registers an already-bound method as the first (positional) arg.
//  - F-STRING name values with a leading interpolation — gget-mcp's
//    `name=f"{prefix}gget_ref"`; the `f?["'](?:\{[^}]*\})?` prefix skips the
//    optional `f` marker, the opening quote, and one leading `{...}`
//    interpolation, then captures the literal tail.
// The `name=` literal anchor is preserved (just no longer glued to the
// opening paren), so a `tool(...)`/`add_tool(...)` call that never names a
// tool still cannot match — see the GUARD test in schema.test.ts.
const PY_IMPERATIVE_RE =
  /\b(?:add_tool|tool)\(\s*(?:[\w.\[\]'"]+\s*,\s*)*name\s*=\s*f?["'](?:\{[^}]*\})?([\w.-]+)["'](?:\s*,\s*description\s*=\s*f?["']([^"']*)["'])?/g

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
// W4 (coverage-v1.4, R2): widened beyond a bare `mcp.` receiver — FastMCP
// subclasses call this on `self`/`server`/`app`/`_mcp` too (e.g. qdrant's
// `self.tool()(self.find)`), and none of these receivers change the shape
// (still requires the literal `.tool(...)( ident )` call-decorator form).
const PY_CALL_DECORATOR_RE = /\b(?:self|mcp|server|app|_mcp)\.tool\([^)]*\)\(\s*([\w.]+)\s*\)/g

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
// W4 (coverage-v1.4, R2): widened from the single `register_X_tools(arg)`
// shape to any `register_`/`setup_`/`add_`-prefixed function whose name
// tokenizes to tool(s) — FastMCP subclasses commonly register in a
// `setup_tools()` method instead. Still just a boolean "is MCP-related"
// signal; it deliberately does not require a specific argument shape.
const PY_REGISTER_TOOLS_SURFACE_RE = /\b(?:register|setup|add)_\w*tools?\s*\(/
export function hasPythonToolRegistrationSurface(files: RepoFile[]): boolean {
  return files.some(f => f.path.endsWith('.py') && PY_REGISTER_TOOLS_SURFACE_RE.test(f.content))
}

export function fromPySource(f: RepoFile): ToolInfo[] {
  // COMMENT-SAFETY FIX (coverage-v1.4): same rationale as fromJsSource — scan
  // a comment-blanked copy so a `# self.add_tool(name="commented_out")` line
  // is invisible to every regex below, not just bracket-counted correctly.
  // lang 'py' also makes `stripComments` recognize triple-quoted docstrings
  // as STRING (left untouched) rather than accidentally treating a `#`
  // inside one as a comment.
  const content = stripComments(f.content, 'py')
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(PY_DECORATOR_RE)) {
    tools.push({ name: m[1], schemaText: m[0] })
  }
  for (const m of content.matchAll(PY_IMPERATIVE_RE)) {
    if (tools.some(t => t.name === m[1])) continue
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }
  for (const t of fromClassSubclass(content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  for (const t of fromCallDecorator(content)) {
    if (!tools.some(x => x.name === t.name)) tools.push(t)
  }
  for (const t of fromLowLevelToolCalls(content, 'py')) {
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

// W6 (coverage-v1.5, wave2-spec §3 R6 / Task W6 Part A): README tool
// catalog — the LAST extraction rung (see extractSchema below), reached only
// when every code/manifest/spec extractor above returned zero tools. Some
// servers ship no parseable registration code but DO ship a machine-
// generated tool catalog in their README (microsoft/playwright-mcp: a
// distribution shim whose real source lives in another repo, carries a
// verified 69-tool catalog in README.md).
//
// Three shapes, each independently guarded against reading prose/parameter
// docs as a tool list:
//
// (1) The playwright-mcp bullet+Description shape — a bold, column-0 bullet
// naming the tool, followed (within the same bullet block) by an indented
// `- Description: ...` line. Deliberately UNSCOPED (not gated on a heading)
// — this exact two-line shape is specific enough on its own that a prose
// README cannot accidentally produce it, and it is the one shape verified
// (wave2-spec) NOT to generalize to a "convention" (it matches exactly one
// repo in the measured corpus) — kept anyway because it recovers that one
// repo's full 69-tool surface.
const README_BULLET_BOLD_DESC_RE = /^-\s\*\*([a-z][\w-]*)\*\*[ \t]*\n(?:[ \t]+-\s.*\n)*?[ \t]+-\s*Description:\s*(.+)$/gim

// (2)/(3) below are the shapes that DO generalize (wave2-spec §3 R6), but
// both are scoped to a heading-bounded "this is a tool section" region —
// see readmeToolSections — and additionally reject a candidate whose
// description opens with a type/optionality annotation (a parameter-table
// row shape: "`user_id` | string | (required) the user's id").
const TYPE_ANNOT_RE = /^[([]\s*(?:string|number|boolean|object|array|integer|int|bool|float|required|optional|enum|null)\b/i

// (2) A code-span bullet: `- \`tool_name\` — description` / `* \`tool_name\`: description`.
// Requires an `_`/`-` inside the name (snake_case/kebab-case identifier
// shape) so a parameter's bare English-word type name can't match.
const README_BULLET_CODE_RE = /^[-*]\s+`([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)`\s*[-–—:]\s*(.{10,})$/gm

// (3) A markdown table row: `| \`tool_name\` | description |`, only inside a
// table whose header row names a tool/name column (README_TABLE_HEADER_RE).
const README_TABLE_ROW_RE = /^\|\s*`?([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)`?\s*\|\s*([^|]{10,}?)\s*\|/gm
const README_TABLE_HEADER_RE = /^\|[^\n]*\b(tool|name)\b[^\n]*\|[ \t]*\n[ \t]*\|[\s:|-]+\|/im

// Section scoping for (2)/(3): a "tool section" is any heading-bounded chunk
// (split at EVERY heading, any level — see readmeToolSections) whose OWN
// heading text mentions tools/commands/capabilities and does not itself read
// as a parameter/config/usage heading. Splitting at every heading (not just
// top-level ones) is what carves a nested "### Parameters" sub-heading back
// out of an accepted "## Tools" section — the sub-heading becomes its own
// chunk and is rejected by NEG_HEAD_RE on its own merits.
const TOOL_HEAD_RE = /\b(tools?|commands?|capabilities)\b/i
// GUARD (false-positive verification, W6 Part A #3): measured against the 32
// live `notServer` repos in index/results.json — modelcontextprotocol/
// ruby-sdk's `### Tool Annotations` section (documenting the
// destructive_hint/idempotent_hint/open_world_hint/read_only_hint FIELD
// NAMES a tool's `annotations:` hash can carry, each as a
// `- \`field_name\`: description` code-span bullet) passed the OLD version
// of this guard — "Tool" alone satisfied TOOL_HEAD_RE and "Annotations" was
// not excluded, so 4 field names were fabricated as "tools". Fixed by adding
// `annotations?`. Also widened the other single-word entries to accept their
// plural form (`response` -> `responses?`, `schema` -> `schemas?`) — the
// SAME README has sibling headings `### Tool Responses with Errors` and
// `### Tool Output Schemas` that the singular-only forms would have missed
// (`\bresponse\b` does not match inside "Responses" — no word boundary
// before the trailing `s`).
const NEG_HEAD_RE = /\b(param(eter)?s?|arguments?|options?|inputs?|config\w*|env|environment|responses?|outputs?|fields?|schemas?|install|setup|usage|examples?|annotations?|errors?|metadata|types?)\b/i

function readmeToolSections(content: string): string[] {
  const marks: Array<{ index: number; heading: string }> = []
  for (const m of content.matchAll(/^#{1,6}\s*([^\n]+)$/gm)) marks.push({ index: m.index, heading: m[1] })
  const sections: string[] = []
  for (let i = 0; i < marks.length; i++) {
    if (!TOOL_HEAD_RE.test(marks[i].heading) || NEG_HEAD_RE.test(marks[i].heading)) continue
    const start = content.indexOf('\n', marks[i].index) + 1
    const end = i + 1 < marks.length ? marks[i + 1].index : content.length
    sections.push(content.slice(start, end))
  }
  return sections
}

// GUARD (required): a README catalog is trusted only once it has produced at
// least this many distinct tool names — a prose README with one bolded word,
// or a single incidental code-span, must never fabricate a tool surface.
// Measured (wave2-spec §3 R6): this is what keeps a normal prose/parameter
// README from ever reaching a "surface".
const README_MIN_TOOLS = 3

/**
 * Extracts a tool catalog from a repo's root README, per the three shapes
 * above. Returns [] (never fabricates) when fewer than README_MIN_TOOLS
 * distinct names are found. Pure — no I/O.
 */
export function fromReadmeCatalog(file: RepoFile): ToolInfo[] {
  const content = file.content
  const seen = new Set<string>()
  const tools: ToolInfo[] = []
  const push = (name: string, description: string | undefined, schemaText: string) => {
    if (seen.has(name)) return
    seen.add(name)
    tools.push({ name, description: description?.trim(), schemaText })
  }

  for (const m of content.matchAll(README_BULLET_BOLD_DESC_RE)) {
    push(m[1], m[2], m[0])
  }

  for (const section of readmeToolSections(content)) {
    const isTable = README_TABLE_HEADER_RE.test(section)
    if (isTable) {
      for (const m of section.matchAll(README_TABLE_ROW_RE)) {
        if (TYPE_ANNOT_RE.test(m[2].trim())) continue
        push(m[1], m[2], m[0])
      }
    }
    for (const m of section.matchAll(README_BULLET_CODE_RE)) {
      if (TYPE_ANNOT_RE.test(m[2].trim())) continue
      push(m[1], m[2], m[0])
    }
  }

  if (tools.length < README_MIN_TOOLS) return []
  return tools
}

// W5 (coverage-v1.5, wave2-spec §2.3): partial-surface honesty. `treePaths`
// is the repo's FULL tree (every blob GitHub reports, never truncated by
// FILE_CAP) — `undefined` when the tree fetch itself failed, in which case
// there is nothing to compare against and the sample can never look partial.
// `isToolFanoutPath` (src/collectors/github.ts) is the SAME "one-tool-per-
// file `tools/`-shaped source file" test github.ts uses to decide whether
// FILE_CAP should widen to 24 in the first place — reusing it here means the
// count of files that COULD have carried tools is measured identically on
// both sides (full tree vs. sampled set), not by two definitions that could
// silently drift apart.
// Cleanup: `detected` used to always be recomputed here via a full pass over
// `treePaths` — but github.ts's collectGithub already runs this exact same
// scan (it needs the identical count for its own FILE_CAP decision) and
// exposes the result as RepoSnapshot.toolFanoutCount. When the caller passes
// it through (the normal collectGithub -> assemble.ts -> extractSchema path),
// reuse it instead of re-scanning the whole tree a second time. Falls back to
// recomputing from treePaths when omitted (e.g. tests that call extractSchema
// directly without a RepoSnapshot) so behavior is unchanged for those callers.
function detectSurfacePartial(
  files: RepoFile[], treePaths: string[] | undefined, toolFanoutCount: number | undefined,
): boolean {
  if (!treePaths) return false
  const detected = toolFanoutCount ?? treePaths.filter(isToolFanoutPath).length
  const sampled = files.filter(f => isToolFanoutPath(f.path)).length
  return detected > sampled
}

export function extractSchema(
  files: RepoFile[], treePaths?: string[], toolFanoutCount?: number,
  // W6 (Task W6 Part A): the repo's root README, when the caller has already
  // decided this repo is eligible for the last-rung README-catalog
  // extraction (assemble.ts only passes this once every static extractor is
  // known to be at zero AND — per wave2-spec §3 R6's non-negotiable ordering
  // rule — the dynamic-surface classifier (src/derive/dynamic.ts) has
  // already run and declined to fire; otherwise a proxy/gateway's own README
  // (MCPJungle: included_tools/excluded_tools/included_servers) would
  // populate a fake tool surface and the dynamic classifier, itself gated on
  // zero tools, would never get a chance to see zero). Omitted (the default)
  // for every other call site — the README rung is then simply never
  // reached, preserving prior behavior byte-for-byte (see the "nothing
  // extractable" regression test in tests/schema.test.ts, which fetches a
  // README.md with no 4th argument and still expects extracted:false).
  readmeFile?: RepoFile,
): SchemaResult {
  // W5 §2.3: computed once, up front, and threaded into every return branch
  // below — a partial sample is still partial whether extraction ultimately
  // found zero tools, a shell-import risk floor, or a real tool list.
  const surfacePartial = detectSurfacePartial(files, treePaths, toolFanoutCount)
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

  // W6 (Task W6 Part A): the README-catalog rung — LITERALLY the last rung,
  // reached only when every rung above (manifest/js/py/go/spec) returned
  // zero AND the caller opted in by passing `readmeFile` (see its param
  // comment above for the dynamic-classifier ordering this depends on).
  // fromReadmeCatalog itself never fabricates (>=3-tool guard, see its own
  // comment) — an empty result here just leaves `tools` at [] and the ladder
  // falls through to the same "nothing extractable" branch as today.
  let readmeSourced = false
  if (tools.length === 0 && readmeFile) {
    const readmeTools = fromReadmeCatalog(readmeFile).map(t => ({ ...t, evidence: readmeFile.path }))
    if (readmeTools.length > 0) {
      tools = readmeTools
      readmeSourced = true
    }
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
        surfacePartial, readmeSourced: false,
      }
    }
    return { extracted: false, tools: [], toolSurfaceRisk: undefined, schemaTokenEstimate: undefined, findings: [], surfacePartial, readmeSourced: false }
  }

  const findings: Finding[] = []
  // W6 (Task W6 Part A / wave2-spec §3 R6): transparency finding — a README-
  // derived surface was parsed from documentation, not the shipped source,
  // so it is flagged the same way any other lower-confidence signal is
  // (evidence-linked, per the plan's Global Constraints).
  if (readmeSourced) {
    findings.push({
      id: 'reliability/readme-sourced-tools', dimension: 'reliability', severity: 'info',
      message: 'Tool surface read from README catalog — not verified against source.',
      evidence: readmeFile?.path ?? 'README.md',
    })
  }
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
    // D1 (integrity-v1, trap #6): evidence is now RETAINED here (D1 needs it
    // to cite each tool's source file) — but schemaTokenEstimate below
    // MUST keep stripping it via the same destructure, or every cost score
    // in the index would shift the moment a tool carries an `evidence`
    // field. See tests/schema.test.ts's byte-identical regression test.
    tools,
    toolSurfaceRisk: worst,
    schemaTokenEstimate: encode(JSON.stringify(tools.map(({ evidence: _e, ...t }) => t))).length,
    findings,
    surfacePartial,
    readmeSourced,
  }
}
