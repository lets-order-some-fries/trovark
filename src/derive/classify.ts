// V2 — Library/SDK/proxy classifier (coverage-spec §3.1 + §3.6).
//
// When extractSchema finds zero tools, that's ambiguous: it could be a
// genuine coverage miss (an MCP server whose idiom/language isn't recognized
// yet — keep `insufficientData`), or it could be a repo that was never going
// to have tools in the first place — an SDK/framework, a repo with no MCP
// surface at all, a remote proxy that only registers tools at runtime, or a
// distribution stub. Those are a DIFFERENT, correct terminal outcome:
// "library — not an MCP server, no tools to grade". Reporting the latter as
// `insufficientData` is misleading (it reads as "we failed to check this
// server" rather than "there is nothing here to check").
//
// This module is a pure function: no I/O, no network, no file-system access
// — it only classifies data the caller (src/assemble.ts) already fetched.
// The caller MUST only invoke this when `tools.length === 0` — see the
// guard note in assemble.ts. A server that extracted even one tool must
// never reach here, so it can never be reclassified.
import type { RepoFile } from '../collectors/github.js'
import type { NotServerReason } from '../types.js'
import { fromJsSource, fromPySource, hasPythonToolRegistrationSurface, isNonServerPath } from './schema.js'

export interface ClassifyContext {
  name: string
  description?: string
  topics?: string[]
  files: RepoFile[]
  // V2: cross-language MCP SDK detection (src/derive/specEra.ts — matches the
  // MCP SDK dependency in package.json/pyproject.toml/requirements.txt/go.mod/
  // Cargo.toml/gradle/pom/.csproj), passed in by assemble.ts. JS/TS repos are
  // accidentally protected from signal 3 below because @modelcontextprotocol/sdk
  // in package.json also matches MCP_IMPORT_RE — but Python's `mcp>=1.0` /
  // `fastmcp>=2.0` in pyproject.toml, or Go/Rust/JVM/.NET manifest deps, do NOT
  // match that import regex. Without this, a non-JS server whose import-bearing
  // source file simply wasn't sampled gets falsely tagged "not a server". This
  // gives every language the same protection JS gets by accident.
  mcpSdkDetected?: boolean
}

export interface NotServerResult {
  notServer: true
  reason: NotServerReason
  note: string
}

// Signal 1 — name/topic/description SDK signal (coverage-spec §3.1 #1).
// rust-sdk, python-sdk, java-sdk, csharp-sdk all end in `-sdk`; descriptions
// like "The official Python SDK…" / "…official … SDK Maintained in
// collaboration with Microsoft" are near-universal on these repos.
const SDK_NAME_RE = /-sdk$/i
const SDK_DESC_RE = /\bofficial\b.*\bsdk\b/i
const SDK_TOPICS = new Set(['sdk', 'library', 'framework'])

// Signal 3 — no-MCP-anywhere (coverage-spec §3.1 #3). Import scan covers the
// modern TS SDK, fastmcp (both the npm package and the Python decorator
// module spelling), the low-level Python `mcp` package, and the Rust `rmcp`
// crate. `ROOT_MANIFEST_RE` deliberately matches mcp.json/server.json at ANY
// depth here (unlike github.ts's root-only fetch-selection rule) — a nested
// manifest is still positive evidence "this repo claims to be an MCP
// server", which is exactly what this signal needs to rule out.
const MCP_IMPORT_RE = /@modelcontextprotocol\/sdk|['"]fastmcp['"]|mcp\.server\.fastmcp|from mcp\b|rmcp::/
const ROOT_MANIFEST_RE = /(^|\/)(mcp|server)\.json$/
// Reinforcing signal: Pipedream's component shape proves the repo is a
// Pipedream action/source component, not an MCP server, independent of the
// import scan above.
const PIPEDREAM_COMPONENT_RE = /export default\s*\{[\s\S]{0,200}?\btype:\s*["'](action|source)["']/

// Signal 4 — remote-proxy (coverage-spec §3.1 #4). Stripe's agent-toolkit
// shape: build a client transport to a remote MCP URL, then register tools
// fetched at runtime (a VARIABLE `.name`, not a literal — a real static tool
// call always has a literal name, see JS_TOOL_CALL_RE in schema.ts).
const REMOTE_TRANSPORT_RE = /StreamableHTTPClientTransport\(\s*new URL\(/
const RUNTIME_TOOL_REGISTER_RE = /\bthis\.tool\(\s*[\w.]+\.name\s*,/
const MCP_URL_RE = /mcp\.(?:stripe|[\w.]+)\.com/

// Signal 5 — distribution-stub (coverage-spec §3.6).
const SOURCE_REDIRECT_RE = /where is the source\?/i

/**
 * Classifies a zero-tools repo as library/SDK/proxy/stub, or returns null
 * when none of the signals apply (a genuine coverage miss — the caller keeps
 * `insufficientData`). Signals are checked in priority order; the first
 * match wins (e.g. an `-sdk`-named repo that also happens to contain a
 * proxy-shaped snippet is still reported as `sdk`, not `proxy`).
 */
export function classifyLibrary(ctx: ClassifyContext): NotServerResult | null {
  // 1. Name / topic / description SDK signal.
  const isSdkByName = SDK_NAME_RE.test(ctx.name)
  const isSdkByDesc = SDK_DESC_RE.test(ctx.description ?? '')
  const isSdkByTopic = (ctx.topics ?? []).some(t => SDK_TOPICS.has(t.toLowerCase()))
  if (isSdkByName || isSdkByDesc || isSdkByTopic) {
    return {
      notServer: true, reason: 'sdk',
      note: 'SDK/framework that defines the tool-registration API but registers no tools itself.',
    }
  }

  // 2. Idiom-only-in-excluded-paths: a tool-registration idiom exists
  // SOMEWHERE in the fetched tree, but every hit is under an example/doc/
  // sample path (rust-sdk: only examples/servers/**; python-sdk: only
  // examples/+docs_src/). extractSchema never sees these (it pre-filters
  // isNonServerPath), so this signal deliberately re-runs the SAME idiom
  // detectors over the FULL, unfiltered file set to notice them.
  const idiomHitPaths = ctx.files
    .filter(f => fromJsSource(f).length > 0 || fromPySource(f).length > 0)
    .map(f => f.path)
  if (idiomHitPaths.length > 0 && idiomHitPaths.every(isNonServerPath)) {
    return {
      notServer: true, reason: 'sdk',
      note: 'Registrations exist only under example/doc paths; shipped source registers none.',
    }
  }

  // 3. No-MCP-anywhere: no fetched file imports an MCP SDK, no cross-language
  // MCP SDK dependency was detected in a manifest (mcpSdkDetected — see
  // ClassifyContext), no Python register_*_tools(...) surface signal (V5,
  // coverage-spec §3.4 Python #3 — see hasPythonToolRegistrationSurface in
  // schema.ts: it never fabricates a ToolInfo, it only proves "this repo IS
  // MCP-related" the same way mcpSdkDetected does for awslabs-shaped
  // servers whose actual @mcp.tool()-decorated functions live in a sibling
  // module that wasn't sampled), and no mcp.json/server.json manifest
  // exists — OR the repo has Pipedream's component shape (a reinforcing
  // not-server signal, but still scoped to `!importsMcp`: a positive import
  // hit always wins).
  const importsMcp = ctx.files.some(f => MCP_IMPORT_RE.test(f.content))
  const hasPyToolRegistrationSurface = hasPythonToolRegistrationSurface(ctx.files)
  const hasManifest = ctx.files.some(f => ROOT_MANIFEST_RE.test(f.path))
  const isPipedreamComponent = ctx.files.some(f => PIPEDREAM_COMPONENT_RE.test(f.content))
  if (!importsMcp && !ctx.mcpSdkDetected && !hasPyToolRegistrationSurface && (!hasManifest || isPipedreamComponent)) {
    return {
      notServer: true, reason: 'not-server',
      note: 'No MCP SDK import and no tool manifest — not an MCP server.',
    }
  }

  // 4. Remote-proxy: forwards to an upstream MCP endpoint and registers
  // tools it fetched at runtime — no static tool surface to grade.
  const proxyFile = ctx.files.find(f =>
    REMOTE_TRANSPORT_RE.test(f.content) && (RUNTIME_TOOL_REGISTER_RE.test(f.content) || MCP_URL_RE.test(f.content)),
  )
  if (proxyFile) {
    return {
      notServer: true, reason: 'proxy',
      note: 'Remote-proxy: forwards to an upstream MCP endpoint, registers tools fetched at runtime — no static surface.',
    }
  }

  // 5. Distribution-stub: server.json names a different npm package as the
  // real distribution (zero local registrations is guaranteed by the
  // caller's tools.length===0 guard) and the repo's own source redirects to
  // it ("Where is the source?").
  const serverJson = ctx.files.find(f => /(^|\/)server\.json$/.test(f.path))
  if (serverJson) {
    const externalPkg = externalPackageIdentifier(serverJson.content, ctx.name)
    if (externalPkg && ctx.files.some(f => SOURCE_REDIRECT_RE.test(f.content))) {
      return {
        notServer: true, reason: 'stub',
        note: `Tools ship from external package ${externalPkg}; not resolvable from this repo.`,
      }
    }
  }

  return null
}

function externalPackageIdentifier(serverJsonContent: string, repoName: string): string | undefined {
  try {
    const doc = JSON.parse(serverJsonContent) as { packages?: Array<{ identifier?: string }> }
    return doc.packages?.find(p => typeof p.identifier === 'string' && p.identifier !== repoName)?.identifier
  } catch {
    return undefined
  }
}
