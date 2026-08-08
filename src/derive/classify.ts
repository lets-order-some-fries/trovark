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
//
// V6 — two-tier rule (coverage-spec §3.1 escalation). V3-V5's better
// extraction started yielding tool-shaped hits from the official SDK repos'
// own API-definition/example code (python-sdk, typescript-sdk, go-sdk,
// kotlin-sdk), so a guard that only ever ran at zero tools stopped firing for
// exactly the repos it most needs to catch — they started receiving real
// server grades instead of `notServer`. The caller now ALWAYS invokes this,
// passing `toolsExtracted` so the function itself decides which tier applies:
//   - Tier A (toolsExtracted: false) — any ONE of the existing signals below
//     suffices. Unchanged from V2.
//   - Tier B (toolsExtracted: true) — a server that extracted even one tool
//     is normally never reclassified, UNLESS the repo's identity is
//     corroborated by TWO independent signals at once (name ends `-sdk` AND
//     an official-SDK description, same sentence) — see
//     classifyCorroboratedSdkIdentity below. I7: topic-alone corroboration
//     was dropped from this tier (topics are unverified/author-set).
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
  // V6: whether extractSchema found ANY tools in this repo (assemble.ts:
  // `schema.tools.length > 0`). Defaults to falsy (Tier A) when omitted, so
  // every pre-V6 call site/test that never mentions this field keeps running
  // the unchanged zero-tools signals. When true, only Tier B's corroborated
  // identity check runs — see classifyLibrary below.
  toolsExtracted?: boolean
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
// C1: MCP SDK 2.x split the single @modelcontextprotocol/sdk package into
// @modelcontextprotocol/core, /server, /client — matched neither the old
// sdk-only regex nor specEra.ts's package.json branch, so live 2.x servers
// (netlify/netlify-mcp: deps on /core + /server) were falsely classified
// not-server. Broadened to any of sdk|core|server|client.
const MCP_IMPORT_RE = /@modelcontextprotocol\/(?:sdk|core|server|client)|['"]fastmcp['"]|mcp\.server\.fastmcp|from mcp\b|rmcp::/
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
 * Classifies a repo as library/SDK/proxy/stub, or returns null when none of
 * the signals apply (the caller keeps whatever it already had — a genuine
 * zero-tools coverage miss stays `insufficientData`; a repo with real tools
 * stays graded). Signals are checked in priority order; the first match wins
 * (e.g. an `-sdk`-named repo that also happens to contain a proxy-shaped
 * snippet is still reported as `sdk`, not `proxy`).
 *
 * `ctx.toolsExtracted` selects the tier (see the V6 note above the imports):
 * Tier A's five signals only run at zero tools; Tier B's single corroborated-
 * identity check only runs once tools were extracted.
 */
// A repo asserting, in its own GitHub metadata, that it IS an MCP server.
// Used ONLY as counter-evidence: it never makes something a server, it only
// blocks us from publishing the opposite claim off a sample that may never
// have touched the server's code.
const SERVER_SELF_DESC_RE = /\b(?:mcp|model[\s-]?context[\s-]?protocol)\b[^.]{0,60}\bservers?\b|\bservers?\b[^.]{0,60}\b(?:mcp|model[\s-]?context[\s-]?protocol)\b/i
const SERVER_SELF_TOPICS = new Set(['mcp', 'mcp-server', 'mcp-servers', 'model-context-protocol', 'modelcontextprotocol'])

function selfDescribesAsServer(ctx: ClassifyContext): boolean {
  if (SERVER_SELF_DESC_RE.test(ctx.description ?? '')) return true
  return (ctx.topics ?? []).some(t => SERVER_SELF_TOPICS.has(t.toLowerCase()))
}

// Extensions MCP_IMPORT_RE cannot read. Absence of an "MCP import" in these
// is a fact about the detector, not about the repository.
const UNREADABLE_LANG_RE = /\.(?:java|kt|kts|cs|fs|rb|php|swift|scala|clj|cljs|ex|exs|dart|cpp|cc|hpp|erl|hs|ml|pl|r|jl)$/i

export function classifyLibrary(ctx: ClassifyContext): NotServerResult | null {
  if (ctx.toolsExtracted) return classifyCorroboratedSdkIdentity(ctx)

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
  // Every predicate above is NEGATIVE, so this signal asserts absence. An
  // absence claim is only publishable when we actually looked somewhere it
  // could have been found — otherwise thin coverage manufactures a confident
  // verdict, and because `notServer` bypasses score.ts's insufficientData
  // gate, the WORSE the coverage the more certain the published claim. That
  // inverts "absence lowers confidence, never fakes a value". Measured on
  // the live index: 9 of 20 published `not-server` entries contradicted the
  // repo's own fetched GitHub description, including Microsoft's official
  // Azure/azure-mcp. Each guard returns null so the repo falls through to
  // the honest insufficientData state instead.
  if (!importsMcp && !ctx.mcpSdkDetected && !hasPyToolRegistrationSurface && (!hasManifest || isPipedreamComponent)) {
    // (a) Nothing was fetched. OctoEverywhere/mcp reached this branch with
    // files.length === 0, where every negative predicate is vacuously true:
    // zero evidence produced a positive claim of absence.
    if (ctx.files.length === 0) return null
    // (b) The repo says it is an MCP server. Azure/azure-mcp's own fetched
    // description reads "The Azure MCP Server, bringing the power of Azure
    // to your agents", while the sampler drew 23 of 24 files from eng/ (a
    // VS Code extension, an npm wrapper, a docgen template, test files) and
    // not one file of the actual server. A vendor's claim is not proof they
    // ship a server, but it is conclusive proof we must not publish the
    // opposite from a sample that never looked at the server.
    if (selfDescribesAsServer(ctx)) return null
    // (c) The sample is in a language MCP_IMPORT_RE cannot read (TS/JS/
    // Python/Rust only), so "no MCP import" describes our detector, not the
    // repo. dnaerys/onekgpd-mcp is a Java server whose own fetched pom.xml
    // declares quarkus-mcp-server-bom/-http/-stdio.
    if (ctx.files.some(f => UNREADABLE_LANG_RE.test(f.path))) return null
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

// Tier B description signal — deliberately stricter than Tier A's SDK_DESC_RE
// above: `[^.]*` stops at the first sentence boundary instead of matching
// across the whole description with `.*`. Tier A can afford the loose match
// because it only ever fires at zero tools (a low-stakes tie-breaker); Tier B
// overrides a REAL extraction result, so it must not fire on a description
// where "official" and "SDK" merely appear in different, unrelated sentences.
const SDK_DESC_TIER_B_RE = /\bofficial\b[^.]*\bsdk\b/i

/**
 * Tier B (coverage-spec §3.1 escalation): fires even when tools WERE
 * extracted, but only when the repo's SDK identity is corroborated by TWO
 * independent signals at once:
 *   1. the repo name ends in `-sdk`, AND
 *   2. an official-SDK description (same sentence).
 * Either alone is not enough to override a real extraction — a genuine MCP
 * server could plausibly be *named* `*-sdk`, or merely *described* in SDK-
 * adjacent language, without actually being a library. Requiring both is
 * what keeps a real server safe while still catching python-sdk/typescript-
 * sdk/go-sdk/kotlin-sdk, whose own API-definition/example code the improved
 * V3-V5 extractors now read as tool-shaped.
 *
 * I7: topic-alone corroboration was dropped. Repo topics are author-set and
 * unverified — reviewer verified {name:'weather-sdk', description:'Weather
 * MCP server', topics:['library'], toolsExtracted:true} was de-graded on the
 * topic alone, a real server false positive. Only Tier B's override needs
 * this tightening; Tier A (zero tools, a low-stakes tie-breaker) still
 * accepts topics — see SDK_TOPICS usage above.
 */
function classifyCorroboratedSdkIdentity(ctx: ClassifyContext): NotServerResult | null {
  if (!SDK_NAME_RE.test(ctx.name)) return null
  if (!SDK_DESC_TIER_B_RE.test(ctx.description ?? '')) return null
  return {
    notServer: true, reason: 'sdk',
    note: 'Repo name + description corroborate an official SDK identity; extracted "tools" are API-definition/example code from the SDK itself, not a server surface.',
  }
}

function externalPackageIdentifier(serverJsonContent: string, repoName: string): string | undefined {
  try {
    const doc = JSON.parse(serverJsonContent) as { packages?: Array<{ identifier?: string }> }
    return doc.packages?.find(p => typeof p.identifier === 'string' && p.identifier !== repoName)?.identifier
  } catch {
    return undefined
  }
}
