import { describe, expect, it } from 'vitest'
import { scanSecrets } from '../src/derive/secrets.js'
import { assemble } from '../src/assemble.js'
import type { Http } from '../src/util/http.js'

describe('scanSecrets — true positives', () => {
  it('flags an AWS access key', () => {
    const r = scanSecrets([{ path: 'src/config.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE"' }])
    expect(r.count).toBe(1)
    expect(r.findings[0]).toMatchObject({ id: 'security/committed-secret', severity: 'medium', evidence: 'src/config.ts' })
    expect(r.findings[0].message).not.toContain('AKIA')
    expect(r.findings[0].message).toContain('candidate, verify manually')
  })
  it('flags an unquoted key in a committed .env and a private key header', () => {
    const r = scanSecrets([
      { path: '.env', content: 'OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890' },
      { path: 'deploy/key.pem', content: '-----BEGIN RSA PRIVATE KEY-----\nxyz' },
    ])
    expect(r.count).toBe(2)
  })
  it('flags GitHub PATs', () => {
    const r = scanSecrets([{ path: 'a.ts', content: 'token: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"' }])
    expect(r.count).toBe(1)
  })
  it('flags a quoted high-entropy hardcoded credential', () => {
    const r = scanSecrets([{ path: 'src/c.ts', content: 'const password = "8Kx9mVq2LpZ7nWfR3tYbQ1c"' }])
    expect(r.count).toBe(1)
    expect(r.findings[0].message).toContain('hardcoded credential')
  })
  it('flags scan of files whose names merely contain skip words', () => {
    const r = scanSecrets([{ path: 'src/inspector.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE"' }])
    expect(r.count).toBe(1)
  })
})

describe('scanSecrets — false positives from the live audit must NOT flag', () => {
  const clean = (path: string, content: string) => expect(scanSecrets([{ path, content }]).count).toBe(0)
  it('env-var reference', () => clean('src/monitor.ts', 'const apiKey = opts.apiKey || process.env.FIRECRAWL_API_KEY'))
  it('SCREAMING_SNAKE identifier value', () => clean('src/auth.ts', 'const secret = BETTER_AUTH_SECRET'))
  it('function-call value', () => clean('app.module.ts', "const jwtSecret = getRequiredSecret('JWT_SECRET', process.env.JWT_SECRET)"))
  it('member-access value', () => clean('settings.py', 'token = _resolve_env_var(self.token)'))
  it('placeholder your-...-here', () => clean('config.ts', 'DEEPSEEK_API_KEY="your-api-key-here"'))
  it('doc-example placeholder', () => clean('server.ts', 'accessToken: "your-sentry-token"'))
  it('comment line', () => clean('cli.py', '# Resolve auth token: --auth-token-file > --auth-token'))
  it('empty .env value (no cross-line match)', () => clean('.env.template', 'AZURE_OPENAI_API_KEY=\nAZURE_OPENAI_ENDPOINT=https://x'))
  it('identifier passthrough', () => clean('cli.py', 'client_secret=auth_client_secret'))
  it('angle-bracket placeholder', () => clean('a.ts', 'const api_key = "<your-key-goes-here>"'))
  it('clean source', () => clean('src/i.ts', 'export const x = 1'))
  it('skips .test. infix files (test-file skip gap closed)', () => clean('foo.test.ts', 'const apiKey = "8Kx9mVq2LpZ7nWfR3tYbQ1c"'))
})

// ---------------------------------------------------------------------------
// W6 review remediation item 1 (I4): scanSecrets skips `.md` but never
// learned to skip `.rst` — README_BASENAME_RE fetches either. AWS's own
// canonical documentation example key must never be published as a
// "possible hardcoded credential" against a repo whose only sin is
// documenting AWS. Fixed by construction: the root README (.md or .rst) is
// quarantined onto RepoSnapshot.readme before assemble.ts ever calls
// scanSecrets(snap.files, ...), so scanSecrets never sees it, regardless of
// extension.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-06T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

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

describe('assemble — README quarantine (W6 review I4): a README.rst credential example must never reach scanSecrets', () => {
  it('AWS doc example key AKIAIOSFODNN7EXAMPLE in README.rst produces no security/committed-secret finding', async () => {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/acme/rstdocs/commits?since': [],
      'https://api.github.com/repos/acme/rstdocs/releases/latest': {},
      'https://api.github.com/repos/acme/rstdocs/git/trees/main?recursive=1': {
        tree: [{ path: 'README.rst', type: 'blob', size: 1000 }],
      },
      'https://api.github.com/repos/acme/rstdocs': {
        stargazers_count: 5, archived: false, pushed_at: iso(3), default_branch: 'main',
      },
    }
    const http = makeRoutedHttp(routes, (url) => {
      if (url.endsWith('README.rst')) {
        return `My MCP Server
=============

Example AWS credentials for testing::

    AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE
`
      }
      throw new Error(`HTTP 404 for ${url}`)
    })
    const s = await assemble({ ref: 'rstdocs', repo: { owner: 'acme', name: 'rstdocs' } }, http, NOW)
    expect(s.findings.some(f => f.id === 'security/committed-secret')).toBe(false)
    expect(s.secretsFound).toBe(0)
  })
})
