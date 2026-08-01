import type { RepoFile } from '../collectors/github.js'

// MCP SDK 1.x tracks the 2025+ protocol revisions (streamable HTTP / session
// refactor). Pre-1.0 SDKs target the retired spec era and typically cannot
// connect to modern clients.
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
      const m = f.content.match(/(^|["'\s])mcp\s*(?:\[[^\]]*\])?\s*(?:>=|==|~=|>)\s*(\d+)/)
      if (m) return Number(m[2]) >= 1 ? 'modern' : 'legacy'
    }
  }
  return undefined
}

function majorOf(range: string): 'modern' | 'legacy' | undefined {
  const m = range.match(/(\d+)/)
  if (!m) return undefined
  return Number(m[1]) >= 1 ? 'modern' : 'legacy'
}
