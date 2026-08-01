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
4. **Coverage gate — no confident grade without the security tool surface.**
   If a server's tools can't be statically determined (so tool-surface risk is
   unknown), or two or more whole dimensions can't be collected, we withhold the
   letter grade and report `INSUFFICIENT DATA` rather than emit a confident
   grade computed from the remaining signals. A withheld grade is honest; a
   false clean bill on a server we couldn't inspect is not.
5. **Versioned rubric.** Weights and thresholds live in `src/scoring/rubric.ts`;
   scorecards record the rubric version. Changes bump the version.

## Signals per dimension

- **Health:** commit recency; 90-day commit activity; bus factor (distinct
  authors with ≥3 commits over the full trailing 365-day window — the commit
  history is paginated so active repos aren't undercounted); median issue
  time-to-first-response (needs GITHUB_TOKEN); popularity (stars / weekly
  downloads); release recency; archived flag.
- **Reliability:** MCP SDK version mapped to spec era across ecosystems —
  npm (`@modelcontextprotocol/sdk`), Python (`mcp` / `fastmcp`), Go
  (`go-sdk` / `mcp-go`), Rust (`rmcp`), JVM (`io.modelcontextprotocol`), .NET
  (`ModelContextProtocol`); matchers are anchored to dependency declarations, and
  a detected SDK of unknown era is treated as modern (these SDKs only exist in
  the post-2025 era). Nested/workspace manifests are read, not just the repo
  root. Plus CI config; test files (incl. Go `_test.go`); lockfile presence
  (npm/py/Go/Rust/etc.); whether tool schemas were statically extractable.
- **Security:** tool-surface risk from extracted tool names, descriptions, and
  schemas, classified by **token-set** membership (so `execute` flags but the
  noun `execution` does not; `edit_file` is medium, `run_python`/`bash_command`
  are high). Extraction covers TS SDK `registerTool`/`ListTools` handlers,
  Python decorator/imperative/`add_tool` forms, and low-level `Tool(...)`
  literals; if a source file imports a shell/process API but no tools could be
  read, risk is floored to medium rather than assumed clean. Known CVEs in
  dependencies via OSV.dev, queried at **resolved lockfile versions**
  (`package-lock.json` incl. transitive, `uv.lock`, `poetry.lock`) when a
  lockfile is committed, falling back to declared floors otherwise.
  Committed-secret patterns are a **low-confidence candidate** heuristic over
  sampled files (not full git history), reported by path with match text never
  shown; ~13% true-positive rate in testing, so it carries a low rubric weight
  and findings are labeled "candidate, verify manually" — use a dedicated
  scanner (gitleaks, trufflehog) for authoritative secret detection.
- **Cost:** estimated tokens of the serialized tool schema (gpt-tokenizer —
  an estimate, so labeled; currently an under-estimate, see limitations); tool
  count (deduplicated; test/example paths excluded).

## Known limitations (v1.2)

- Tool-schema extraction is best-effort static parsing across languages/idioms;
  it does not cover every framework, and a miss triggers the coverage gate
  (grade withheld) rather than a wrong score.
- The cost token estimate omits nested `inputSchema` bodies, so it is an
  under-estimate; slated for recalibration in a later version.
- CVE resolution covers `package-lock.json`/`uv.lock`/`poetry.lock`; other
  lockfiles (pnpm, yarn, Pipfile) still fall back to declared floors.
- Monorepos are scored at repository granularity.
- The committed-secret heuristic is a candidate signal, not a real secret scan.
- Bare package names found on both npm and PyPI are rejected as ambiguous rather
  than guessed — use the `npm:`/`pypi:` prefix.
