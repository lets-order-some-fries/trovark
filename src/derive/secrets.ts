import type { Finding } from '../types.js'
import type { RepoFile } from '../collectors/github.js'

// High-precision provider patterns — a format match here is almost certainly a real credential.
const PROVIDER: Array<[label: string, rx: RegExp]> = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[psoru]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_\-]{35}\b/],
  ['Stripe secret key', /\bsk_live_[0-9A-Za-z]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Private key', /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP)? ?PRIVATE KEY-----/],
]

// Generic "secret-named assignment". The value validation (looksLikeSecret) is what
// prevents matching env-var references, identifiers, and placeholders.
const ASSIGN = /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*(["']?)([^\s"']{20,})\1/i

const PLACEHOLDER = /your|example|changeme|change[_-]?me|placeholder|redacted|dummy|sample|insert|\bhere\b|todo|fake|xxxx|\.\.\.|<|>|\{\{|\$\{|process\.env|import\.meta/i

const COMMENT = /^\s*(#|\/\/|\*|\/\*)/

/** High-entropy check: real secrets mix letters with digits or are long hex/base64.
 *  Identifiers and env-var names rarely contain digits; placeholders are rejected by name. */
function looksLikeSecret(v: string): boolean {
  if (v.length < 20) return false
  if (PLACEHOLDER.test(v)) return false
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return false            // SCREAMING_SNAKE identifier / env-var name
  if (/^[\w$]+(?:\.[\w$]+)+$/.test(v)) return false          // member access obj.prop.prop
  const hasLower = /[a-z]/.test(v), hasUpper = /[A-Z]/.test(v), hasDigit = /[0-9]/.test(v)
  if ((hasLower || hasUpper) && hasDigit) return true        // mixed letters + digits → random-looking
  if (/^[A-Fa-f0-9]{32,}$/.test(v)) return true              // hex blob
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(v) && hasLower && hasUpper) return true // base64 blob
  return false
}

const SKIP = /(^|\/)(tests?|fixtures?|examples?|samples?|specs?)(\/|[._-]|$)|\.(example|sample)$/i

export function scanSecrets(files: RepoFile[]): { count: number; findings: Finding[] } {
  const findings: Finding[] = []
  for (const f of files) {
    if (SKIP.test(f.path) || f.path.endsWith('.md')) continue
    let label: string | undefined
    outer: for (const line of f.content.split('\n')) {
      if (COMMENT.test(line)) continue
      for (const [lbl, rx] of PROVIDER) {
        if (rx.test(line)) { label = lbl; break outer }
      }
      const m = ASSIGN.exec(line)
      if (m && looksLikeSecret(m[2])) { label = 'hardcoded credential'; break outer }
    }
    if (label) {
      findings.push({
        id: 'security/committed-secret', dimension: 'security', severity: 'high',
        message: `Possible ${label} committed to the repository.`, evidence: f.path,
      })
    }
  }
  return { count: findings.length, findings }
}
