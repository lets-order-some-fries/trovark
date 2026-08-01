import { describe, expect, it } from 'vitest'
import { scanSecrets } from '../src/derive/secrets.js'

describe('scanSecrets', () => {
  it('flags an AWS access key', () => {
    const r = scanSecrets([{ path: 'src/config.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE"' }])
    expect(r.count).toBe(1)
    expect(r.findings[0]).toMatchObject({ id: 'security/committed-secret', severity: 'high', evidence: 'src/config.ts' })
    expect(r.findings[0].message).not.toContain('AKIA') // never leak the secret
  })
  it('flags a committed .env assignment and a private key header', () => {
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
  it('ignores test/example/doc paths', () => {
    const r = scanSecrets([
      { path: 'tests/fixtures/creds.ts', content: 'AKIAIOSFODNN7EXAMPLE' },
      { path: '.env.example', content: 'API_KEY=sk-abcdef1234567890abcdef1234567890' },
      { path: 'README.md', content: 'AKIAIOSFODNN7EXAMPLE' },
    ])
    expect(r.count).toBe(0)
  })
  it('clean files → zero', () => {
    expect(scanSecrets([{ path: 'src/i.ts', content: 'export const x = 1' }]).count).toBe(0)
  })
})
