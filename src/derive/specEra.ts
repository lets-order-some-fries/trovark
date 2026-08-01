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
      } catch { /* malformed */ }
    }
    if (f.path.endsWith('pyproject.toml') || f.path.endsWith('requirements.txt')) {
      // fastmcp (and the trimmed fastmcp-slim) is a standalone framework whose
      // published line has been 2.x+ since inception — any match is modern,
      // independent of whatever the low-level `mcp` package version says.
      if (/(^|["'\s])fastmcp(-slim)?(?=[\s["'<>=~,]|$)/.test(f.content)) return 'modern'
      const m = f.content.match(/(^|["'\s])mcp\s*(?:\[[^\]]*\])?\s*(?:>=|==|~=|>)\s*(\d+)/)
      if (m) return Number(m[2]) >= 1 ? 'modern' : 'legacy'
    }
    if (f.path.endsWith('go.mod')) {
      if (/github\.com\/modelcontextprotocol\/go-sdk|github\.com\/mark3labs\/mcp-go/.test(f.content)) return 'modern'
    }
    if (f.path.endsWith('Cargo.toml')) {
      if (/(^|["'\s])rmcp(?=[\s["'=]|$)/m.test(f.content)) return 'modern'
    }
    if (f.path.endsWith('build.gradle') || f.path.endsWith('build.gradle.kts') || f.path.endsWith('pom.xml')) {
      if (/io\.modelcontextprotocol/.test(f.content)) return 'modern'
    }
    if (f.path.endsWith('.csproj')) {
      if (/ModelContextProtocol/.test(f.content)) return 'modern'
    }
  }
  return undefined
}

function majorOf(range: string): 'modern' | 'legacy' | undefined {
  const m = range.match(/(\d+)/)
  if (!m) return undefined
  return Number(m[1]) >= 1 ? 'modern' : 'legacy'
}
