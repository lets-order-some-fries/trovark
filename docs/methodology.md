# Methodology (rubric v1.2.0)

trovark computes a 0–100 Trust Score from four dimensions: Health 35%,
Reliability 25%, Security 25%, Cost 15%. Grade bands: A ≥ 85, B ≥ 70, C ≥ 55,
D ≥ 40, F < 40 (+/- at the top/bottom 5 points of each band).

## Principles

1. **Static and public only.** We never execute a scanned server.
2. **Evidence or it doesn't count.** Every finding carries a link (file path,
   CVE URL) a skeptic can check.
3. **Absence ≠ zero.** A signal we can't collect lowers confidence; it does not
   lower the score. Each dimension reports high/medium/low confidence
   (≥75% / ≥40% / <40% of its signals available).
4. **Versioned rubric.** Weights and thresholds live in `src/scoring/rubric.ts`;
   scorecards record the rubric version. Changes bump the version.

## Signals per dimension

- **Health:** commit recency; 90-day commit activity; bus factor (authors with
  ≥3 commits in the trailing 365-day sample); median issue time-to-first-response
  (trailing 30 issues, needs GITHUB_TOKEN); popularity (stars / weekly
  downloads); release recency; archived flag.
- **Reliability:** MCP SDK version mapped to spec era (pre-1.0 SDKs target the
  retired spec); CI config; test files; lockfile; whether tool schemas were
  statically extractable.
- **Security:** tool-surface risk classified from extracted tool names,
  descriptions, and schemas (exec/shell → high; write/delete → medium;
  network → low); committed-secret patterns — a low-confidence candidate
  heuristic over sampled files (not full git history), reported by path with
  match text never shown; it ran at ~13% true-positive rate in testing, so it
  carries a lower rubric weight and findings are labeled "candidate, verify
  manually" — use a dedicated scanner (gitleaks, trufflehog) for authoritative
  secret detection; known CVEs in declared dependencies via OSV.dev.
- **Cost:** estimated tokens of the serialized tool schema (gpt-tokenizer —
  an estimate, so labeled); tool count.

## Known limitations (v1)

- Tool-schema extraction is a best-effort static ladder (manifests → TS/JS
  source patterns → Python decorators). Failure is reported as reduced
  confidence, not a worse score.
- Dependency CVE lookup uses declared version floors (`^`/`~`/`>=` stripped),
  not resolved lockfile versions.
- Monorepos are scored at repository granularity.
- Issue responsiveness is sampled (last 30 issues, first 10 with comments).
- Bare package names found on both npm and PyPI are rejected as ambiguous rather than guessed — use the npm:/pypi: prefix.
