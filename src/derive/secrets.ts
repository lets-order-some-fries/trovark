import type { Finding } from '../types.js'
import type { RepoFile } from '../collectors/github.js'

const PATTERNS: Array<[label: string, rx: RegExp]> = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[ps]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Private key', /-----BEGIN (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/],
  ['API key assignment', /(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i],
]
const SKIP = /(test|fixture|example|sample|spec)/i

export function scanSecrets(files: RepoFile[]): { count: number; findings: Finding[] } {
  const findings: Finding[] = []
  for (const f of files) {
    if (SKIP.test(f.path) || f.path.endsWith('.md')) continue
    for (const [label, rx] of PATTERNS) {
      if (rx.test(f.content)) {
        findings.push({
          id: 'security/committed-secret', dimension: 'security', severity: 'high',
          message: `Possible ${label} committed to the repository.`, evidence: f.path,
        })
        break // one finding per file
      }
    }
  }
  return { count: findings.length, findings }
}
