import { describe, expect, it } from 'vitest'
import { extractSchema, hasPythonToolRegistrationSurface } from '../src/derive/schema.js'

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
  it('CRITICAL GUARD: an unrelated "tools" field in package.json does NOT fabricate tools', () => {
    const r = extractSchema([{ path: 'package.json', content: JSON.stringify({
      name: 'my-cli-app', version: '1.0.0',
      tools: [{ name: 'dev', description: 'dev environment launcher' }, { name: 'build', description: 'production build' }],
    }) }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })
  it('a real mcp.json manifest still extracts', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'search_docs', description: 'Search' }] }) }])
    expect(r.tools.map(t => t.name)).toEqual(['search_docs'])
  })
  it('toolDefinitions.json still extracts (allowlisted basename)', () => {
    const r = extractSchema([{ path: 'src/toolDefinitions.json', content: JSON.stringify([{ name: 'find_issue', description: 'Find an issue' }]) }])
    expect(r.tools.map(t => t.name)).toEqual(['find_issue'])
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

// Final review Fix 3 (pre-existing precision bug): FastMCP's mandatory
// `execute:` handler property key is code STRUCTURE, not tool semantics, but
// riskFromSchemaText tokenized schemaText (the raw captured object-literal
// source, including its handler key) and matched "execute" as a STRONG_EXEC
// token — so EVERY tool in a FastMCP-shaped server (e.g.
// cswkim/discogs-mcp-server) was flagged security/shell-exec-tool HIGH
// regardless of what the tool actually does. Fixed by stripping structural/
// handler property-key positions (execute|handler|callback|run|fn|method|cb|
// resolve|invoke, each followed by `:`) from schemaText before risk
// tokenization — genuine content (a shell_exec(cmd) call, a child_process
// import, a param literally named shell_command) is untouched.
describe('classify (final review Fix 3): structural handler keys (execute:/handler:/etc.) in schemaText are not risk signal', () => {
  it("FastMCP tool object literal with a mandatory `execute:` handler key is NOT flagged high from that key alone", () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({
  name: 'search_releases',
  description: 'Search the Discogs API',
  parameters: { query: 'string' },
  execute: async () => {},
})
`,
    }])
    expect(r.toolSurfaceRisk).not.toBe('high')
    expect(['none', 'low']).toContain(r.toolSurfaceRisk)
  })

  it('keeps passing: genuine shell_exec(cmd) content in schemaText is still high even alongside a stripped execute: key', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({
  name: 'run_helper',
  description: 'A helper tool',
  parameters: { query: 'string' },
  execute: async ({ query }) => { return shell_exec(query) },
})
`,
    }])
    expect(r.toolSurfaceRisk).toBe('high')
  })

  it('keeps passing: run_command by NAME is still high', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'run_command' }] }) }])
    expect(r.toolSurfaceRisk).toBe('high')
  })

  it('keeps passing: bash_command by NAME is still high', () => {
    const r = extractSchema([{ path: 'mcp.json', content: JSON.stringify({ tools: [{ name: 'bash_command' }] }) }])
    expect(r.toolSurfaceRisk).toBe('high')
  })

  it('keeps passing: a "command" property name on an otherwise-benign manifest tool still does NOT inflate to high', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [{
        name: 'get_config', description: 'Get configuration',
        inputSchema: { properties: { command: { type: 'string' } } },
      }] }),
    }])
    expect(r.toolSurfaceRisk).not.toBe('high')
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

  // I6: the "accept the raw identifier as the name" fallback was dropped — a
  // miss beats a garbage name (e.g. `TOOL_REQUEST`, `TOOL_NAMES.search`
  // published verbatim as a "tool"). See the I6 describe block below for the
  // full coverage of this change.
  it('idiom 6 (I6): a wrapper identifier with no resolvable sibling const map extracts NO tool, not the raw identifier', () => {
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
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
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

  // I4 + I5: the broadened idiom-7 whole-file scan only guarded resources:/
  // prompts: collection KEYS and uri/mimeType shapes — it did not know about
  // registration CALLS other than addTool, and did not scope out nested
  // arguments:/properties: bags. Reviewer verified fastmcp's addPrompt(...)
  // (with a nested `arguments:` array of {name, description} objects) and a
  // config array nested under a `properties:` key both leaked fake tools.
  it('I4: server.addPrompt({name, description, arguments:[{name, description}]}) is not extracted as a tool — nor is its nested argument', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({ name: 'real_tool', description: 'A real tool' })
server.addPrompt({
  name: 'summarize_thread',
  description: 'Summarize a thread',
  arguments: [{ name: 'thread_id', description: 'Thread ID to summarize' }],
  load: async (args) => '...',
})
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('I4: server.addResource({name, description, uri}) and server.addResourceTemplate(...) calls are not extracted as tools', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({ name: 'real_tool', description: 'A real tool' })
server.addResource({ name: 'config_file', description: 'The config file', uri: 'file:///config.json' })
server.addResourceTemplate({ name: 'log_file', description: 'A log file', uriTemplate: 'file:///logs/{id}.log' })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('I5: a config array nested under a properties: key is not extracted as tools', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({ name: 'real_tool', description: 'A real tool' })
const CONFIG_SCHEMA = {
  properties: [
    { name: 'port', description: 'Port to listen on' },
    { name: 'verbose', description: 'Enable verbose logging' },
  ],
}
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  // I6: WRAPPER_TOOL_CALL_RE also matched USE calls, not just registration
  // calls (`.callTool(`, `.getTool(`, `.removeTool(`, `.hasTool(`) — reviewer
  // verified `client.callTool(TOOL_REQUEST, {cursor:1})` published a tool
  // named `TOOL_REQUEST`. Restricted to registration-verb wrappers; combined
  // with dropping the raw-identifier fallback above, an unresolvable name now
  // emits no tool instead of garbage.
  describe('I6: wrapper idiom restricted to registration verbs; unresolved identifiers emit no tool', () => {
    it('client.callTool(TOOL_REQUEST, {...}) is a USE, not a registration — extracts no tool', () => {
      const r = extractSchema([{ path: 'src/client.ts', content: `client.callTool(TOOL_REQUEST, { cursor: 1 })` }])
      expect(r.extracted).toBe(false)
      expect(r.tools).toEqual([])
    })
    it('getTool/removeTool/hasTool calls are likewise excluded from the wrapper idiom', () => {
      const r = extractSchema([{
        path: 'src/client.ts',
        content: `
server.getTool(SOME_ID, { x: 1 })
server.removeTool(SOME_ID, { x: 1 })
server.hasTool(SOME_ID, { x: 1 })
`,
      }])
      expect(r.extracted).toBe(false)
      expect(r.tools).toEqual([])
    })
    it('server.registerTool(TOOL_NAMES.search, {...}) with no resolvable const map emits NO tool (not the raw identifier)', () => {
      const r = extractSchema([{
        path: 'src/tools/search.ts',
        content: `server.registerTool(TOOL_NAMES.search, { description: 'Search things' })`,
      }])
      expect(r.extracted).toBe(false)
      expect(r.tools).toEqual([])
    })
    it('a resolvable const map still extracts the mapped literal (regression, unaffected by the registration-verb restriction)', () => {
      const r = extractSchema([{
        path: 'src/tools/accounts.ts',
        content: `
const TOOLS = { list: 'accounts_list' }
server.accountTool(TOOLS.list, { description: 'List accounts' })
`,
      }])
      expect(r.extracted).toBe(true)
      expect(r.tools.map(t => t.name)).toEqual(['accounts_list'])
    })
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

// Coverage-v1.3 review: the "nearest preceding key/call by raw text index"
// guards used by the idiom-7 whole-file scan above had NO brace/scope
// awareness, so they silently DROPPED real tools rather than merely
// over-extracting fake ones — worse than the bug they were meant to fix.
// Replaced with POSITIVE, scope-aware containment: a {name,...} candidate is
// accepted only when it is genuinely reachable from a tool-registration
// context (an addTool/registerTool/tool/defineTool call's argument span, a
// `tools:` key's value span, or a /tool/i-named array literal), never by
// text-proximity to the nearest preceding key/call.
describe('idiom 7 v2: positive scope-aware containment (replaces nearest-preceding-key/call heuristics)', () => {
  it("REGRESSION: both tools in a toolDefs array survive — an earlier tool's inputSchema.properties no longer swallows every later tool", () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const toolDefs = [
  { name: 'search_releases', description: 'Search releases', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'get_release', description: 'Get a release by id' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['get_release', 'search_releases'])
  })

  it('REGRESSION: an addPrompt(...) call before a toolDefs array no longer erases the entire tool surface', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addPrompt({ name: 'greeting', description: 'A greeting prompt' })
const toolDefs = [
  { name: 'search_releases', description: 'Search releases', parameters: { query: 'string' } },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_releases'])
    expect(r.tools.some(t => t.name === 'greeting')).toBe(false)
  })

  it('GUARD: a bare config array not named /tool/i still yields no phantom tools, even with two items, alongside a real tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const options = [
  { name: 'port', description: 'Port to listen on' },
  { name: 'verbose', description: 'Verbose logging' },
]
server.addTool({ name: 'real_tool', description: 'A real tool' })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('GUARD: addPrompt with a nested arguments array leaks neither the prompt nor its argument', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addPrompt({ name: 'summarize_thread', description: 'd', arguments: [{ name: 'thread_id', description: 'd' }] })
server.addTool({ name: 'get_weather', description: 'd' })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['get_weather'])
  })

  it('GUARD: the resource-shape safety net still rejects a uri-carrying object even when it sits inside an accepted /tool/i-named array', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const toolDefs = [
  { name: 'file_resource', description: 'Looks like a tool but is not', uri: 'file:///x' },
  { name: 'real_tool', description: 'A real tool' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('GUARD: new Server({name}) is still not a tool (subsumed by positive scoping — no registration call/tools-key/tool-array contains it)', () => {
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

  // Live spot-check regression (v1.3 coverage): discogs-mcp-server, a real
  // fastmcp flagship server, never passes an object literal to `.addTool(`
  // at all — every tool is a top-level named const registered by bare-
  // identifier reference. Pure positive scoping (accepted spans only around
  // the literal `.addTool(` call argument) rejected 100% of this repo's
  // tools until rule (a) was extended to resolve the identifier back to its
  // declaring `const IDENT = {...}` object literal.
  it('REGRESSION: discogs-mcp-server-style named Tool consts registered by bare identifier (server.addTool(searchTool)) are extracted', () => {
    const r = extractSchema([{
      path: 'src/tools/database.ts',
      content: `
import { FastMCP, Tool } from 'fastmcp'

export const searchTool: Tool<FastMCPSessionAuth, typeof SearchParamsSchema> = {
  name: 'search',
  description: 'Issue a search query to the Discogs database',
  parameters: SearchParamsSchema,
  execute: async (args) => {
    return JSON.stringify(args)
  },
}

export const getArtistTool: Tool<FastMCPSessionAuth, typeof ArtistIdParamSchema> =
  {
    name: 'get_artist',
    description: 'Get an artist',
    parameters: ArtistIdParamSchema,
    execute: async (args) => {
      return JSON.stringify(args)
    },
  }

export function registerDatabaseTools(server: FastMCP): void {
  server.addTool(searchTool)
  server.addTool(getArtistTool)
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['get_artist', 'search'])
  })
})

// Final review Fix 1: rule (c) of acceptedToolSpans (TOOL_NAMED_ARRAY_RE)
// accepted an assigned identifier via a raw /tool/i SUBSTRING test, so
// `toolbarItems`/`toolkitConfig`/`coolTools`-shaped identifiers that merely
// CONTAIN "tool" as a substring (not as a token) were wrongly treated as
// tool-definition arrays. Reviewer verified `toolbarItems` fabricated phantom
// tools `save`/`open`. Fixed by requiring an identifier-BOUNDARY match: the
// identifier is tokenized (same tokenizer as risk classification) and only
// accepted if a token is exactly `tool` or `tools`.
describe('idiom 7 v3 (Fix 1): tool-named-array identifier match uses token boundaries, not raw substring', () => {
  it("REGRESSION: `toolbarItems` (contains \"tool\" only as a substring of \"toolbar\") does not fabricate phantom tools", () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({ name: 'real_tool', description: 'A real tool' })
const toolbarItems = [
  { name: 'save', description: 'Save' },
  { name: 'open', description: 'Open' },
]
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('REGRESSION: `toolkitConfig` (substring "tool" inside "toolkit") does not fabricate phantom tools', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const server = new FastMCP({ name: 'my-server', version: '1.0.0' })
server.addTool({ name: 'real_tool', description: 'A real tool' })
const toolkitConfig = [
  { name: 'x', description: 'y' },
]
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('keeps passing: `toolDefs` (token "tool") still extracts', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const toolDefs = [
  { name: 'search_releases', description: 'Search releases' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_releases'])
  })

  it('keeps passing: `TOOLS` (whole identifier is the token "tools") still extracts', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const TOOLS = [
  { name: 'search_releases', description: 'Search releases' },
]
for (const t of TOOLS) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_releases'])
  })

  it('keeps passing: `searchTools` (token "tools" after camelCase split) still extracts', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const searchTools = [
  { name: 'search_web', description: 'Search the web' },
]
for (const t of searchTools) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_web'])
  })

  it('legitimately contains the token "tools": `coolTools` still extracts', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const coolTools = [
  { name: 'search_web', description: 'Search the web' },
]
for (const t of coolTools) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_web'])
  })
})

// Final review Fix 2 (walked-back regression): once a candidate's enclosing
// span is accepted, there was no exclusion for a {name,description} object
// nested inside a NON-TOOL sub-key of that accepted span — e.g. a param
// object under `inputSchema.properties.<field>` or under a `parameters:`
// array. The old (deleted) "nearest preceding key by text index" guard used
// to catch this; positive scoping alone did not. Reviewer verified
// server.addTool({name:'outer_tool',...,inputSchema:{properties:{filter:
// {name:'inner_name_field',...}}}}) extracted BOTH outer_tool and
// inner_name_field. Fixed with a scope-aware (containment-based, not
// text-index) walk: within an accepted span, reject a candidate nested under
// a properties:/arguments:/inputSchema:/parameters: sub-object.
describe('idiom 7 v4 (Fix 2): candidates nested under properties:/arguments:/inputSchema:/parameters: within an accepted span are rejected', () => {
  it('REGRESSION: a {name,description} object nested under inputSchema.properties.<field> is not extracted as a second tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({name:'outer_tool',description:'d',inputSchema:{properties:{filter:{name:'inner_name_field',description:'...',type:'string'}}}})
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['outer_tool'])
  })

  it('a {name,...} array element nested under a `parameters:` array is not extracted as a second tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({
  name: 'outer_tool2',
  description: 'd',
  parameters: [
    { name: 'username', type: 'string', description: 'd' },
  ],
})
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['outer_tool2'])
  })

  it('keeps passing: toolDefs two-tool array still extracts both tools (not nested under an excluded key)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
const toolDefs = [
  { name: 'search_releases', description: 'Search releases', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'get_release', description: 'Get a release by id' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['get_release', 'search_releases'])
  })

  it('keeps passing: bare-identifier registration (discogs-style named Tool consts) still extracts both tools', () => {
    const r = extractSchema([{
      path: 'src/tools/database.ts',
      content: `
import { FastMCP, Tool } from 'fastmcp'

export const searchTool: Tool<FastMCPSessionAuth, typeof SearchParamsSchema> = {
  name: 'search',
  description: 'Issue a search query to the Discogs database',
  parameters: SearchParamsSchema,
  execute: async (args) => {
    return JSON.stringify(args)
  },
}

export const getArtistTool: Tool<FastMCPSessionAuth, typeof ArtistIdParamSchema> =
  {
    name: 'get_artist',
    description: 'Get an artist',
    parameters: ArtistIdParamSchema,
    execute: async (args) => {
      return JSON.stringify(args)
    },
  }

export function registerDatabaseTools(server: FastMCP): void {
  server.addTool(searchTool)
  server.addTool(getArtistTool)
}
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['get_artist', 'search'])
  })

  it('keeps passing: discogs manifest shape (mcp.json) is unaffected by the JS-source containment walk', () => {
    const r = extractSchema([{
      path: 'mcp.json',
      content: JSON.stringify({ tools: [
        { name: 'search_docs', description: 'Search documentation' },
      ] }),
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_docs'])
  })

  it('keeps passing: addPrompt-before-tools regression is unaffected', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addPrompt({ name: 'greeting', description: 'A greeting prompt' })
const toolDefs = [
  { name: 'search_releases', description: 'Search releases', parameters: { query: 'string' } },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_releases'])
    expect(r.tools.some(t => t.name === 'greeting')).toBe(false)
  })
})

// W4 (coverage-v1.4, Part B): a reviewer verified that EXCLUDED_NESTED_KEYS
// (an allowlist of 4 keys: properties/arguments/inputSchema/parameters) is
// inherently incomplete — any OTHER non-tool key nested inside an accepted
// tool span (e.g. a `metadata:` bag) still lets a nested {name,description}
// object fabricate a second, phantom tool. Replaced with a principled,
// depth-based rule: a candidate is accepted only when its `name:` sits at
// the accepted span's OWN top-level object (depth 0, when the span opens
// with `{` — a resolved const-object arg, an R1 object-const, a `tools: {}`
// value), or as a direct array/call-arg ELEMENT one bracket in from the
// span's own `[`/`(` opener (depth 1 — a `tools:` array, a tool-named array
// literal, or a registration call's argument list). Anything strictly
// deeper is rejected, for ANY key name — not just the 4 previously
// enumerated ones.
describe('W4 (coverage-v1.4, Part B): depth-based rejection of nested non-tool sub-objects (replaces the 4-key allowlist)', () => {
  it('FABRICATION (reviewer-verified): a metadata:{name,description} nested inside an accepted addTool call no longer produces a second tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({ name:'outer_tool', description:'d', metadata:{ name:'inner_meta_name', description:'d' } })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['outer_tool'])
  })

  it('a metadata:{name,description} nested inside an R1 object-const tool span is likewise rejected (not just the addTool-call shape)', () => {
    const r = extractSchema([{
      path: 'src/tools/search.ts',
      content: `
const searchTool = {
  name: 'search',
  description: 'Search the web',
  metadata: { name: 'nested_name', description: 'Not a real tool' },
}
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search'])
  })

  it('REGRESSION: a real tools ARRAY still extracts both direct elements (array elements are depth 1, not rejected)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const toolDefs = [
  { name: 'a', description: 'd' },
  { name: 'b', description: 'd' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['a', 'b'])
  })

  it('REGRESSION: a simple server.addTool({name,description}) with no nesting still extracts', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.addTool({name:'x',description:'d'})`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['x'])
  })

  it('REGRESSION: the existing properties:/parameters: nested-key cases still reject the nested candidate (allowlist replaced, not weakened)', () => {
    const r1 = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({name:'outer_tool',description:'d',inputSchema:{properties:{filter:{name:'inner_name_field',description:'...',type:'string'}}}})
`,
    }])
    expect(r1.tools.map(t => t.name)).toEqual(['outer_tool'])

    const r2 = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({
  name: 'outer_tool2',
  description: 'd',
  parameters: [
    { name: 'username', type: 'string', description: 'd' },
  ],
})
`,
    }])
    expect(r2.tools.map(t => t.name)).toEqual(['outer_tool2'])
  })
})

// V5 (coverage-spec §3.4 Python): serena's class-subclass idiom and
// awslabs' call-decorator idiom, plus the register_*_tools surface signal
// (which must never fabricate a tool — see the GUARD test below and the
// classifyLibrary wiring in classify.test.ts).
describe('fromPySource (V5): Python class-subclass + call-decorator idioms', () => {
  it('serena-style class ReadFileTool(Tool): -> read_file (CamelCase minus trailing Tool -> snake_case), description from apply() docstring', () => {
    const r = extractSchema([{
      path: 'src/serena/tools/file_tools.py',
      content: `
class ReadFileTool(Tool):
    """Reads the contents of a file."""

    def apply(self, relative_path: str) -> str:
        """Read the file contents at the given path."""
        ...
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['read_file'])
    expect(r.tools[0].description).toBe('Read the file contents at the given path.')
  })

  it('serena-style class DeleteLinesTool(EditingTool): -> delete_lines', () => {
    const r = extractSchema([{
      path: 'src/serena/tools/edit_tools.py',
      content: `
class DeleteLinesTool(EditingTool):
    def apply(self, start_line: int, end_line: int) -> None:
        ...
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['delete_lines'])
  })

  it('GUARD: a class whose name does not end in Tool is not extracted', () => {
    const r = extractSchema([{
      path: 'src/serena/helpers.py',
      content: `
class HelperThing(Base):
    def apply(self):
        ...
`,
    }])
    expect(r.extracted).toBe(false)
  })

  it('GUARD: a *Tool class whose base is not Tool-ish (Tool/EditingTool*/BaseTool) is not extracted', () => {
    const r = extractSchema([{
      path: 'src/serena/other.py',
      content: `
class FooTool(Base):
    def apply(self):
        ...
`,
    }])
    expect(r.extracted).toBe(false)
  })

  it('awslabs call-decorator mcp.tool()(docs.search_agentcore_docs) -> search_agentcore_docs (last dotted segment)', () => {
    const r = extractSchema([{
      path: 'src/awslabs/server.py',
      content: `mcp.tool()(docs.search_agentcore_docs)`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search_agentcore_docs'])
  })

  it('GUARD: register_search_tools(mcp) is a surface signal only — it does NOT emit a fake tool', () => {
    const r = extractSchema([{
      path: 'src/awslabs/server.py',
      content: `def setup(mcp):\n    register_search_tools(mcp)\n`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })
})

// W4 (coverage-v1.4): Python idiom pack 2 (spec §3 R2) — replaces the
// imperative matcher to handle LEADING POSITIONAL ARGS (qdrant's
// `self.add_tool(self.find, name="qdrant-find", ...)`, where the old regex
// anchored `add_tool(` directly to `name=` and could never skip a leading
// positional) and F-STRING name values (gget-mcp's `name=f"{prefix}gget_ref"`
// — the `f?["'](?:\{[^}]*\})?` prefix skips the `f"` marker and any leading
// `{...}` interpolation, capturing the literal tail). Also widens
// PY_CALL_DECORATOR_RE's receiver beyond a bare `mcp.` and widens the
// registration-surface signal beyond the single `register_X_tools(` shape.
describe('W4 (coverage-v1.4): Python idiom pack 2 — positional-arg imperative, f-string names, wider decorators/registration-surface', () => {
  it('qdrant-style: self.add_tool(self.find, name="qdrant-find", description="Find memories") -> qdrant-find (leading positional arg skipped)', () => {
    const r = extractSchema([{
      path: 'src/mcp_server_qdrant/mcp_server.py',
      content: `
self.add_tool(self.find, name="qdrant-find", description="Find memories")
self.add_tool(self.store, name="qdrant-store", description="Store memories")
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['qdrant-find', 'qdrant-store'])
    expect(r.tools.find(t => t.name === 'qdrant-find')?.description).toBe('Find memories')
  })

  it('gget-mcp-style: name=f"{prefix}gget_ref" (f-string with a leading interpolation) resolves to the literal tail gget_ref', () => {
    const r = extractSchema([{
      path: 'src/gget_mcp/server.py',
      content: `self.add_tool(self.gget_ref, name=f"{prefix}gget_ref", description="Get gene reference")`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['gget_ref'])
  })

  it('self.tool() call-decorator form: self.tool()(self.find_memories) -> find_memories (widened receiver, not just bare mcp.)', () => {
    const r = extractSchema([{
      path: 'src/server.py',
      content: `self.tool()(self.find_memories)`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['find_memories'])
  })

  it('regression: bare mcp.tool()(...) call-decorator form (awslabs) still works after widening the receiver class', () => {
    const r = extractSchema([{
      path: 'src/awslabs/server.py',
      content: `mcp.tool()(docs.search_agentcore_docs)`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_agentcore_docs'])
  })

  it('GUARD: a tool(...)/add_tool(...) call with NO name= kwarg emits no tool (the name= literal anchor prevents fabrication)', () => {
    const r = extractSchema([{
      path: 'src/server.py',
      content: `mcp.add_tool(some_fn)`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })

  it('wider registration-surface signal: setup_tools(mcp) / add_search_tools(mcp) are detected as an MCP-tool-registration surface (widened beyond register_X_tools)', () => {
    expect(hasPythonToolRegistrationSurface([{ path: 'src/server.py', content: 'def setup(mcp):\n    setup_tools(mcp)\n' }])).toBe(true)
    expect(hasPythonToolRegistrationSurface([{ path: 'src/server.py', content: 'def setup(mcp):\n    add_search_tools(mcp)\n' }])).toBe(true)
  })

  it('regression: the original register_search_tools(mcp) shape is still detected by the widened registration-surface signal', () => {
    expect(hasPythonToolRegistrationSurface([{ path: 'src/server.py', content: 'register_search_tools(mcp)' }])).toBe(true)
  })

  it('the registration-surface signal never emits a fake tool on its own — extractSchema still returns nothing for a bare setup_tools(mcp) call', () => {
    const r = extractSchema([{ path: 'src/server.py', content: 'def setup(mcp):\n    setup_tools(mcp)\n' }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })
})

describe('W2 (coverage-v1.4): prefixed openapi/swagger basenames + tools.json manifest', () => {
  it('extracts operationIds from a prefixed notion-style basename (scripts/notion-openapi.json)', () => {
    const content = JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/v1/search': { post: { operationId: 'post-search', summary: 'Search' } },
        '/v1/users/me': { get: { operationId: 'get-self', summary: 'Get current user' } },
      },
    })
    const r = extractSchema([{ path: 'scripts/notion-openapi.json', content }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['get-self', 'post-search'])
  })

  it('GUARD: fixture/example spec paths are still excluded from extraction (non-server paths)', () => {
    const content = JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: { operationId: 'x' } } } })
    expect(extractSchema([{ path: '__tests__/fixture-openapi.json', content }]).extracted).toBe(false)
    expect(extractSchema([{ path: 'examples/openapi.json', content }]).extracted).toBe(false)
  })

  it('regression: plain openapi.json (no prefix) still extracts', () => {
    const content = JSON.stringify({ openapi: '3.0.0', paths: { '/ping': { get: { operationId: 'ping' } } } })
    const r = extractSchema([{ path: 'openapi.json', content }])
    expect(r.tools.map(t => t.name)).toEqual(['ping'])
  })

})

// W3 (coverage-v1.4): TS idiom pack 2 — object-const tool literals (R1),
// scalar-const name resolution (R1b), lowercase wrapper identifiers (R3),
// factory-returned arrays (R4), and sibling-key/entry-gate relaxation (R5).
// Every snippet is shaped after the real repo named in its title (verified
// live against browserbase/mcp-server-browserbase, brave/brave-search-mcp-server,
// executeautomation/mcp-playwright, and awdr74100/figwright).
describe('W3 (coverage-v1.4): TS idiom pack 2 — object-const, scalar-const names, factory arrays, wrapper idents', () => {
  it('R1: browserbase-style const typed `: ToolSchema<...>` (identifier has no "tool" token at all) is extracted via the type annotation', () => {
    const r = extractSchema([{
      path: 'src/tools/act.ts',
      content: `
import type { Tool, ToolSchema } from './tool.js'

const actSchema: ToolSchema<typeof ActInputSchema> = {
  name: 'act',
  description: 'Perform an action on the page',
  inputSchema: ActInputSchema,
}

const actTool: Tool<typeof ActInputSchema> = {
  capability: 'core',
  schema: actSchema,
  handle: handleAct,
}

export default actTool
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['act'])
  })

  it('R1: a plain `const searchTool = {...}` (identifier tokenizes to "tool", no type annotation needed) is extracted', () => {
    const r = extractSchema([{
      path: 'src/tools/search.ts',
      content: `
const searchTool = {
  name: 'search',
  description: 'Search the web for results',
}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search'])
  })

  it('R1 GUARD: an unrelated `const config = {name,description}` (no tool token, no Tool type) is NOT extracted', () => {
    const r = extractSchema([{
      path: 'src/config.ts',
      content: `
const config = {
  name: 'x',
  description: 'y',
}
`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })

  it('R1b: figwright-style `name: PING_TOOL_NAME` (identifier, not a string literal) resolves via a same-file scalar const', () => {
    const r = extractSchema([{
      path: 'packages/mcp/src/tools/ping.ts',
      content: `
export const PING_TOOL_NAME = 'ping';

export const pingTool = {
  name: PING_TOOL_NAME,
  description: 'Health check.',
  inputShape: {},
  kind: 'read',
};
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['ping'])
  })

  it('R3: brave-style lowercase wrapper identifier (mcpServer.registerTool(name, {...})) resolves via a same-file scalar const', () => {
    const r = extractSchema([{
      path: 'src/tools/web/index.ts',
      content: `
export const name = 'brave_web_search';
export const description = 'Performs web searches using the Brave Search API.';

export const register = (mcpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: description,
      inputSchema: params.shape,
    },
    execute
  );
};
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['brave_web_search'])
  })

  it('R3 GUARD: an unresolvable lowercase wrapper identifier still emits no tool (widened character class does not fabricate)', () => {
    const r = extractSchema([{
      path: 'src/tools/mystery.ts',
      content: `server.registerTool(mysteryName, { description: 'Does something' })`,
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })

  it('R4: a factory function returning an array of 6 tools (>4000 chars) proves the 400k captureBalanced limit, not the 4000 default', () => {
    const longDesc = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(20)
    const toolNames = ['alpha_tool', 'beta_tool', 'gamma_tool', 'delta_tool', 'epsilon_tool', 'zeta_tool']
    const body = toolNames.map(n => `    {
      name: "${n}",
      description: "${longDesc}",
      inputSchema: { type: "object", properties: {} },
    },`).join('\n')
    const content = `
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

function createToolDefinitions() {
  return [
${body}
  ]
}
`
    expect(content.length).toBeGreaterThan(4000)
    const r = extractSchema([{ path: 'src/tools.ts', content }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual([...toolNames].sort())
  })

  it('R5: .registerTool( entry point + a `schema:` sibling (olostep-style, not inputSchema) is extracted — entry-gate widening + SIBLING_RE gaining `schema`', () => {
    const r = extractSchema([{
      path: 'src/tools/scrapeWebsite.ts',
      content: `
server.registerTool({
  name: 'scrape_website',
  schema: { url: 'string' },
})
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['scrape_website'])
  })

  it('GUARD: a nested properties:{filter:{name,description}} inside a real tool is still not extracted as a second tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({
  name: 'outer_tool',
  description: 'd',
  inputSchema: { properties: { filter: { name: 'inner_name_field', description: 'd', type: 'string' } } },
})
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['outer_tool'])
  })

  it('GUARD: `const toolbarItems = [...]` still does not fabricate tools (identifier-boundary rule, unaffected by W3)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
import { FastMCP } from 'fastmcp'
server.addTool({ name: 'real_tool', description: 'A real tool' })
const toolbarItems = [
  { name: 'save', description: 'Save' },
]
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })
})

describe('W2 (coverage-v1.4 continued): manifest basename tests', () => {
  it('a tools.json manifest ({tools:[...]} shape) is parsed (olostep-style)', () => {
    const r = extractSchema([{
      path: 'tools.json',
      content: JSON.stringify({ tools: [{ name: 'search_web', description: 'Search the web' }] }),
    }])
    expect(r.tools.map(t => t.name)).toEqual(['search_web'])
  })

  it('a tools.json manifest (bare top-level array shape) is also parsed', () => {
    const r = extractSchema([{
      path: 'tools.json',
      content: JSON.stringify([{ name: 'list_pages', description: 'List pages' }]),
    }])
    expect(r.tools.map(t => t.name)).toEqual(['list_pages'])
  })

  it('GUARD: an unrelated "tools" field in package.json still does NOT fabricate tools', () => {
    const r = extractSchema([{
      path: 'package.json',
      content: JSON.stringify({ name: 'my-cli-app', tools: [{ name: 'dev', description: 'dev launcher' }] }),
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })

  it('GUARD: a random config.json is not treated as a manifest or spec', () => {
    const r = extractSchema([{
      path: 'config.json',
      content: JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: { operationId: 'x' } } } }),
    }])
    expect(r.extracted).toBe(false)
    expect(r.tools).toEqual([])
  })
})

describe('coverage-v1.4 (bracket-scanning fix): captureBalanced/bracketDepthAt/enclosingObjectSpan are now string- and comment-aware', () => {
  it('FABRICATION: a stray `}` inside a description no longer fabricates a nested metadata object as a phantom tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({ name:'real_tool', description:'unbalanced } here', metadata:{ name:'phantom', description:'d' } })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('FABRICATION: a stray `]` inside a description does not desync the unified bracket-depth counter either', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({ name:'real_tool', description:'unbalanced ] here', metadata:{ name:'phantom', description:'d' } })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('FABRICATION: a stray `)` inside a description does not desync the unified bracket-depth counter either', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
server.addTool({ name:'real_tool', description:'unbalanced ) here', metadata:{ name:'phantom', description:'d' } })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('COVERAGE: a stray `{` inside a description no longer truncates captureBalanced (single-tool case)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.addTool({ name:'a', description:'contains { stray brace' })`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['a'])
  })

  it('COVERAGE: a stray `{` in one array tool no longer swallows a later real tool in the same array', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const toolDefs = [
  { name: 'a', description: 'has { brace' },
  { name: 'b', description: 'd' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['a', 'b'])
  })

  it('COVERAGE: a backslash-escaped quote inside a description does not desync string-boundary detection for a later tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const toolDefs = [
  { name: 'a', description: 'it\\'s fine }' },
  { name: 'b', description: 'plain' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['a', 'b'])
  })

  it('COMMENT SAFETY: a commented-out addTool call is not extracted as a tool', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
// server.addTool({name:'commented_out'})
server.addTool({ name: 'real_tool', description: 'A real tool' })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })

  it('COMMENT SAFETY: a block comment containing an unbalanced brace does not desync a later real tool in the same array', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const toolDefs = [
  { name: 'a', description: 'd' },
  /* legacy note: single stray brace { without a match */
  { name: 'b', description: 'd' },
]
for (const t of toolDefs) server.addTool(t)
`,
    }])
    expect(r.tools.map(t => t.name).sort()).toEqual(['a', 'b'])
  })

  // Found live (not in the original fix spec): the first cut of the
  // comment-safety lexer treated ANY bare `/` as a potential comment start
  // and, if it turned out not to be one (division, a regex literal), broke
  // out of its "plain code" scan without advancing — an infinite loop that
  // hung on real-world source (executeautomation/mcp-playwright) until
  // `stripComments`'s array-builder overflowed with `RangeError: Invalid
  // array length`. Locking this in so it can't regress silently.
  it('REGRESSION: a bare `/` (division, not a comment) does not hang or desync the scanner', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `
const half = 10 / 2
server.addTool({ name: 'real_tool', description: 'divides a / b' })
`,
    }])
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
  })
})
