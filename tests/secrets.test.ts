import { describe, expect, it } from 'vitest'
import { scanSecrets } from '../src/derive/secrets.js'

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
