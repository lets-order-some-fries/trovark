import { describe, expect, it } from 'vitest'
import { classifyLibrary } from '../src/derive/classify.js'

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
