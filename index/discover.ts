// Discover public MCP server repos: curated seed + linked lists → servers.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'

const BAD_OWNERS = new Set([
  'topics', 'sponsors', 'features', 'orgs', 'marketplace', 'search', 'about',
  'pricing', 'collections', 'login', 'contact', 'enterprise', 'apps', 'settings',
  'readme', 'trending', 'site', 'security', 'customer-stories', 'team',
])

/** Pure: pull owner/repo refs out of markdown. Skips non-repo paths and awesome-lists. */
export function extractRepoRefs(markdown: string): string[] {
  const seen = new Map<string, string>() // lower → original
  for (const m of markdown.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/, '')
    if (BAD_OWNERS.has(owner.toLowerCase())) continue
    if (/awesome/i.test(repo)) continue
    const ref = `${owner}/${repo}`
    const key = ref.toLowerCase()
    if (!seen.has(key)) seen.set(key, ref)
  }
  return [...seen.values()]
}

// Public list sources (fetched as raw markdown; no auth needed).
const LIST_SOURCES = [
  'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md',
  'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
]

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main(): Promise<void> {
  const limit = Number(arg('--limit', '400'))
  const out = arg('--out', 'index/servers.json')
  const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })

  const seed = readFileSync(new URL('./seed.txt', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

  const fromLists: string[] = []
  for (const url of LIST_SOURCES) {
    try {
      fromLists.push(...extractRepoRefs(await http.text(url)))
      console.error(`fetched ${url}`)
    } catch (err) {
      console.error(`WARN: list source failed, continuing: ${url} (${(err as Error).message})`)
    }
  }

  const seen = new Map<string, string>()
  for (const ref of [...seed, ...fromLists]) {
    const key = ref.toLowerCase()
    if (!seen.has(key)) seen.set(key, ref)
  }
  const refs = [...seen.values()].slice(0, limit)
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), count: refs.length, refs }, null, 2))
  console.error(`wrote ${out}: ${refs.length} refs (seed ${seed.length}, lists ${fromLists.length})`)
}

if (process.argv[1]?.endsWith('discover.ts')) await main()
