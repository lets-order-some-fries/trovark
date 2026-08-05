import { describe, expect, it } from 'vitest'
import { detectDynamic } from '../src/derive/dynamic.js'
import { assemble } from '../src/assemble.js'
import { score } from '../src/scoring/score.js'
import { renderTerminal } from '../src/report/terminal.js'
import { summarize, type IndexEntry } from '../index/scan.js'
import { renderSite } from '../index/site.js'
import type { Http } from '../src/util/http.js'
import type { Scorecard, Signals } from '../src/types.js'

const NOW = new Date('2026-08-04T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

// ---------------------------------------------------------------------------
// Part B unit tests: detectDynamic's signal A / (B && C) / never-B-alone.
// ---------------------------------------------------------------------------

describe('detectDynamic (W6 Part B): signal A — same-directory bare-ident registration + persistence marker', () => {
  it('MCPJungle-shaped Go pair: bare-ident AddTool in one file + gorm db.Find in another file of the SAME directory → dynamic', () => {
    const files = [
      { path: 'internal/service/mcp/proxy.go', content: `func (m *Server) register() {\n\tm.AddTool(tool, m.MCPProxyToolCallHandler)\n}` },
      { path: 'internal/service/mcp/tool.go', content: `func (m *Server) loadTools() {\n\tvar tools []Tool\n\tm.db.Find(&tools)\n}` },
    ]
    const result = detectDynamic({ files, treePaths: files.map(f => f.path) })
    expect(result).not.toBeNull()
    expect(result?.dynamic).toBe(true)
    expect(result?.note).toContain('registered at runtime')
  })

  it('GUARD: the same two signals in DIFFERENT directories do not fire (directory-scoped, not repo-wide)', () => {
    const files = [
      { path: 'a/proxy.go', content: `AddTool(tool, handler)` },
      { path: 'b/tool.go', content: `db.Find(&tools)` },
    ]
    expect(detectDynamic({ files, treePaths: files.map(f => f.path) })).toBeNull()
  })

  it('GUARD: a quoted/literal first arg to AddTool is a real static registration, not the bare-identifier shape', () => {
    const files = [
      { path: 'a/proxy.go', content: `AddTool("literal_tool", handler)` },
      { path: 'a/tool.go', content: `db.Find(&tools)` },
    ]
    expect(detectDynamic({ files, treePaths: files.map(f => f.path) })).toBeNull()
  })

  it('a persistence marker alone (no bare-ident registration call anywhere) does not fire', () => {
    const files = [{ path: 'a/tool.go', content: `db.Find(&tools)` }]
    expect(detectDynamic({ files, treePaths: files.map(f => f.path) })).toBeNull()
  })

  it('registerTool/add_tool/AddTools spellings all count as the registration call', () => {
    for (const call of ['registerTool(t, h)', 'add_tool(t, h)', 'AddTools(t, h)']) {
      const files = [
        { path: 'a/reg.go', content: call },
        { path: 'a/store.go', content: 'prisma.tool.findMany()' },
      ]
      expect(detectDynamic({ files, treePaths: files.map(f => f.path) })).not.toBeNull()
    }
  })
})

describe('detectDynamic — signal B (weak) must never fire alone', () => {
  it('GUARD: description reads as a "gateway" with no structural corroboration → NOT dynamic', () => {
    const files = [{ path: 'src/index.ts', content: `export const tools = [{name:'a'}]` }]
    const result = detectDynamic({
      files, treePaths: files.map(f => f.path), description: 'A simple MCP gateway for X', topics: ['gateway'],
    })
    expect(result).toBeNull()
  })

  it('GUARD: "proxy"/"router"/"hub" in topics alone → NOT dynamic', () => {
    const files = [{ path: 'src/index.ts', content: 'noop' }]
    for (const topics of [['proxy'], ['router'], ['hub'], ['aggregator']]) {
      expect(detectDynamic({ files, treePaths: files.map(f => f.path), topics })).toBeNull()
    }
  })

  it('B && C: gateway description + a migrations dir AND a models/*tool* file (both required) → dynamic', () => {
    const files = [{ path: 'src/index.ts', content: 'noop' }]
    const treePaths = ['db/migrations/0001_init.sql', 'src/models/tool.go', 'src/index.ts']
    const result = detectDynamic({ files, treePaths, description: 'An MCP tool registry and router', topics: [] })
    expect(result).not.toBeNull()
  })

  it('GUARD: only ONE of migrations-dir/models-tool-file present → NOT dynamic (C requires both)', () => {
    const files = [{ path: 'src/index.ts', content: 'noop' }]
    const onlyMigrations = detectDynamic({
      files, treePaths: ['db/migrations/0001_init.sql', 'src/index.ts'],
      description: 'An MCP proxy hub', topics: [],
    })
    expect(onlyMigrations).toBeNull()
    const onlyModelFile = detectDynamic({
      files, treePaths: ['src/models/tool.go', 'src/index.ts'],
      description: 'An MCP proxy hub', topics: [],
    })
    expect(onlyModelFile).toBeNull()
  })

  it('GUARD: a real server whose description says "gateway" but structural signals are entirely absent → NOT dynamic (measured false positives: 1mcp-app/agent, sitbon/magg shape)', () => {
    const files = [{
      path: 'src/tools.ts',
      content: `export const tools = [{ name: 'route_request', description: 'Routes a request', inputSchema: {} }]`,
    }]
    const result = detectDynamic({
      files, treePaths: files.map(f => f.path), description: 'A lightweight MCP aggregator/router', topics: ['aggregator'],
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End-to-end through assemble.ts: dynamic wins over README, and only fires
// after every static extractor (and classifyLibrary) has already found
// nothing.
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

describe('assemble — dynamic tool surface end-to-end (W6 Part B)', () => {
  function mcpJungleShapedHttp(readmeContent?: string): Http {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/duaraghav8/MCPJungle/commits?since': [],
      'https://api.github.com/repos/duaraghav8/MCPJungle/releases/latest': {},
      'https://api.github.com/repos/duaraghav8/MCPJungle/git/trees/main?recursive=1': {
        tree: [
          { path: 'go.mod', type: 'blob', size: 200 },
          { path: 'internal/service/mcp/proxy.go', type: 'blob', size: 500 },
          { path: 'internal/service/mcp/tool.go', type: 'blob', size: 500 },
          ...(readmeContent ? [{ path: 'README.md', type: 'blob', size: 3000 }] : []),
        ],
      },
      'https://api.github.com/repos/duaraghav8/MCPJungle': {
        stargazers_count: 400, archived: false, pushed_at: iso(3), default_branch: 'main',
        description: 'A self-hosted MCP registry and gateway for your internal tools',
      },
    }
    return makeRoutedHttp(routes, (url) => {
      if (url.endsWith('go.mod')) return 'module mcpjungle\n\nrequire github.com/mark3labs/mcp-go v0.1.0'
      if (url.endsWith('proxy.go')) return `package mcp\n\nfunc (m *Server) register() {\n\tm.AddTool(tool, m.MCPProxyToolCallHandler)\n}`
      if (url.endsWith('tool.go')) return `package mcp\n\nfunc (m *Server) loadTools() {\n\tvar tools []Tool\n\tm.db.Find(&tools)\n}`
      if (url.endsWith('README.md') && readmeContent) return readmeContent
      throw new Error(`HTTP 404 for ${url}`)
    })
  }

  it('an MCPJungle-shaped repo is classified dynamic: notServer/notServerReason set, toolSurfaceRisk floored at high, tool count/token estimate absent', async () => {
    const s = await assemble({ ref: 'mcpjungle', repo: { owner: 'duaraghav8', name: 'MCPJungle' } }, mcpJungleShapedHttp(), NOW)
    expect(s.notServer).toBe(true)
    expect(s.notServerReason).toBe('dynamic')
    expect(s.notServerNote).toContain('registered at runtime')
    expect(s.toolSurfaceRisk).toBe('high')
    expect(s.toolCount).toBeUndefined()
  })

  it('ORDERING: a proxy README (included_tools/excluded_tools shape) must NOT suppress the dynamic outcome — dynamic wins over README', async () => {
    const fakeReadme = `# MCPJungle

## Tools

- \`included_tools\` — Tools currently enabled on this registry
- \`excluded_tools\` — Tools currently disabled
- \`included_servers\` — Upstream servers currently registered
`
    const s = await assemble({ ref: 'mcpjungle', repo: { owner: 'duaraghav8', name: 'MCPJungle' } }, mcpJungleShapedHttp(fakeReadme), NOW)
    expect(s.notServer).toBe(true)
    expect(s.notServerReason).toBe('dynamic')
    // The false tool surface the README would otherwise fabricate must never
    // reach toolCount.
    expect(s.toolCount).toBeUndefined()
  })

  it('CONTROL: a real server with "gateway" in its description but a static tool list is graded normally, never dynamic', async () => {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/router/commits?since': [],
      'https://api.github.com/repos/acme/router/releases/latest': {},
      'https://api.github.com/repos/acme/router/git/trees/main?recursive=1': {
        tree: [
          { path: 'package.json', type: 'blob', size: 300 },
          { path: 'src/index.ts', type: 'blob', size: 500 },
        ],
      },
      'https://api.github.com/repos/acme/router': {
        stargazers_count: 100, archived: false, pushed_at: iso(3), default_branch: 'main',
        description: 'A lightweight MCP aggregator/gateway/router', topics: ['gateway', 'router'],
      },
    }
    const http = makeRoutedHttp(routes, (url) => {
      if (url.endsWith('package.json')) return JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
      if (url.endsWith('src/index.ts')) return `server.tool('route_request', 'Routes a request to an upstream', {}, handler)`
      throw new Error(`HTTP 404 for ${url}`)
    })
    const s = await assemble({ ref: 'router-mcp', repo: { owner: 'acme', name: 'router' } }, http, NOW)
    expect(s.notServer).toBeUndefined()
    expect(s.toolCount).toBe(1)
    expect(s.toolSurfaceRisk).not.toBe('high') // must not be forced high — this is a real, graded tool surface
  })
})

// ---------------------------------------------------------------------------
// Plumbing: score.ts / report/terminal.ts / index/scan.ts / index/site.ts.
// ---------------------------------------------------------------------------

describe('score() — dynamic tool surface (W6 Part B)', () => {
  function baseSignals(): Signals {
    return {
      findings: [], errors: [],
      daysSinceLastCommit: 3, commitsLast90Days: 10, busFactor: 2, stars: 100, archived: false,
      specEra: 'modern', hasCI: true, hasTests: true, hasLockfile: true, schemaExtracted: false,
      secretsFound: 0, cveWorst: 'none',
    }
  }

  it('a dynamic scorecard has null overall/grade — exactly like notServer', () => {
    const s = baseSignals()
    s.notServer = true
    s.notServerReason = 'dynamic'
    s.notServerNote = 'Tools are registered at runtime from upstream servers; no static list exists. Health/reliability signals shown; no trust grade issued.'
    s.toolSurfaceRisk = 'high'
    const card = score('duaraghav8/MCPJungle', s, NOW.toISOString())
    expect(card.overall).toBeNull()
    expect(card.grade).toBeNull()
    expect(card.notServer).toBe(true)
    expect(card.notServerReason).toBe('dynamic')
    expect(card.insufficientData).toBe(false)
  })

  it('dimensions are still populated (health/reliability/security/cost all present) for a dynamic card', () => {
    const s = baseSignals()
    s.notServer = true
    s.notServerReason = 'dynamic'
    s.toolSurfaceRisk = 'high'
    const card = score('duaraghav8/MCPJungle', s, NOW.toISOString())
    expect(card.dimensions.map(d => d.id).sort()).toEqual(['cost', 'health', 'reliability', 'security'])
    const security = card.dimensions.find(d => d.id === 'security')!
    // The floored 'high' toolSurfaceRisk is what keeps security's primary
    // signal available (not renormalized away onto no-secrets/dependency-cves).
    expect(security.available).toBeGreaterThan(0)
  })

  it('the note text explains runtime registration, not the generic "Library / not an MCP server" wording', () => {
    const s = baseSignals()
    s.notServer = true
    s.notServerReason = 'dynamic'
    s.notServerNote = 'Tools are registered at runtime from upstream servers; no static list exists. Health/reliability signals shown; no trust grade issued.'
    s.toolSurfaceRisk = 'high'
    const card = score('duaraghav8/MCPJungle', s, NOW.toISOString())
    expect(card.notes.some(n => n.includes('registered at runtime'))).toBe(true)
    expect(card.notes.some(n => n.startsWith('Library / not an MCP server'))).toBe(false)
  })
})

describe('renderTerminal — dynamic tool surface (W6 Part B)', () => {
  const dynamicCard: Scorecard = {
    ref: 'duaraghav8/MCPJungle', rubricVersion: '1.5.0',
    overall: null, grade: null,
    dimensions: [
      { id: 'health', score: 80, confidence: 'high', available: 6, total: 6, findings: [] },
      { id: 'reliability', score: 60, confidence: 'medium', available: 3, total: 5, findings: [] },
      { id: 'security', score: 20, confidence: 'high', available: 3, total: 3, findings: [] },
      { id: 'cost', score: 50, confidence: 'low', available: 0, total: 2, findings: [] },
    ],
    notes: ['Tools are registered at runtime from upstream servers; no static list exists. Health/reliability signals shown; no trust grade issued.'],
    generatedAt: NOW.toISOString(), insufficientData: false,
    notServer: true, notServerReason: 'dynamic',
  }

  it('renders the DYNAMIC TOOL SURFACE label, not "LIBRARY" and not a numeric Trust Score', () => {
    const out = renderTerminal(dynamicCard, { color: false })
    expect(out).toContain('DYNAMIC TOOL SURFACE — not statically analyzable')
    expect(out).not.toContain('LIBRARY')
    expect(out).not.toContain('Trust Score:')
  })

  it('dimensions (including security) are still printed', () => {
    const out = renderTerminal(dynamicCard, { color: false })
    expect(out).toContain('security')
    expect(out).toContain('health')
  })
})

describe('summarize — dynamic tool surface (W6 Part B): a distinct IndexStats counter', () => {
  function e(overrides: Partial<IndexEntry>): IndexEntry {
    return { ref: 'x', ok: true, ...overrides }
  }

  it('counts dynamic entries separately from notServer, and excludes both from gradeDist/avgOverall', () => {
    const s = summarize([
      e({ ref: 'duaraghav8/MCPJungle', notServer: true, notServerReason: 'dynamic' }),
      e({ ref: 'a/lib', notServer: true, notServerReason: 'sdk', overall: 78, grade: 'B+' }),
      e({ ref: 'a/real', overall: 90, grade: 'A' }),
    ])
    expect(s.dynamic).toBe(1)
    expect(s.notServer).toBe(1) // excludes the dynamic entry
    expect(s.gradeDist).toEqual({ A: 1 }) // neither notServer entry appears
  })

  it('excludes dynamic entries from staleOver180/secretsFindings/shellExecTools too', () => {
    const s = summarize([
      e({
        ref: 'duaraghav8/MCPJungle', notServer: true, notServerReason: 'dynamic',
        daysSinceLastCommit: 400, topFindings: [{ id: 'security/shell-exec-tool', severity: 'high' }],
      }),
    ])
    expect(s.dynamic).toBe(1)
    expect(s.staleOver180).toBe(0)
    expect(s.shellExecTools).toBe(0)
  })
})

describe('renderSite — dynamic tool surface (W6 Part B)', () => {
  const baseStats = {
    total: 1, scored: 1, failed: 0, insufficient: 0, notServer: 0, dynamic: 1, unresolved: 0,
    gradeDist: {}, avgOverall: 0, staleOver180: 0, secretsFindings: 0, deprecated: 0, shellExecTools: 0,
  }

  it('renders a dynamic row distinctly from a library ("LIB") row, with a security cell shown (not "not applicable")', () => {
    const html = renderSite({
      generatedAt: NOW.toISOString(), rubricVersion: '1.5.0', stats: baseStats,
      entries: [{
        ref: 'duaraghav8/MCPJungle', ok: true, notServer: true, notServerReason: 'dynamic',
        dims: {
          health: { score: 80, confidence: 'high' }, reliability: { score: 60, confidence: 'medium' },
          security: { score: 20, confidence: 'high' }, cost: { score: 50, confidence: 'low' },
        },
      }],
    })
    expect(html).toContain('DYN')
    expect(html).toContain('dynamic tool surface — not statically analyzable')
    expect(html).not.toContain('>LIB<')
    // security is rendered from real dims (20), not the muted "not applicable" cell notServer/LIB rows use.
    expect(html).toMatch(/<td>20<span class="conf">h<\/span><\/td>/)
  })

  it('shows a distinct "dynamic tool surface" stat tile', () => {
    const html = renderSite({ generatedAt: NOW.toISOString(), rubricVersion: '1.5.0', stats: baseStats, entries: [] })
    expect(html).toContain('dynamic tool surface')
  })
})
