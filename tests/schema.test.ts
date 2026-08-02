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

describe('extractSchema breadth fixes (P3)', () => {
  it('extracts modern server.registerTool() registrations, including the config-object description', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.registerTool("delete_file", {
  description: "Delete a file at the given path",
  inputSchema: { path: z.string() },
}, async ({ path }) => { /* ... */ })`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['delete_file'])
    expect(r.tools[0].description).toBe('Delete a file at the given path')
    expect(r.toolSurfaceRisk).toBe('medium')
  })

  it('extracts python imperative add_tool(name=...) registrations', () => {
    const r = extractSchema([{
      path: 'server.py',
      content: `mcp.add_tool(name="delete_record", description="Delete a record from the database")`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['delete_record'])
    expect(r.toolSurfaceRisk).toBe('medium')
  })

  it('extracts bare @mcp.tool decorators (no parens), split from def', () => {
    const r = extractSchema([{
      path: 'server.py',
      content: `@mcp.tool\ndef list_items() -> list:\n    """List items."""\n    ...\n`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['list_items'])
  })

  it('extracts low-level types.Tool(name=..., description=...) literals in a list_tools handler', () => {
    const r = extractSchema([{
      path: 'server.py',
      content: `
@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="execute_command",
            description="Execute a shell command on the host",
            inputSchema={"type": "object"},
        ),
    ]
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['execute_command'])
    expect(r.toolSurfaceRisk).toBe('high')
  })

  it('ListToolsRequestSchema fallback: a name: without an adjacent description/inputSchema sibling is not counted (logger/config phantom)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { ListToolsRequestSchema } from '@mcp/sdk'
const logger = { name: "app-logger", level: "info" }
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "search_docs", description: "Search documentation", inputSchema: { type: "object" } },
  ],
}))
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_docs'])
  })

  it('ListToolsRequestSchema fallback: new Server({name}) identity is not counted as a tool (drops the server-name phantom)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { ListToolsRequestSchema, Server } from '@mcp/sdk'
const server = new Server({ name: "tavily-mcp", version: "1.0.0" })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "tavily_search", description: "Search the web", inputSchema: {} },
  ],
}))
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['tavily_search'])
  })

  it('excludes non-server paths (tests/) from schema file selection', () => {
    const r = extractSchema([{
      path: 'tests/mcp_server.py',
      content: `@mcp.tool()\ndef fake_tool(x: int) -> int:\n    ...\n`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.toolSurfaceRisk).toBeUndefined()
  })

  it('dedupes duplicate tool names (across files) before counting/tokenizing', () => {
    const r = extractSchema([
      { path: 'src/a.ts', content: `server.tool('search', 'Search things', {}, h)` },
      { path: 'src/b.ts', content: `server.tool('search', 'Search things again', {}, h)` },
    ])
    expect(r.tools.map(t => t.name)).toEqual(['search'])
  })

  it('floors toolSurfaceRisk at medium when a fetched file imports child_process but no tools extract', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `import { execSync } from 'child_process'\n// glue code, no MCP tool registrations here\nexecSync('ls')\n`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.toolSurfaceRisk).toBe('medium')
  })

  it('does NOT floor toolSurfaceRisk when "spawn" only appears in a lockfile (cross-spawn transitive dep), not source', () => {
    const r = extractSchema([{
      path: 'package-lock.json',
      content: '{"packages":{"node_modules/cross-spawn":{"version":"7.0.3"}}}',
    }])
    expect(r.extracted).toBe(false)
    expect(r.toolSurfaceRisk).toBeUndefined()
  })

  it('still floors toolSurfaceRisk at medium for a real source file importing spawn from child_process', () => {
    const r = extractSchema([{
      path: 'src/run.ts',
      content: 'import { spawn } from "child_process"',
    }])
    expect(r.extracted).toBe(false)
    expect(r.toolSurfaceRisk).toBe('medium')
  })
})

describe('classify (P4): token-set matching for the NAME, \\b-anchored words for description', () => {
  const nameOnly = (name: string) => extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name }] }) }])

  it('get_execution_status is not high — "execution" is a noun, not the token "exec"/"execute"', () => {
    const r = nameOnly('get_execution_status')
    expect(r.toolSurfaceRisk).not.toBe('high')
    expect(r.toolSurfaceRisk).toBe('low') // "get"
  })

  it('list_dropdown_options is not medium — "dropdown" is not the token "drop"', () => {
    const r = nameOnly('list_dropdown_options')
    expect(r.toolSurfaceRisk).not.toBe('medium')
    expect(r.toolSurfaceRisk).toBe('low') // "list"
  })

  it('edit_file → medium', () => {
    expect(nameOnly('edit_file').toolSurfaceRisk).toBe('medium')
  })

  it('run_notebook → high', () => {
    expect(nameOnly('run_notebook').toolSurfaceRisk).toBe('high')
  })

  it('bash_command → high', () => {
    expect(nameOnly('bash_command').toolSurfaceRisk).toBe('high')
  })

  it('run_python → high', () => {
    expect(nameOnly('run_python').toolSurfaceRisk).toBe('high')
  })

  it('fork_repository → medium', () => {
    expect(nameOnly('fork_repository').toolSurfaceRisk).toBe('medium')
  })

  it('search_files is not high — token-set "search" is low, not a substring match on any high token', () => {
    const r = nameOnly('search_files')
    expect(r.toolSurfaceRisk).not.toBe('high')
    expect(r.toolSurfaceRisk).toBe('low')
  })

  it('benign add_numbers → none', () => {
    expect(nameOnly('add_numbers').toolSurfaceRisk).toBe('none')
  })

  it('a real word "delete" in the description counts even with a benign name', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{ name: 'process_item', description: 'delete the queued item' }] }),
    }])
    expect(r.toolSurfaceRisk).toBe('medium')
  })

  it('the noun "dropdown" in the description does not trigger the "drop" keyword', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{ name: 'render_widget', description: 'Render a dropdown menu' }] }),
    }])
    expect(r.toolSurfaceRisk).toBe('none')
  })

  it('camelCase names tokenize like snake_case (runPython → high)', () => {
    expect(nameOnly('runPython').toolSurfaceRisk).toBe('high')
  })
})

describe('classify (final review fix): schemaText (inputSchema property names) uses a STRONG exec-only subset, not the full name/description vocabulary', () => {
  it('a "command" property name on an otherwise-benign manifest tool does NOT inflate to high', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{
        name: 'get_config', description: 'Get configuration',
        inputSchema: { properties: { command: { type: 'string' } } },
      }] }),
    }])
    expect(r.toolSurfaceRisk).not.toBe('high')
    expect(['none', 'low']).toContain(r.toolSurfaceRisk)
  })

  it('an "update_frequency" property name does NOT inflate to medium', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{
        name: 'get_weather', inputSchema: { properties: { update_frequency: {} } },
      }] }),
    }])
    expect(r.toolSurfaceRisk).not.toBe('medium')
  })

  // Regressions — must stay exactly as before.
  it('regression: shell_exec in description/schemaText still → high', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{
        name: 'helper', description: 'wrapper around shell_exec', schemaText: 'shell_exec(cmd)',
      }] }),
    }])
    expect(r.toolSurfaceRisk).toBe('high')
  })
  it('regression: run_python → high', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'run_python' }] }) }])
    expect(r.toolSurfaceRisk).toBe('high')
  })
  it('regression: delete_file → medium', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'delete_file' }] }) }])
    expect(r.toolSurfaceRisk).toBe('medium')
  })
  it('regression: edit_file → medium', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'edit_file' }] }) }])
    expect(r.toolSurfaceRisk).toBe('medium')
  })
  it('regression: fetch_page → low', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'fetch_page' }] }) }])
    expect(r.toolSurfaceRisk).toBe('low')
  })
  it('regression: add_numbers → none', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'add_numbers' }] }) }])
    expect(r.toolSurfaceRisk).toBe('none')
  })
  it('regression: a real dangerous manifest tool (name + description) still → high', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{ name: 'run_command', description: 'Execute a shell command' }] }),
    }])
    expect(r.toolSurfaceRisk).toBe('high')
  })
})

describe('classify (P4 review fix): bare run/code demoted, co-occurrence rule, tokenized text channel', () => {
  const nameOnly = (name: string) => extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name }] }) }])

  // Negatives: bare "run"/"code" must not over-tier benign tools.
  it('zip_code_lookup is not high (bare "code" is ambiguous)', () => {
    expect(nameOnly('zip_code_lookup').toolSurfaceRisk).not.toBe('high')
  })
  it('run_report is not high (bare "run" is ambiguous)', () => {
    expect(nameOnly('run_report').toolSurfaceRisk).not.toBe('high')
  })
  it('area_code_finder is not high (bare "code" is ambiguous)', () => {
    expect(nameOnly('area_code_finder').toolSurfaceRisk).not.toBe('high')
  })
  it('description prose "status code ... run" is not high (run/code far apart, not a co-occurring compound)', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{ name: 'get_status', description: 'Returns the HTTP status code of the run' }] }),
    }])
    expect(r.toolSurfaceRisk).not.toBe('high')
  })

  // Positives: run/code or run/script co-occurring in one token group → high.
  it('run_code → high (run+code co-occurrence)', () => {
    expect(nameOnly('run_code').toolSurfaceRisk).toBe('high')
  })
  it('execute_script → high (execute+script co-occurrence)', () => {
    expect(nameOnly('execute_script').toolSurfaceRisk).toBe('high')
  })
  it('shell_exec embedded in description/schemaText is caught (underscore-in-text fix)', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{
        name: 'helper',
        description: 'Internal wrapper around shell_exec',
        inputSchema: { schemaText: 'shell_exec(cmd)' },
      }] }),
    }])
    expect(r.toolSurfaceRisk).toBe('high')
  })

  // Regression: must stay exactly as before.
  it('run_python → high', () => {
    expect(nameOnly('run_python').toolSurfaceRisk).toBe('high')
  })
  it('run_command → high', () => {
    expect(nameOnly('run_command').toolSurfaceRisk).toBe('high')
  })
  it('bash_command → high', () => {
    expect(nameOnly('bash_command').toolSurfaceRisk).toBe('high')
  })
  it('run_notebook → high', () => {
    expect(nameOnly('run_notebook').toolSurfaceRisk).toBe('high')
  })
  it('delete_file → medium', () => {
    expect(nameOnly('delete_file').toolSurfaceRisk).toBe('medium')
  })
  it('fetch_page → low', () => {
    expect(nameOnly('fetch_page').toolSurfaceRisk).toBe('low')
  })
  it('add_numbers → none', () => {
    expect(nameOnly('add_numbers').toolSurfaceRisk).toBe('none')
  })
  it('fork_repository → medium', () => {
    expect(nameOnly('fork_repository').toolSurfaceRisk).toBe('medium')
  })
})

// V4 (coverage-spec §3.4 TS): the 7 real-world idioms that were withholding
// flagship servers (fastmcp/discogs, sentry/metatool defineTool, supabase's
// keyed-factory, mongodb's class-based tools, cloudflare's wrapper+NAME_MAP).
// Every snippet below is shaped after the real repo named in its title.
describe('fromJsSource (V4): TS idiom pack — addTool/defineTool/keyed-factory/class-based/wrapper', () => {
  it('idiom 1+2: fastmcp server.addTool({name, description}) object literal → extracts name+description', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({
  name: 'search',
  description: 'Search the web for results',
  parameters: z.object({ query: z.string() }),
})
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search'])
    expect(r.tools[0].description).toBe('Search the web for results')
  })

  it('idiom 1+4: metatool positional defineTool("name", "description", ...) → extracts name+description', () => {
    const r = extractSchema([{
      path: 'src/tools.ts',
      content: `
defineTool('run_workflow', 'Run a saved workflow by id', {
  parameters: z.object({ id: z.string() }),
})
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['run_workflow'])
    expect(r.tools[0].description).toBe('Run a saved workflow by id')
  })

  it('idiom 3: supabase keyed-factory `list_organizations: tool({...})` inside a getSupabaseTools() fn → extracts the KEY as the name', () => {
    const r = extractSchema([{
      path: 'src/tools/index.ts',
      content: `
export function getSupabaseTools(server) {
  return {
    list_organizations: tool({
      description: 'Lists all organizations the user has access to',
      parameters: z.object({}),
      execute: async () => {},
    }),
  }
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['list_organizations'])
  })

  it('idiom 3: supabase keyed-factory guarded by an *mcp-utils* `tool` import (no getTools wrapper needed) → extracts the KEY', () => {
    const r = extractSchema([{
      path: 'src/tools/registry.ts',
      content: `
import { tool } from '../../shared/mcp-utils.js'

export const supabaseToolsRegistry = {
  list_organizations: tool({
    description: 'Lists all organizations the user has access to',
  }),
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['list_organizations'])
  })

  it('idiom 3 GUARD: `foo: bar({...})` with no tool/mcp-utils context is not extracted at all', () => {
    const r = extractSchema([{
      path: 'src/registry.ts',
      content: `
const registry = {
  foo: bar({
    description: 'not a real tool',
  }),
}
`,
    }])
    expect(r.extracted).toBe(false)
  })

  it('idiom 3 GUARD: `foo: tool({...})` outside any getTools()/mcp-utils context is not extracted (exercises the guard, not just the regex shape)', () => {
    const r = extractSchema([{
      path: 'src/unrelated.ts',
      content: `
function unrelatedHelper() {
  const registry = {
    foo: tool({
      description: 'not a real tool',
    }),
  }
  return registry
}
`,
    }])
    expect(r.extracted).toBe(false)
  })

  it('idiom 5: mongodb class-based tool `class FindTool extends MongoDBToolBase { name = "find" }` → extracts name+description fields', () => {
    const r = extractSchema([{
      path: 'src/tools/find.ts',
      content: `
class FindTool extends MongoDBToolBase {
  name = 'find'
  description = 'Run a find query against a MongoDB collection'
  async execute(args: FindArgs) {
    return this.db.collection(args.collection).find(args.filter).toArray()
  }
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['find'])
    expect(r.tools[0].description).toBe('Run a find query against a MongoDB collection')
  })

  it('idiom 6: cloudflare wrapper accountTool(NAME_MAP.key, {...}) resolved via sibling const map → extracts the mapped literal', () => {
    const r = extractSchema([{
      path: 'src/tools/accounts.ts',
      content: `
const TOOLS = {
  list: 'accounts_list',
  get: 'accounts_get',
}

function registerAccountTools(server) {
  server.accountTool(TOOLS.list, {
    description: 'List Cloudflare accounts',
  })
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['accounts_list'])
  })

  it('idiom 6 fallback: wrapper identifier with no resolvable sibling const map is still accepted as the raw name', () => {
    const r = extractSchema([{
      path: 'src/tools/unmapped.ts',
      content: `
function registerWidgetTools(server) {
  server.widgetTool(WIDGET_NAME, {
    description: 'Does widget things',
  })
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['WIDGET_NAME'])
  })

  it('idiom 7: discogs-style fastmcp tool-array object literal (no ListToolsRequestSchema handler) is picked up via the broadened sibling scan (name + parameters, no description)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'

const server = new FastMCP({ name: 'discogs-mcp', version: '1.0.0' })

const toolDefs = [
  { name: 'search_releases', parameters: { query: 'string' }, handler: searchReleases },
]

for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search_releases'])
  })

  it('idiom 7 GUARD: a resource object {name, description, uri} in a fastmcp file is NOT extracted as a tool', () => {
    const r = extractSchema([{ path: 'src/index.ts', content: `
      import { FastMCP } from 'fastmcp'
      server.addTool({ name: 'search_docs', description: 'Search the docs' })
      const resources = [{ name: 'config_file', description: 'The config', uri: 'file:///config.json' }]
    ` }])
    expect(r.tools.map(t => t.name)).toEqual(['search_docs'])
  })
  it('idiom 7 GUARD: objects under a resources: array are not tools', () => {
    const r = extractSchema([{ path: 'src/index.ts', content: `
      import { FastMCP } from 'fastmcp'
      const server = {
        tools: [{ name: 'run_query', description: 'Runs a query' }],
        resources: [{ name: 'schema_doc', description: 'Schema documentation' }],
      }
      server.addTool({ name: 'run_query', description: 'Runs a query' })
    ` }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['run_query'])
  })
  it('idiom 7 GUARD: a prompt object with mimeType is not a tool', () => {
    const r = extractSchema([{ path: 'src/index.ts', content: `
      import { FastMCP } from 'fastmcp'
      server.addTool({ name: 'real_tool', description: 'A real tool' })
      const p = { name: 'greeting_prompt', description: 'A prompt', mimeType: 'text/plain' }
    ` }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('regression: all idioms combined in one file still dedupe by name and keep prior extraction working', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.registerTool("delete_file", {
  description: "Delete a file at the given path",
  inputSchema: { path: z.string() },
}, async ({ path }) => { /* ... */ })
server.addTool({ name: 'search', description: 'Search things' })`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['delete_file', 'search'])
  })
})
