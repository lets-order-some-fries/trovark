import type { RepoFile } from '../collectors/github.js'

// MCP SDK 1.x tracks the 2025+ protocol revisions (streamable HTTP / session
// refactor). Pre-1.0 SDKs target the retired spec era and typically cannot
// connect to modern clients.
//
// Non-TS/Python ecosystems (Go, Rust, JVM, .NET) didn't get an official MCP
// SDK until well after the 2025 spec revisions, so for those we can't read a
// version number the way we do for @modelcontextprotocol/sdk / python `mcp`
// — but merely detecting the SDK dependency at all is enough to call it
// 'modern' (~zero false-positive risk: these SDKs only exist post-2025).
export function specEra(files: RepoFile[]): 'modern' | 'legacy' | undefined {
  for (const f of files) {
    if (f.path.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const range = pkg.dependencies?.['@modelcontextprotocol/sdk'] ?? pkg.devDependencies?.['@modelcontextprotocol/sdk']
        if (range) return majorOf(range)
        // C1: SDK 2.x split @modelcontextprotocol/sdk into /core, /server,
        // /client (live proof: netlify/netlify-mcp depends on /core + /server).
        // These packages only exist post-split (2025+) — like the Go/Rust/
        // JVM/.NET branches below, merely detecting the dependency at all is
        // enough to call it 'modern', independent of the pinned version range.
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps['@modelcontextprotocol/core'] || deps['@modelcontextprotocol/server'] || deps['@modelcontextprotocol/client']) return 'modern'
      } catch { /* malformed */ }
    }
    if (f.path.endsWith('pyproject.toml') || f.path.endsWith('requirements.txt')) {
      // Strip triple-quoted TOML string values (e.g. a multi-line
      // `description = """..."""`) before the line-by-line scan below: the
      // per-line metadata skip only recognizes the opening `key = """` line,
      // so a continuation line mentioning "fastmcp" inside the string body
      // would otherwise survive and false-positive as a dependency.
      const withoutTripleQuoted = f.content
        .replace(/"""[\s\S]*?"""/g, '""')
        .replace(/'''[\s\S]*?'''/g, "''")
      // Anchor to dependency lines, not any mention: skip comments and TOML
      // metadata assignments (keywords/description/etc.) so a package merely
      // *talking about* fastmcp in its own description doesn't read as a dep.
      const depLines = withoutTripleQuoted
        .split('\n')
        .filter(line => !/^\s*#/.test(line) && !/^\s*(keywords|description|name|authors|readme|homepage|documentation|repository|classifiers)\s*=/i.test(line))
        .join('\n')
      // fastmcp (and the trimmed fastmcp-slim) is a standalone framework whose
      // published line has been 2.x+ since inception — any match is modern,
      // independent of whatever the low-level `mcp` package version says.
      if (/(^|["'\s])fastmcp(-slim)?\b/.test(depLines)) return 'modern'
      const m = depLines.match(/(^|["'\s])mcp\s*(?:\[[^\]]*\])?\s*(?:>=|==|~=|>)\s*(\d+)/)
      if (m) return Number(m[2]) >= 1 ? 'modern' : 'legacy'
    }
    if (f.path.endsWith('go.mod')) {
      const nonComment = f.content.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
      if (/github\.com\/modelcontextprotocol\/go-sdk|github\.com\/mark3labs\/mcp-go/.test(nonComment)) return 'modern'
    }
    if (f.path.endsWith('Cargo.toml')) {
      // Require an actual dependency-key line (rmcp = "..." or rmcp = { ... }),
      // not just any mention (e.g. keywords = ["rmcp"] or a comment).
      if (/^\s*rmcp\s*=/m.test(f.content)) return 'modern'
    }
    if (f.path.endsWith('build.gradle') || f.path.endsWith('build.gradle.kts') || f.path.endsWith('pom.xml')) {
      const stripped = f.content.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/[^\n]*/g, ' ')
      if (/io\.modelcontextprotocol/.test(stripped)) return 'modern'
    }
    if (f.path.endsWith('.csproj')) {
      const stripped = f.content.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/[^\n]*/g, ' ')
      if (/ModelContextProtocol/.test(stripped)) return 'modern'
    }
  }
  return undefined
}

function majorOf(range: string): 'modern' | 'legacy' | undefined {
  const m = range.match(/(\d+)/)
  if (!m) return undefined
  return Number(m[1]) >= 1 ? 'modern' : 'legacy'
}
