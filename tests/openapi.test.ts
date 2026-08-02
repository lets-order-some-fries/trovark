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
    const content = JSON.stringify([{ description: 'no name here' }, { name: 'valid_tool' }])
    const tools = fromToolDefinitions({ path: 'toolDefinitions.json', content })
    expect(tools.map(t => t.name)).toEqual(['valid_tool'])
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

  it('fromManifest (via the JSON dispatch) still accepts a top-level array, not only {tools:[...]}', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify([{ name: 'ping', description: 'Ping the server' }]),
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['ping'])
  })
})
