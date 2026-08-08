import { describe, expect, it } from 'vitest'
import { classifyLibrary } from '../src/derive/classify.js'
import { assemble } from '../src/assemble.js'
import type { Http } from '../src/util/http.js'

describe('classifyLibrary — signal 1: name/topic/description SDK', () => {
  it('a repo named "foo-sdk" with "The official Foo SDK" description → notServer sdk', () => {
    const r = classifyLibrary({ name: 'foo-sdk', description: 'The official Foo SDK', files: [] })
    expect(r).toEqual({ notServer: true, reason: 'sdk', note: expect.any(String) })
  })
  it('rust-sdk / python-sdk / java-sdk / csharp-sdk name pattern alone triggers sdk', () => {
    for (const name of ['rust-sdk', 'python-sdk', 'java-sdk', 'csharp-sdk']) {
      const r = classifyLibrary({ name, files: [] })
      expect(r?.reason).toBe('sdk')
    }
  })
  it('description "official ... SDK Maintained in collaboration with Microsoft" triggers sdk', () => {
    const r = classifyLibrary({
      name: 'weirdname', description: 'The official Python SDK for Foo. Maintained in collaboration with Microsoft.', files: [],
    })
    expect(r?.reason).toBe('sdk')
  })
  it('topics include "sdk"/"library"/"framework" triggers sdk', () => {
    const r = classifyLibrary({ name: 'foo-tools', topics: ['framework'], files: [] })
    expect(r?.reason).toBe('sdk')
  })
  it('a repo merely depending on an SDK (name doesn\'t end -sdk, no SDK desc/topic) is not misclassified by this signal alone', () => {
    const r = classifyLibrary({
      name: 'my-cool-mcp-server', description: 'A cool MCP server',
      // imports the SDK + registers a real tool, so no OTHER signal fires either —
      // isolates signal 1's negative case cleanly.
      files: [{ path: 'src/index.ts', content: `import { Server } from '@modelcontextprotocol/sdk'\nserver.tool('search', 'Search things', {}, h)` }],
    })
    expect(r).toBeNull()
  })
})

describe('classifyLibrary — signal 2: idioms only under example/doc/sample paths', () => {
  it('a .tool() hit that ONLY exists under examples/ → notServer sdk', () => {
    const r = classifyLibrary({
      name: 'rust-sdk',
      files: [{ path: 'examples/servers/echo.ts', content: `server.tool('echo', 'Echo input', {}, h)` }],
    })
    // (also hits signal 1 via name, but reason must still resolve to 'sdk')
    expect(r?.reason).toBe('sdk')
  })
  it('a name that does NOT match signal 1, with idiom hits only under samples/ → notServer sdk (samples treated like examples)', () => {
    const r = classifyLibrary({
      name: 'csharp-tools',
      files: [{ path: 'samples/EchoServer/Program.cs', content: `server.tool('echo', 'Echo input', {}, h)` }],
    })
    expect(r).toEqual({ notServer: true, reason: 'sdk', note: expect.any(String) })
  })
  it('idiom hits under docs_src/ also count as example-only (python-sdk shape)', () => {
    const r = classifyLibrary({
      name: 'mcp-framework',
      files: [{ path: 'docs_src/quickstart/server.py', content: `@mcp.tool()\ndef echo(x: str) -> str:\n    ...\n` }],
    })
    expect(r?.reason).toBe('sdk')
  })
  it('idiom hits in BOTH an example path and a real server path → signal 2 does NOT fire (not example-only)', () => {
    const r = classifyLibrary({
      name: 'my-real-server',
      files: [
        { path: 'examples/echo.ts', content: `server.tool('echo', 'Echo input', {}, h)` },
        { path: 'src/index.ts', content: `import { Server } from '@modelcontextprotocol/sdk'\nserver.tool('search', 'Search things', {}, h)` },
      ],
    })
    // real registration exists outside example paths — must not be classified as a library
    expect(r).toBeNull()
  })
})

describe('classifyLibrary — signal 3: no MCP SDK import anywhere + no manifest', () => {
  it('no MCP import, no mcp.json/server.json manifest → notServer not-server', () => {
    const r = classifyLibrary({
      name: 'some-random-repo',
      files: [{ path: 'src/index.ts', content: `export function add(a: number, b: number) { return a + b }` }],
    })
    expect(r).toEqual({ notServer: true, reason: 'not-server', note: expect.any(String) })
  })
  it('a fetched file importing @modelcontextprotocol/sdk prevents the not-server verdict', () => {
    const r = classifyLibrary({
      name: 'some-random-repo',
      files: [{ path: 'src/index.ts', content: `import { Server } from '@modelcontextprotocol/sdk'\n// no tool registrations reached in sampled files` }],
    })
    expect(r).toBeNull()
  })
  // C1: the MCP SDK 2.x package split (@modelcontextprotocol/core, /server,
  // /client) matched neither the old MCP_IMPORT_RE nor specEra's package.json
  // branch — live proof: netlify/netlify-mcp (deps @modelcontextprotocol/core
  // + /server) was falsely classified not-server. Broadened to match any of
  // sdk|core|server|client.
  it('C1: a fetched package.json declaring the SDK 2.x split (@modelcontextprotocol/core + /server) prevents the not-server verdict', () => {
    const r = classifyLibrary({
      name: 'netlify-mcp',
      description: "Netlify's Official MCP server",
      files: [{
        path: 'package.json',
        content: JSON.stringify({ dependencies: { '@modelcontextprotocol/core': '2.0.0-beta.4', '@modelcontextprotocol/server': '2.0.0-beta.4' } }),
      }],
    })
    expect(r).toBeNull()
  })
  it('C1: a source file importing from @modelcontextprotocol/server (2.x split) also counts as an MCP import', () => {
    const r = classifyLibrary({
      name: 'some-random-repo',
      files: [{ path: 'src/index.ts', content: `import { Server } from '@modelcontextprotocol/server'\n// no tool registrations reached in sampled files` }],
    })
    expect(r).toBeNull()
  })
  it('C1: a source file importing from @modelcontextprotocol/client (2.x split) also counts as an MCP import', () => {
    const r = classifyLibrary({
      name: 'some-random-repo',
      files: [{ path: 'src/client.ts', content: `import { Client } from '@modelcontextprotocol/client'` }],
    })
    expect(r).toBeNull()
  })
  it('a root mcp.json manifest (even with unparseable/empty tools) prevents the not-server verdict', () => {
    const r = classifyLibrary({
      name: 'some-random-repo',
      files: [{ path: 'mcp.json', content: '{}' }, { path: 'src/index.ts', content: 'export {}' }],
    })
    expect(r).toBeNull()
  })
  it('a Pipedream component shape (export default { type: "action" }) is reinforcing not-server signal', () => {
    const r = classifyLibrary({
      name: 'pipedream-connect',
      files: [{ path: 'components/foo/foo.mjs', content: `export default {\n  key: "foo-action",\n  name: "Foo action",\n  type: "action",\n  async run() {},\n}` }],
    })
    expect(r?.reason).toBe('not-server')
  })
  it('a Python-shaped repo — no MCP import string sampled, but mcpSdkDetected:true (pyproject "mcp>=1.0") and no manifest — must NOT be not-server', () => {
    const r = classifyLibrary({
      name: 'some-python-server',
      description: 'Does something useful',
      files: [{ path: 'src/server.py', content: 'def add(a, b):\n    return a + b\n' }],
      mcpSdkDetected: true,
    })
    expect(r).toBeNull()
  })
  it('the same shape with mcpSdkDetected:false still returns not-server (baseline unchanged)', () => {
    const r = classifyLibrary({
      name: 'some-python-server',
      description: 'Does something useful',
      files: [{ path: 'src/server.py', content: 'def add(a, b):\n    return a + b\n' }],
      mcpSdkDetected: false,
    })
    expect(r).toEqual({ notServer: true, reason: 'not-server', note: expect.any(String) })
  })
  it('Fix 3: importsMcp:true + a Pipedream component shape present → NOT not-server (positive import always wins)', () => {
    const r = classifyLibrary({
      name: 'pipedream-connect-with-mcp',
      files: [{
        path: 'components/foo/foo.mjs',
        content: `import { Server } from '@modelcontextprotocol/sdk'\nexport default {\n  key: "foo-action",\n  name: "Foo action",\n  type: "action",\n  async run() {},\n}`,
      }],
    })
    expect(r).toBeNull()
  })
})

describe('classifyLibrary — signal 4: remote-proxy', () => {
  it('StreamableHTTPClientTransport(new URL(...)) + runtime tool registration → notServer proxy', () => {
    const r = classifyLibrary({
      name: 'stripe-agent-toolkit',
      files: [{
        path: 'src/toolkit.ts',
        content: `
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const transport = new StreamableHTTPClientTransport(new URL('https://mcp.stripe.com/'))
for (const t of remoteTools) {
  this.tool(t.name, t.description, t.inputSchema, handler)
}
`,
      }],
    })
    expect(r).toEqual({ notServer: true, reason: 'proxy', note: expect.any(String) })
  })
})

describe('classifyLibrary — signal 5: distribution-stub', () => {
  it('server.json names a different npm package + "Where is the source?" redirect → notServer stub', () => {
    const r = classifyLibrary({
      name: 'playwright-mcp-stub',
      files: [
        { path: 'server.json', content: JSON.stringify({ packages: [{ identifier: '@playwright/mcp', registry_name: 'npm' }] }) },
        { path: 'src/index.js', content: '// Where is the source? See @playwright/mcp on npm.' },
      ],
    })
    expect(r).toEqual({ notServer: true, reason: 'stub', note: expect.stringContaining('@playwright/mcp') })
  })
})

describe('classifyLibrary — priority order', () => {
  it('signal 1 (sdk-name) wins even when a proxy-shaped file is also present', () => {
    const r = classifyLibrary({
      name: 'foo-sdk',
      files: [{
        path: 'src/toolkit.ts',
        content: `const t = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/'))\nthis.tool(x.name, x.description, x.inputSchema, h)`,
      }],
    })
    expect(r?.reason).toBe('sdk')
  })
})

describe('classifyLibrary — V5: Python register_*_tools registration-surface signal', () => {
  it('a Python repo with no MCP import matched and no manifest, but a register_search_tools(mcp) call, is NOT classified not-server', () => {
    const r = classifyLibrary({
      name: 'awslabs-docs-mcp-server',
      files: [{
        path: 'src/server.py',
        content: `def setup(mcp):\n    register_search_tools(mcp)\n`,
      }],
    })
    expect(r).toBeNull()
  })
  it('baseline unchanged: the same shape WITHOUT a register_*_tools call still returns not-server', () => {
    const r = classifyLibrary({
      name: 'awslabs-docs-mcp-server',
      files: [{ path: 'src/server.py', content: `def setup(mcp):\n    pass\n` }],
    })
    expect(r).toEqual({ notServer: true, reason: 'not-server', note: expect.any(String) })
  })
})

describe('classifyLibrary — negative: genuine miss stays null', () => {
  it('an unparseable server with no recognizable signal returns null (caller keeps insufficientData)', () => {
    const r = classifyLibrary({
      name: 'obscure-mcp-server',
      description: 'Does something useful',
      files: [
        { path: 'mcp.json', content: 'not valid json {{{' },
        { path: 'src/main.go', content: 'package main\nfunc main() {}\n' },
      ],
    })
    expect(r).toBeNull()
  })
})

// Tier B (escalation, coverage-spec §3.1): better extraction (V3-V5) now
// yields tool-shaped hits from the official SDK repos' own API-definition
// code, so the `toolsExtracted:false` guard (Tier A above) no longer fires
// for python-sdk/typescript-sdk/go-sdk/kotlin-sdk. Tier B fires even when
// tools WERE extracted, but only on corroborated identity: the repo name
// must end in `-sdk` AND at least one independent signal (official-SDK
// description or an sdk/library/framework topic) must also be present.
// Either alone is not enough — a real MCP server could plausibly be
// *named* `*-sdk` OR merely *described* generically; requiring both keeps
// real servers safe.
describe('classifyLibrary — Tier B: corroborated SDK identity overrides extracted tools', () => {
  it('name ends -sdk + official-SDK description + tools extracted → notServer sdk', () => {
    const r = classifyLibrary({
      name: 'python-sdk',
      description: 'The official Python SDK for Model Context Protocol servers and clients',
      files: [],
      toolsExtracted: true,
    })
    expect(r).toEqual({ notServer: true, reason: 'sdk', note: expect.any(String) })
  })
  // I7: topics are unverified/author-set — a real server could self-tag
  // 'library'/'sdk' without being one. Reviewer verified {name:'weather-sdk',
  // description:'Weather MCP server', topics:['library'], toolsExtracted:true}
  // was de-graded on the topic alone. Tier B now requires the DESCRIPTION
  // signal (same-sentence "official ... SDK") when tools were extracted —
  // topic-alone corroboration is dropped for this tier only (Tier A, zero
  // tools, is unaffected — see below).
  it('I7: name ends -sdk + sdk topic ALONE (no official-SDK description) + tools extracted → does NOT fire (topic-alone no longer corroborates)', () => {
    const r = classifyLibrary({
      name: 'foo-sdk',
      topics: ['sdk'],
      files: [],
      toolsExtracted: true,
    })
    expect(r).toBeNull()
  })
  it('I7: reviewer counterexample — weather-sdk, generic description, topics:[library], tools extracted → NOT notServer (real server safe)', () => {
    const r = classifyLibrary({
      name: 'weather-sdk',
      description: 'Weather MCP server',
      topics: ['library'],
      files: [],
      toolsExtracted: true,
    })
    expect(r).toBeNull()
  })
  it('I7: python-sdk with a genuine official-SDK description + tools extracted → still notServer (Tier B not over-narrowed)', () => {
    const r = classifyLibrary({
      name: 'python-sdk',
      description: 'The official Python SDK for Model Context Protocol servers and clients',
      files: [],
      toolsExtracted: true,
    })
    expect(r).toEqual({ notServer: true, reason: 'sdk', note: expect.any(String) })
  })
  it('name ends -sdk ALONE (generic description, no sdk/library/framework topic) + tools extracted → does NOT fire (still graded)', () => {
    const r = classifyLibrary({
      name: 'foo-sdk',
      description: 'A helpful toolkit for building things',
      files: [],
      toolsExtracted: true,
    })
    expect(r).toBeNull()
  })
  it('a real server (name does not end -sdk) + tools extracted → does NOT fire, regardless of description', () => {
    const r = classifyLibrary({
      name: 'weather-mcp-server',
      description: 'An MCP server for weather',
      files: [],
      toolsExtracted: true,
    })
    expect(r).toBeNull()
  })
  it('Tier A unchanged: name ends -sdk + zero tools extracted → notServer sdk (existing behavior preserved)', () => {
    const r = classifyLibrary({
      name: 'foo-sdk',
      files: [],
      toolsExtracted: false,
    })
    expect(r?.reason).toBe('sdk')
  })
})

// ---------------------------------------------------------------------------
// W6 review remediation item 1 (I3): classifyLibrary's content signals
// (signal 2's idiom scan in particular) read whatever `ctx.files` the caller
// hands it, with no path filter. Signal 2 requires EVERY idiom hit to be
// under an excluded (example/doc/sample) path; a root README.md is NOT an
// excluded path, so a README fence matching the same idiom that trips
// signal 2 from real source actually SUPPRESSES signal 2 (idiomHitPaths is
// no longer "every" under an excluded path), flipping the verdict.
// assemble.ts must hand classifyLibrary the SAME files regardless of
// whether the repo happens to have a matching README fence.
// ---------------------------------------------------------------------------

describe('assemble — README quarantine (W6 review I3): classification unaffected by README content', () => {
  function makeRoutedHttp(routes: Record<string, unknown>, textFn: (url: string) => string): Http {
    return {
      async json<T>(url: string): Promise<T> {
        for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return body as T
        throw new Error(`HTTP 404 for ${url}`)
      },
      async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
        for (const [prefix, body] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return { data: body as T, headers: new Headers() }
        }
        throw new Error(`HTTP 404 for ${url}`)
      },
      async postJson<T>(url: string): Promise<T> {
        if (url.includes('osv.dev')) return { results: [] } as T
        throw new Error(`HTTP 404 for ${url}`)
      },
      async text(url: string): Promise<string> { return textFn(url) },
    }
  }

  const NOW = new Date('2026-08-06T00:00:00Z')
  const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

  // Real source's only tool-registration idiom lives under examples/ (an
  // excluded path) — extraction correctly finds zero tools, and signal 2
  // ("idiom-only-in-excluded-paths") correctly classifies this as a library
  // whose registrations exist only under example paths.
  function repoHttp(withReadme: boolean): Http {
    const tree: Array<{ path: string; type: string; size: number }> = [
      { path: 'package.json', type: 'blob', size: 200 },
      { path: 'examples/demo.ts', type: 'blob', size: 200 },
    ]
    if (withReadme) tree.push({ path: 'README.md', type: 'blob', size: 500 })
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/classifyguard/commits?since': [],
      'https://api.github.com/repos/acme/classifyguard/releases/latest': {},
      'https://api.github.com/repos/acme/classifyguard/git/trees/main?recursive=1': { tree },
      'https://api.github.com/repos/acme/classifyguard': {
        stargazers_count: 5, archived: false, pushed_at: iso(3), default_branch: 'main',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ name: 'classifyguard' })
      if (url.endsWith('examples/demo.ts')) return `server.tool("demo_tool", "does a demo thing", {}, handler)`
      if (url.endsWith('README.md')) {
        return `# classifyguard

Example usage:

\`\`\`js
server.tool("example_tool", "an example tool", {}, handler)
\`\`\`
`
      }
      throw new Error(`HTTP 404 for ${url}`)
    })
  }

  it('a repo with real source that extracts zero tools classifies identically whether or not its README contains a matching tool-call fence', async () => {
    const without = await assemble({ ref: 'classifyguard', repo: { owner: 'acme', name: 'classifyguard' } }, repoHttp(false), NOW)
    const withReadme = await assemble({ ref: 'classifyguard', repo: { owner: 'acme', name: 'classifyguard' } }, repoHttp(true), NOW)
    expect(without.schemaExtracted).toBe(false)
    // Today (pre-fix): the README's own `server.tool("example_tool", ...)`
    // fence is picked up by classifyLibrary's raw content scan too, but at a
    // NON-excluded path (root README.md), which makes idiomHitPaths.every()
    // false and SUPPRESSES signal 2 — flipping notServerReason away from
    // 'sdk' (usually to 'not-server'). The README's presence must be inert.
    expect(withReadme.notServerReason).toBe(without.notServerReason)
    expect(withReadme.notServer).toBe(without.notServer)
    expect(without.notServerReason).toBe('sdk')
  })
})

// Fault hunt 2026-08-08, CRITICAL 1. Signal 3 is a conjunction of NEGATIVE
// predicates, so it asserts absence — and because `notServer` bypasses
// score.ts's insufficientData gate, the WORSE the coverage the more confident
// the published verdict. Measured on the live index: 9 of 20 published
// `not-server` entries contradicted the repo's own fetched GitHub
// description, including Microsoft's official Azure/azure-mcp. An absence
// claim now requires having looked somewhere it could have been found.
describe('signal 3 may not assert absence from evidence it never had', () => {
  const base = { name: 'thing', files: [] as Array<{ path: string; content: string; size: number }> }
  const f = (path: string, content = 'export const x = 1') => ({ path, content, size: content.length })

  it('never classifies from zero fetched files (OctoEverywhere/mcp: treePaths=5, files=0)', () => {
    expect(classifyLibrary({ ...base, files: [] })).toBeNull()
  })

  it('never contradicts a repo that calls itself an MCP server in its description (Azure/azure-mcp)', () => {
    const ctx = {
      ...base,
      description: 'The Azure MCP Server, bringing the power of Azure to your agents.',
      files: [f('eng/vscode/extension.ts'), f('eng/npm/wrapper.js'), f('eng/tools/docgen.ts')],
    }
    expect(classifyLibrary(ctx)).toBeNull()
  })

  it('never contradicts a repo whose topics claim it is an MCP server', () => {
    expect(classifyLibrary({ ...base, topics: ['mcp'], files: [f('src/main.ts')] })).toBeNull()
    expect(classifyLibrary({ ...base, topics: ['mcp-server'], files: [f('src/main.ts')] })).toBeNull()
  })

  it('never asserts "no MCP import" for a language the import regex cannot read (dnaerys/onekgpd-mcp is Java)', () => {
    const ctx = { ...base, files: [f('src/main/java/OneKGPdMCPServer.java', 'public class OneKGPdMCPServer {}')] }
    expect(classifyLibrary(ctx)).toBeNull()
  })

  it('STILL fires on a genuine non-server with readable, representative source', () => {
    const ctx = { ...base, name: 'random-utils', description: 'A string utility library', files: [f('src/index.ts', 'export const slug = (s: string) => s')] }
    expect(classifyLibrary(ctx)?.reason).toBe('not-server')
  })
})
