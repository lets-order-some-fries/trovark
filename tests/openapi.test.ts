import { describe, expect, it } from 'vitest'
import { fromOpenApi, fromToolDefinitions } from '../src/derive/openapi.js'
import { extractSchema } from '../src/derive/schema.js'

// V5 (coverage-spec §3.5): OpenAPI / generated-manifest extractors — notion
// ships an openapi.json with operationId-per-path, sentry ships a bare
// toolDefinitions.json array.
describe('fromOpenApi', () => {
  it('a notion-style openapi.json with two operationIds -> those names + summaries', () => {
    const content = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Notion API', version: '1.0' },
      paths: {
        '/v1/search': {
          post: { operationId: 'search', summary: 'Search all pages and databases' },
        },
        '/v1/pages/{page_id}': {
          get: { operationId: 'retrievePage', summary: 'Retrieve a page' },
        },
      },
    })
    const tools = fromOpenApi({ path: 'scripts/notion-openapi.json', content })
    expect(tools.map(t => t.name).sort()).toEqual(['retrievePage', 'search'])
    expect(tools.find(t => t.name === 'search')?.description).toBe('Search all pages and databases')
  })

  it('a swagger 2.0 doc (swagger key instead of openapi) also works, falling back to description when summary is absent', () => {
    const content = JSON.stringify({
      swagger: '2.0',
      paths: { '/ping': { get: { operationId: 'ping', description: 'Health check' } } },
    })
    const tools = fromOpenApi({ path: 'swagger.json', content })
    expect(tools.map(t => t.name)).toEqual(['ping'])
    expect(tools[0].description).toBe('Health check')
  })

  it('malformed JSON -> []', () => {
    expect(fromOpenApi({ path: 'openapi.json', content: 'not valid json {{{' })).toEqual([])
  })

  it('a non-openapi JSON object (no openapi/swagger + paths) -> []', () => {
    expect(fromOpenApi({ path: 'package.json', content: JSON.stringify({ name: 'foo', version: '1.0.0' }) })).toEqual([])
  })

  it('an openapi doc missing paths -> []', () => {
    expect(fromOpenApi({ path: 'openapi.json', content: JSON.stringify({ openapi: '3.0.0' }) })).toEqual([])
  })

  it('a path entry with no recognized operationId is skipped, not fabricated', () => {
    const content = JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: {} } } })
    expect(fromOpenApi({ path: 'openapi.json', content })).toEqual([])
  })
})

describe('fromToolDefinitions', () => {
  it('a sentry-style top-level array of {name, description, inputSchema} -> those tools', () => {
    const content = JSON.stringify([
      { name: 'get_issue', description: 'Get details about an issue', inputSchema: { type: 'object' } },
      { name: 'list_projects', description: 'List all projects' },
    ])
    const tools = fromToolDefinitions({ path: 'toolDefinitions.json', content })
    expect(tools.map(t => t.name)).toEqual(['get_issue', 'list_projects'])
    expect(tools[0].description).toBe('Get details about an issue')
  })

  it('malformed JSON -> []', () => {
    expect(fromToolDefinitions({ path: 'toolDefinitions.json', content: 'not valid json {{{' })).toEqual([])
  })

  it('a top-level object (not an array) -> []', () => {
    expect(fromToolDefinitions({ path: 'toolDefinitions.json', content: JSON.stringify({ tools: [] }) })).toEqual([])
  })

  it('array entries without a string name are dropped, not fabricated', () => {
    const content = JSON.stringify([{ description: 'no name here' }, { name: 'valid_tool', description: 'A valid tool' }])
    const tools = fromToolDefinitions({ path: 'toolDefinitions.json', content })
    expect(tools.map(t => t.name)).toEqual(['valid_tool'])
  })

  it('entries with a name but no description/inputSchema/parameters are not tool-ish -> []', () => {
    const content = JSON.stringify([{ name: 'dev' }, { name: 'staging' }])
    const tools = fromToolDefinitions({ path: 'toolDefinitions.json', content })
    expect(tools).toEqual([])
  })

  it('an entry with a name and a description still extracts', () => {
    const content = JSON.stringify([{ name: 'find_issue', description: 'Find an issue' }])
    const tools = fromToolDefinitions({ path: 'toolDefinitions.json', content })
    expect(tools.map(t => t.name)).toEqual(['find_issue'])
  })
})

describe('extractSchema JSON dispatch: fromOpenApi ‖ fromToolDefinitions ‖ fromManifest', () => {
  it('an openapi.json file feeds the extraction ladder end-to-end', () => {
    const r = extractSchema([{
      path: 'openapi.json',
      content: JSON.stringify({
        openapi: '3.0.0',
        paths: { '/search': { post: { operationId: 'search', summary: 'Search the web' } } },
      }),
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search'])
  })

  it('a toolDefinitions.json top-level array feeds the extraction ladder end-to-end', () => {
    const r = extractSchema([{
      path: 'toolDefinitions.json',
      content: JSON.stringify([{ name: 'delete_issue', description: 'Delete an issue' }]),
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['delete_issue'])
    expect(r.toolSurfaceRisk).toBe('medium')
  })
})

// C3: openapi.json/swagger.json were parsed as the FIRST JSON rung and
// `extractSchema`'s ladder `break`s on the first level that yields any
// tools — so a vendored `api/openapi.json` (e.g. a generated REST client
// spec, common in repos that also happen to run an HTTP API alongside their
// MCP server) REPLACED a server's real `server.tool()` registrations
// wholesale, and fabricated HIGH/MEDIUM security findings from REST
// operationIds that were never real MCP tools. Fix: split the JSON rung —
// manifest JSON (mcp/server/toolDefinitions.json) stays FIRST (authoritative,
// unaffected above); openapi/swagger.json moves to the LAST rung, firing only
// when no source extractor (JS/Py/Go) found anything.
describe('extractSchema JSON dispatch: openapi/swagger rung ordering (C3)', () => {
  it("reviewer's exact counterexample — a vendored api/openapi.json does not replace real server.tool() registrations, and fabricates no exec/destructive findings", () => {
    const openapiContent = JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/users/{id}': { delete: { operationId: 'deleteUser', summary: 'Delete a user' } },
        '/exec': { post: { operationId: 'execCommand', summary: 'Execute a command' } },
        '/health': { get: { operationId: 'healthCheck' } },
      },
    })
    const r = extractSchema([
      { path: 'api/openapi.json', content: openapiContent },
      {
        path: 'src/index.ts',
        content: `
server.tool('list_files', 'List directory contents', {}, handler)
server.tool('get_weather', 'Get the weather forecast', {}, handler2)
`,
      },
    ])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['get_weather', 'list_files'])
    expect(r.tools.map(t => t.name)).not.toContain('deleteUser')
    expect(r.tools.map(t => t.name)).not.toContain('execCommand')
    expect(r.findings.some(f => f.id === 'security/shell-exec-tool')).toBe(false)
    expect(r.findings.some(f => f.id === 'security/destructive-tool')).toBe(false)
  })

  it('an openapi.json ALONE (no source extractor found anything) still extracts operationIds, as the last rung', () => {
    const r = extractSchema([{
      path: 'api/openapi.json',
      content: JSON.stringify({ openapi: '3.0.0', paths: { '/search': { get: { operationId: 'search', summary: 'Search' } } } }),
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search'])
  })

  it('manifest JSON (mcp.json) still wins over BOTH source and openapi.json — first rung, unaffected by the reorder', () => {
    const r = extractSchema([
      { path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'manifest_tool', description: 'From the manifest' }] }) },
      { path: 'openapi.json', content: JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: { operationId: 'spec_tool' } } } }) },
      { path: 'src/index.ts', content: `server.tool('source_tool', 'From source', {}, h)` },
    ])
    expect(r.tools.map(t => t.name)).toEqual(['manifest_tool'])
  })
})
