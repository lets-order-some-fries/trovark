import { describe, expect, it } from 'vitest'
import { extractSchema, fromReadmeCatalog } from '../src/derive/schema.js'
import { assemble } from '../src/assemble.js'
import type { Http } from '../src/util/http.js'

const NOW = new Date('2026-08-04T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

// ---------------------------------------------------------------------------
// Part A unit tests: fromReadmeCatalog's three shapes + guards.
// ---------------------------------------------------------------------------

describe('fromReadmeCatalog (W6 Part A): README tool catalog extraction', () => {
  it('playwright-style bullet + "- Description:" form extracts tools (verified shape: 69 tools on real playwright-mcp)', () => {
    const readme = `# playwright-mcp

## Tools

- **browser_click**
  - Description: Click an element on the page
  - Parameters:
    - element (string): Human-readable element description

- **browser_navigate**
  - Description: Navigate to a URL
  - Parameters:
    - url (string): The URL to navigate to

- **browser_screenshot**
  - Description: Take a screenshot of the current page
`
    const tools = fromReadmeCatalog({ path: 'README.md', content: readme })
    expect(tools.map(t => t.name).sort()).toEqual(['browser_click', 'browser_navigate', 'browser_screenshot'])
    expect(tools.find(t => t.name === 'browser_click')?.description).toContain('Click an element')
  })

  it('markdown table form extracts tools (scoped to a Tools-headed section with a tool/name column)', () => {
    const readme = `# my-server

## Tools

| Tool | Description |
| --- | --- |
| \`get_weather\` | Fetches current weather for a location |
| \`list_cities\` | Lists supported cities |
| \`set_units\` | Sets the unit system (metric/imperial) |
`
    const tools = fromReadmeCatalog({ path: 'README.md', content: readme })
    expect(tools.map(t => t.name).sort()).toEqual(['get_weather', 'list_cities', 'set_units'])
  })

  it('code-span bullet form extracts tools ("- `tool_name` — description")', () => {
    const readme = `# my-server

## Available Commands

- \`create_ticket\` — Creates a new support ticket
- \`close_ticket\` — Closes an existing ticket
- \`list_tickets\` — Lists all open tickets
`
    const tools = fromReadmeCatalog({ path: 'README.md', content: readme })
    expect(tools.map(t => t.name).sort()).toEqual(['close_ticket', 'create_ticket', 'list_tickets'])
  })

  it('GUARD: a prose README with 2 bolded words does not fabricate a surface (>=3 guard)', () => {
    const readme = `# my-lib

This is **very** important and **not** a tool catalog at all, just prose.

## Installation

Run \`npm install my-lib\` to get started.
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('GUARD: fewer than 3 code-span bullets under a Commands heading does not fabricate a surface', () => {
    const readme = `# my-server

## Commands

- \`do_thing\` — Does the thing
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('GUARD: a parameters table (not a tool table) is never read as a tool catalog — heading scoping', () => {
    const readme = `# my-server

## Parameters

| Name | Type | Description |
| --- | --- | --- |
| \`user_id\` | string | (required) The ID of the user |
| \`max_results\` | number | (optional) Maximum results to return |
| \`sort_order\` | string | (optional) asc or desc |
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('GUARD: a per-tool parameter table nested under a Tools heading is carved out (type-annotation guard + sub-heading scoping)', () => {
    const readme = `# my-server

## Tools

### search_docs

Searches the documentation.

**Parameters:**

| Name | Type | Description |
| --- | --- | --- |
| \`query\` | string | (required) search query |
| \`limit\` | number | (optional) max results |
`
    // "search_docs" as a heading has no tool/command/capabilities token, and
    // "Parameters" is explicitly excluded — neither section is scanned, so
    // this correctly yields nothing (a genuine per-tool catalog would need a
    // recognized shape at column 0, not a heading-per-tool layout).
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('GUARD: a code-span bullet whose description opens with a type annotation is rejected even under a Tools heading (parameter-shaped, not tool-shaped)', () => {
    const readme = `# my-server

## Tools

- \`user_id\` (string, required) — the ID of the user
- \`max_results\` (number, optional) — maximum results to return
- \`sort_order\` (string, optional) — asc or desc
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('GUARD (false-positive verification, W6 Part A #3, measured live): a "Tool Annotations" section documenting tool-schema FIELD names is not a tool catalog (modelcontextprotocol/ruby-sdk regression)', () => {
    // Real shape from ruby-sdk's README: a `### Tool Annotations` heading
    // (passes TOOL_HEAD_RE on the word "Tool" alone) followed by code-span
    // bullets documenting the annotation HASH KEYS a tool can carry — not
    // tool names. Before NEG_HEAD_RE learned "annotations", this fabricated
    // 4 "tools": destructive_hint, idempotent_hint, open_world_hint,
    // read_only_hint.
    const readme = `# MCP Ruby SDK

### Tool Annotations

Tools can include annotations that provide additional metadata about their behavior. The following annotations are supported:

- \`destructive_hint\`: Indicates if the tool performs destructive operations. Defaults to true
- \`idempotent_hint\`: Indicates if the tool's operations are idempotent. Defaults to false
- \`open_world_hint\`: Indicates if the tool operates in an open world context. Defaults to true
- \`read_only_hint\`: Indicates if the tool only reads data (doesn't modify state). Defaults to false
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('dedupes a tool matched by more than one shape', () => {
    const readme = `# my-server

- **fetch_page**
  - Description: Fetch a web page

## Tools

- \`fetch_page\` — Fetch a web page
- \`list_pages\` — List all pages
- \`delete_page\` — Delete a page
`
    const tools = fromReadmeCatalog({ path: 'README.md', content: readme })
    expect(tools.filter(t => t.name === 'fetch_page')).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // W6 review remediation C3: sections that are not the CURRENT tool surface
  // (planned/roadmap, removed/changelog, a feature "Capabilities" table) must
  // never be published as tools — recall loss is acceptable, fabrication is not.
  // -------------------------------------------------------------------------

  it('C3 (a): a "## Planned Tools" section listing execute_shell extracts NO tools and raises no security finding', () => {
    const readme = `# my-server

## Planned Tools

- \`execute_shell\` — Planned: run arbitrary shell commands
- \`delete_all\` — Planned: remove all resources
- \`format_disk\` — Planned: wipe the disk
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
    const r = extractSchema([{ path: 'README.md', content: readme }], undefined, undefined, { path: 'README.md', content: readme })
    expect(r.extracted).toBe(false)
    expect(r.findings.some(f => f.id === 'security/shell-exec-tool')).toBe(false)
    expect(r.findings.some(f => f.id === 'security/destructive-tool')).toBe(false)
  })

  it('C3 (b): a "### Removed tools" changelog subsection extracts NO tools', () => {
    const readme = `# my-server

## Changelog

### Removed tools

- \`legacy_export\` — no longer available as of v2.0
- \`legacy_import\` — no longer available as of v2.0
- \`legacy_sync\` — no longer available as of v2.0
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('C3 (c): a "## Capabilities" feature table extracts NO tools (kebab-case feature names, not tool names)', () => {
    const readme = `# my-server

## Capabilities

| Name | Description |
| --- | --- |
| multi-tenant | Supports multiple tenants |
| auto-sync | Automatically syncs data |
| rate-limiting | Limits request rate |
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('C3: an entry whose description starts "Planned: …" inside an otherwise-valid Tools section is rejected entry-by-entry, and the surface disappears once fewer than 3 remain', () => {
    const readme = `# my-server

## Tools

- \`real_tool_a\` — Does a real thing
- \`real_tool_b\` — Does another real thing
- \`execute_shell\` — Planned: run arbitrary shell commands
`
    // Only 2 genuine entries remain once the planned one is rejected — below
    // README_MIN_TOOLS, so no surface at all (per the >=3 guard).
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })

  it('C3: rejected "planned" entry does not suppress sibling real entries when >=3 genuine ones remain', () => {
    const readme = `# my-server

## Tools

- \`real_tool_a\` — Does a real thing
- \`real_tool_b\` — Does another real thing
- \`real_tool_c\` — Does a third real thing
- \`execute_shell\` — Planned: run arbitrary shell commands
`
    const tools = fromReadmeCatalog({ path: 'README.md', content: readme })
    expect(tools.map(t => t.name).sort()).toEqual(['real_tool_a', 'real_tool_b', 'real_tool_c'])
  })

  // -------------------------------------------------------------------------
  // W6 review remediation I2: shape 1 (bold bullet + "- Description:") was
  // unscoped and exempt from TYPE_ANNOT_RE — a jsonschema2md-style
  // "## Configuration" property list must not become a fabricated tool surface.
  // -------------------------------------------------------------------------

  it('I2: a "## Configuration" section of jsonschema2md property bullets (shape 1) extracts NO tools', () => {
    const readme = `# my-server

## Configuration

- **timeout_seconds**
  - Description: (number) How long to wait before timing out

- **retry_count**
  - Description: (number) How many times to retry

- **max_connections**
  - Description: (number) Maximum number of connections
`
    expect(fromReadmeCatalog({ path: 'README.md', content: readme })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// extractSchema wiring: README as the LAST rung.
// ---------------------------------------------------------------------------

describe('extractSchema — README as the LAST rung (W6 Part A)', () => {
  const readmeContent = `## Tools

- **do_a**
  - Description: does a

- **do_b**
  - Description: does b

- **do_c**
  - Description: does c
`

  it('is used when a readmeFile is passed and every static extractor found nothing', () => {
    const readmeFile = { path: 'README.md', content: readmeContent }
    const r = extractSchema([readmeFile], undefined, undefined, readmeFile)
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['do_a', 'do_b', 'do_c'])
    expect(r.readmeSourced).toBe(true)
    expect(r.findings.some(f => f.id === 'reliability/readme-sourced-tools')).toBe(true)
  })

  it('a README catalog must NOT be used when code extraction already found tools (last-rung ordering)', () => {
    const readmeFile = { path: 'README.md', content: `## Tools\n\n- **fake_a**\n  - Description: x\n\n- **fake_b**\n  - Description: y\n\n- **fake_c**\n  - Description: z\n` }
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.tool('real_tool', 'the real one', {}, handler)`,
    }], undefined, undefined, readmeFile)
    expect(r.tools.map(t => t.name)).toEqual(['real_tool'])
    expect(r.readmeSourced).toBe(false)
  })

  it('without a readmeFile argument, a README.md present in files[] is never auto-extracted (regression: pre-existing "nothing extractable" behavior)', () => {
    const r = extractSchema([{ path: 'README.md', content: readmeContent }])
    expect(r.extracted).toBe(false)
    expect(r.readmeSourced).toBe(false)
  })

  it('a readmeFile that itself fails the >=3 guard leaves the result at "nothing extractable"', () => {
    const readmeFile = { path: 'README.md', content: '# prose only, no tools here' }
    const r = extractSchema([readmeFile], undefined, undefined, readmeFile)
    expect(r.extracted).toBe(false)
    expect(r.readmeSourced).toBe(false)
  })

  // W6 review remediation I1: the shell-import security floor must apply
  // regardless of which rung produced `tools` — a README-sourced surface
  // (maintainer prose) must never let a structural code signal (a fetched
  // source file importing a shell/process-execution API) score a clean
  // security bill.
  it('I1: a repo whose src/index.ts imports execSync AND ships a valid >=3-tool README catalog still gets the shell-import floor (prose cannot override a structural code signal)', () => {
    const readmeFile = { path: 'README.md', content: readmeContent } // do_a/do_b/do_c — all benign descriptions
    const shellFile = { path: 'src/index.ts', content: `import { execSync } from 'child_process'\nexecSync('ls')\n` }
    const r = extractSchema([shellFile, readmeFile], undefined, undefined, readmeFile)
    expect(r.extracted).toBe(true)
    expect(r.readmeSourced).toBe(true)
    expect(r.tools.map(t => t.name).sort()).toEqual(['do_a', 'do_b', 'do_c'])
    // Without the floor, benign descriptions ("does a"/"does b"/"does c")
    // classify to 'none' — the floor must raise this to at least 'medium'.
    expect(r.toolSurfaceRisk).toBe('medium')
    expect(r.findings.some(f => f.id === 'security/shell-import-no-tools')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End-to-end through assemble.ts.
// ---------------------------------------------------------------------------

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

describe('assemble — README catalog end-to-end (W6 Part A)', () => {
  function readmeOnlyHttp(readmeContent: string): Http {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/shim/commits?since': [],
      'https://api.github.com/repos/acme/shim/releases/latest': {},
      'https://api.github.com/repos/acme/shim/git/trees/main?recursive=1': {
        tree: [
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'README.md', type: 'blob', size: 3000 },
          { path: 'src/index.ts', type: 'blob', size: 200 },
        ],
      },
      'https://api.github.com/repos/acme/shim': {
        stargazers_count: 50, archived: false, pushed_at: iso(5), default_branch: 'main',
        description: 'A distribution shim',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      // No recognizable registration idiom — the real source lives elsewhere.
      if (url.endsWith('src/index.ts')) return `import { connect } from './shim-runtime.js'\nconnect()`
      if (url.endsWith('README.md')) return readmeContent
      throw new Error(`HTTP 404 for ${url}`)
    })
  }

  it('a shim server with no static tool surface but a real README catalog gets a graded tool surface from README (playwright-mcp shape)', async () => {
    const readme = `# playwright-mcp

## Tools

- **browser_click**
  - Description: Click an element

- **browser_navigate**
  - Description: Navigate to a URL

- **browser_screenshot**
  - Description: Take a screenshot
`
    const s = await assemble({ ref: 'shim-mcp', repo: { owner: 'acme', name: 'shim' } }, readmeOnlyHttp(readme), NOW)
    expect(s.toolCount).toBe(3)
    expect(s.toolSurfaceRisk).toBe('low') // "Navigate to a URL" contains the LOW_TOKENS member "url"
    expect(s.notServer).toBeUndefined()
    // Reliability's schema-parseable signal stays capped — a README catalog
    // was parsed from documentation, not verified against the shipped
    // source (wave2-spec §3 R6).
    expect(s.schemaExtracted).toBe(false)
    expect(s.findings.some(f => f.id === 'reliability/readme-sourced-tools')).toBe(true)
    // W6 review remediation item M2: the structured, machine-readable
    // provenance flag — distinct from schemaExtracted (which is merely
    // false, indistinguishable from "extraction failed") and from the
    // findings list (which a JSON consumer would have to parse by id).
    expect(s.readmeSourced).toBe(true)
  })

  it('a prose-only README (no real catalog) stays a genuine zero-tools miss — no fabricated surface', async () => {
    const s = await assemble(
      { ref: 'shim-mcp', repo: { owner: 'acme', name: 'shim' } },
      readmeOnlyHttp('# shim\n\nJust a distribution shim, see the real repo elsewhere.'),
      NOW,
    )
    expect(s.toolCount).toBeUndefined()
    expect(s.schemaExtracted).toBe(false)
    // M2: no README catalog was actually parsed — readmeSourced is false,
    // not merely absent (extraction genuinely ran and genuinely found none).
    expect(s.readmeSourced).toBe(false)
  })
})

// W6 corpus-scan finding: the shell-import floor is scoped to README-sourced
// tool lists ONLY. When tools come from real code, every tool already got an
// individual risk verdict, so a blanket floor double-counts and penalises any
// repo that merely contains a file importing child_process — including
// release/build scripts that are not the server. Measured on the 400-server
// corpus, the unscoped version dropped 50 real repos (awslabs/mcp A+96->A-89,
// vercel/mcp-adapter, googleapis/genai-toolbox, and playwright-mcp on its
// roll.js RELEASE script) from security 100/85 to 63 — false accusations.
describe('shell-import floor is scoped to README-sourced tool lists', () => {
  const shellFile = {
    path: 'scripts/roll.js',
    content: "import { execSync } from 'child_process'\nexecSync('git push')\n",
    size: 60,
  }
  const codeServer = {
    path: 'src/index.ts',
    content: [
      'server.registerTool("alpha_read", { description: "Read a record" }, h)',
      'server.registerTool("beta_read", { description: "Read another" }, h)',
      'server.registerTool("gamma_read", { description: "Read a third" }, h)',
    ].join('\n'),
    size: 200,
  }

  it('does NOT floor when tools were extracted from real code', () => {
    const r = extractSchema([codeServer, shellFile], ['src/index.ts', 'scripts/roll.js'])
    expect(r.extracted).toBe(true)
    expect(r.readmeSourced).toBe(false)
    expect(r.findings.some(f => f.id === 'security/shell-import-no-tools')).toBe(false)
  })

  it('DOES floor when the tool list came from the README (unverified prose)', () => {
    const readme = {
      path: 'README.md',
      content: '# Srv\n\n## Tools\n\n- **alpha_read**\n  - Description: Read a record\n- **beta_read**\n  - Description: Read another\n- **gamma_read**\n  - Description: Read a third\n',
      size: 200,
    }
    const r = extractSchema([shellFile], ['scripts/roll.js'], undefined, readme)
    expect(r.readmeSourced).toBe(true)
    expect(r.findings.some(f => f.id === 'security/shell-import-no-tools')).toBe(true)
    expect(r.toolSurfaceRisk).not.toBe('none')
  })
})
