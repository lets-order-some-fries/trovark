import { describe, expect, it } from 'vitest'
import { extractSchema } from '../src/derive/schema.js'

describe('extractSchema ladder', () => {
  it('level 1: reads tools from mcp.json manifest', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [
        { name: 'search_docs', description: 'Search documentation' },
        { name: 'run_command', description: 'Execute a shell command', inputSchema: { type: 'object' } },
      ] }),
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search_docs', 'run_command'])
    expect(r.toolSurfaceRisk).toBe('high') // "Execute a shell command"
    expect(r.findings.some(f => f.id === 'security/shell-exec-tool' && f.evidence === 'mcp.json')).toBe(true)
    expect(r.schemaTokenEstimate).toBeGreaterThan(0)
  })
  it('level 2: extracts .tool() registrations from TS source', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.tool('list_files', 'List directory contents', {}, handler)
server.tool("delete_file", "Delete a file at path", {}, handler2)`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['delete_file', 'list_files'])
    expect(r.toolSurfaceRisk).toBe('medium') // delete
  })
  it('level 3: extracts python @tool decorators', () => {
    const r = extractSchema([{
      path: 'server.py',
      content: `@mcp.tool()\ndef fetch_page(url: str) -> str:\n    """Fetch a web page."""\n    ...\n`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools[0].name).toBe('fetch_page')
    expect(r.toolSurfaceRisk).toBe('low') // fetch/url
  })
  it('benign tools → risk none, no findings', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'add_numbers' }] }) }])
    expect(r.toolSurfaceRisk).toBe('none')
    expect(r.findings).toHaveLength(0)
  })
  it('nothing extractable → extracted false, risk/tokens undefined', () => {
    const r = extractSchema([{ path: 'README.md', content: '# hi' }])
    expect(r.extracted).toBe(false)
    expect(r.toolSurfaceRisk).toBeUndefined()
    expect(r.schemaTokenEstimate).toBeUndefined()
  })
})
