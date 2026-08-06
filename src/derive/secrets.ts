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

const SKIP = /(^|\/)(tests?|fixtures?|examples?|samples?|specs?|mocks?|__mocks__)(\/|[._-]|$)|\.(test|spec|example|sample|min)\.|\.(example|sample)$/i

// W6 review (I4, defence-in-depth): documentation is where placeholder and
// vendor-published example credentials live — AWS's own docs use
// AKIAIOSFODNN7EXAMPLE, which matches the AWS PROVIDER pattern exactly and
// is checked BEFORE any placeholder heuristic. Skipping only `.md` was an
// asymmetry that fired on a README.rst the moment W6 started fetching
// READMEs; the root README is now quarantined out of `files` upstream
// (src/collectors/github.ts), so this is not reachable today — but "docs
// reached a code scanner" is a mistake this codebase has now made once, and
// the next doc-fetching feature must not silently re-open it. Secret
// scanning is already a deliberately low-confidence candidate signal
// (~13% measured precision), so declining to scan prose costs nothing real.
const DOC_EXT = /\.(md|markdown|rst|txt|adoc|asciidoc)$/i

export function scanSecrets(files: RepoFile[]): { count: number; findings: Finding[] } {
  const findings: Finding[] = []
  for (const f of files) {
    if (SKIP.test(f.path) || DOC_EXT.test(f.path)) continue
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
        id: 'security/committed-secret', dimension: 'security', severity: 'medium',
        message: `Possible ${label} — candidate, verify manually.`, evidence: f.path,
      })
    }
  }
  return { count: findings.length, findings }
}
