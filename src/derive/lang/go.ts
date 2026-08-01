// V3 (coverage-spec §3.2): Go tool extractor. Go MCP servers use one of
// three SDKs, each with its own tool-registration shape — none of them
// look like the JS/Python idioms `fromJsSource`/`fromPySource` already
// handle, so Go was entirely unparsed before this. Four idioms, all
// reconstructed from real repos in the coverage investigation:
//   1. official go-sdk composite literal: `mcp.Tool{Name:"x", Description: t("KEY","literal")}`
//   2. mark3labs call form: `mcp.NewTool("x", mcp.WithDescription(`...`))`
//   3. mark3labs positional: `mcpgrafana.MustTool("x", "desc", ...)` / `mcp.NewTool("x", "desc")`
//   4. genai-toolbox self-register: `tools.Register(resourceType, ...)` +
//      `const resourceType string = "x"` + `cfg.Description = "..."`
// Extracted tools are plain ToolInfo — they flow through the SAME
// classify()/token-set risk path in extractSchema as JS/Py tools, so no
// Go-specific risk logic lives here.
//
// Precision guard (post-review): idioms 2/3 key off bare function names
// (NewTool/MustTool) that also occur as ordinary, unrelated Go
// constructors — e.g. a domain type's own `NewTool(name, kind string)`.
// Left unguarded, that fabricates a phantom MCP tool out of code that has
// nothing to do with MCP. Two independent narrowings fix this:
//   - fromGoSource only runs on files that reference a known MCP SDK
//     surface at all (GO_MCP_MARKER_RE below); files with no such
//     reference return [] before any idiom regex runs.
//   - idioms 2/3 additionally require NewTool/MustTool to be called
//     through a package/receiver selector (`mcp.NewTool(`,
//     `mcpgrafana.MustTool(`), since every real MCP usage is qualified —
//     a bare `NewTool(...)` call is never the MCP SDK's.
import type { RepoFile } from '../../collectors/github.js'
import type { ToolInfo } from '../../types.js'
import { captureBalanced } from '../schema.js'

// Matches files that plausibly touch a Go MCP SDK: either SDK's import
// path, a qualified `mcp.` symbol from the mark3labs/official SDKs
// (`mcp.Tool`, `mcp.NewTool`, or any `mcp.With*` functional option —
// mcp-grafana's tool files don't call mcp.WithDescription directly but
// do carry annotations like `mcp.WithReadOnlyHintAnnotation`), an
// `MCPServer` type reference, or genai-toolbox's self-register call.
// Deliberately narrow: no bare `NewTool`/`MustTool`/`Tool` alternative,
// since those are exactly the generic names that cause phantom matches.
const GO_MCP_MARKER_RE = /mark3labs\/mcp-go|modelcontextprotocol\/go-sdk|\bmcp\.(?:Tool|NewTool|With\w*)\b|\bMCPServer\b|\btools\.Register\(/

// Idiom 1: official go-sdk composite literal, e.g. github-mcp-server:
//   return mcp.Tool{
//       Name: "get_file_contents",
//       Description: t("TOOL_GET_FILE_CONTENTS_DESCRIPTION", "Get the contents of a file or directory from a GitHub repository"),
//       InputSchema: mcp.ToolInputSchema{ ... },
//   }
const GO_TOOL_LITERAL_RE = /\bmcp\.Tool\{/g
const GO_TOOL_NAME_RE = /Name:\s*"([\w.-]+)"/
// The translation helper's SECOND string arg is the human-readable text;
// the first is just a lookup key (e.g. "TOOL_GET_FILE_CONTENTS_DESCRIPTION")
// and must never be picked up as the description.
const GO_TOOL_DESC_T_RE = /Description:\s*t\(\s*"[^"]*"\s*,\s*"([^"]*)"/
const GO_TOOL_DESC_PLAIN_RE = /Description:\s*"([^"]*)"/

function fromToolLiteral(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(GO_TOOL_LITERAL_RE)) {
    const openIdx = m.index + m[0].length - 1
    const block = captureBalanced(content, openIdx, '{', '}')
    if (!block) continue
    const nameMatch = block.match(GO_TOOL_NAME_RE)
    if (!nameMatch) continue
    const descMatch = block.match(GO_TOOL_DESC_T_RE) ?? block.match(GO_TOOL_DESC_PLAIN_RE)
    tools.push({ name: nameMatch[1], description: descMatch?.[1], schemaText: block })
  }
  return tools
}

// Idiom 3 (checked before idiom 2 — see fromGoSource): mark3labs positional
// name+description in one call, e.g. mcp-grafana's MustTool, or a plain
// NewTool("x","desc") with no WithDescription option. Requires a
// package/receiver qualifier before the call (`mcpgrafana.MustTool(`,
// `mcp.NewTool(`) — every real MCP usage is qualified, and requiring the
// dot excludes unrelated bare constructors of the same name:
//   mcpgrafana.MustTool("search_dashboards", "Search for Grafana dashboards by title, tag, or folder", handler)
const GO_POSITIONAL_RE = /\b\w+\.(?:MustTool|NewTool)\(\s*["'`]([\w.-]+)["'`]\s*,\s*["'`]([^"'`]*)["'`]/g

function fromPositionalCall(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(GO_POSITIONAL_RE)) {
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }
  return tools
}

// Idiom 2: mark3labs call form where the description is a functional option
// rather than a positional string, e.g. terraform-mcp-server/mcpproxy-go:
//   mcp.NewTool("search_providers",
//       mcp.WithDescription(`This tool searches for Terraform providers...`),
//   )
// GO_POSITIONAL_RE above won't match this shape (the second arg after the
// comma is `mcp.WithDescription(`, not a quoted string), so the two idioms
// are naturally disjoint on well-formed input. Requires the same
// dot-qualification as idiom 3 (`mcp.NewTool(`), for the same reason: a
// bare `NewTool(...)` is never the MCP SDK's.
const GO_NEWTOOL_CALL_RE = /\b\w+\.NewTool\(\s*["'`]([\w.-]+)/g
const WITH_DESCRIPTION_RE = /WithDescription\(/

function fromCallFormWithDescription(content: string): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of content.matchAll(GO_NEWTOOL_CALL_RE)) {
    const name = m[1]
    const parenIdx = content.indexOf('(', m.index)
    if (parenIdx === -1) continue
    const call = captureBalanced(content, parenIdx, '(', ')')
    let description: string | undefined
    const wdMatch = call.match(WITH_DESCRIPTION_RE)
    if (wdMatch && wdMatch.index !== undefined) {
      const wdParenIdx = call.indexOf('(', wdMatch.index)
      const wdCall = captureBalanced(call, wdParenIdx, '(', ')')
      const descMatch = wdCall.match(/["'`]([^"'`]*)["'`]/)
      if (descMatch) description = descMatch[1]
    }
    tools.push({ name, description, schemaText: call })
  }
  return tools
}

// Idiom 4: genai-toolbox self-register — each tool lives in its own package
// and registers itself in init(); name and description are pulled from two
// separate top-level statements rather than one call, gated behind the
// tools.Register( signal so an unrelated resourceType/Description pair
// elsewhere in the tree is never mistaken for a tool registration.
const GENAI_REGISTER_RE = /\btools\.Register\(/
const GENAI_RESOURCE_TYPE_RE = /const\s+resourceType\s+string\s*=\s*"([\w.-]+)"/
const GENAI_DESCRIPTION_ASSIGN_RE = /\.Description\s*=\s*"([^"]*)"/

function fromSelfRegister(content: string): ToolInfo[] {
  if (!GENAI_REGISTER_RE.test(content)) return []
  const nameMatch = content.match(GENAI_RESOURCE_TYPE_RE)
  if (!nameMatch) return []
  const descMatch = content.match(GENAI_DESCRIPTION_ASSIGN_RE)
  const schemaText = descMatch ? `${nameMatch[0]}\n${descMatch[0]}` : nameMatch[0]
  return [{ name: nameMatch[1], description: descMatch?.[1], schemaText }]
}

export function fromGoSource(file: RepoFile): ToolInfo[] {
  const content = file.content
  // Phantom-tool guard: skip files that don't reference a Go MCP SDK at
  // all. Without this, a file that merely happens to define its own
  // NewTool/MustTool-named function (unrelated to MCP) would still be
  // scanned by the idiom regexes below.
  if (!GO_MCP_MARKER_RE.test(content)) return []
  // Idiom 3 runs before idiom 2 so that a NewTool("x","literal desc") call
  // (which both regexes can match) keeps the richer name+description entry
  // from idiom 3 instead of being shadowed by idiom 2's name-only match for
  // the same call (dedup below keeps the first occurrence of a name).
  const combined: ToolInfo[] = [
    ...fromToolLiteral(content),
    ...fromPositionalCall(content),
    ...fromCallFormWithDescription(content),
    ...fromSelfRegister(content),
  ]
  const seen = new Set<string>()
  const tools: ToolInfo[] = []
  for (const t of combined) {
    if (seen.has(t.name)) continue
    seen.add(t.name)
    tools.push(t)
  }
  return tools
}
