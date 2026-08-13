# Methodology (rubric v1.6.0)

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
- **Cost:** tokens of a reconstructed `tools/list` payload (gpt-tokenizer),
  computed **only when every tool carries a real serialized JSON schema**
  (manifest/OpenAPI sources — ~5% of the corpus); tool count (deduplicated;
  test/example paths excluded). For source-extracted tools the raw captured
  text bears no fixed relation to the serialized payload — measured against
  realistic payloads the old estimate was wrong by up to **7.5× in both
  directions** (not a consistent under-estimate, as this page previously
  claimed) — so the estimate is **withheld** rather than guessed, and the
  cost dimension score is withheld with it. Absence lowers confidence; it
  never renders as a favourable number.

## Multi-language tool extraction & the `notServer` outcome (v1.3)

Tool schemas are extracted via static, per-language idiom matching, tried in
priority order: hand-authored manifests (`mcp.json`/`server.json`/
`toolDefinitions.json`, authoritative when present) first, then
TypeScript/JavaScript (`registerTool`/`addTool`/`defineTool`/class-based/
wrapper idioms), Python (decorator/imperative/class-subclass/call-decorator
forms), Go (`mcp.Tool{...}`/`NewTool(...)` composite literals), and finally
OpenAPI/Swagger specs — a last-resort fallback that only fires when no
manifest and no source extractor found a single tool, so a vendored REST
client spec checked in alongside a real server can never replace that
server's actual tool registrations or fabricate findings from REST
operationIds.

Not every repo that speaks MCP is itself a *server*: SDKs/frameworks, remote
proxies, and distribution stubs define or forward tools but register none of
their own. These are classified as a distinct terminal outcome, `notServer`
(reason `sdk`/`proxy`/`stub`/`not-server`) — not a coverage failure. A
`notServer` card reports no headline score or letter grade (there is nothing
to grade), is excluded from index-wide stats (grade distribution, average
score, stale/secrets/shell-exec-tool counts), and `--fail-under` is a no-op
against it.

Grade withholding (`INSUFFICIENT DATA`, principle 4 above) is unchanged and
still applies whenever a genuine MCP server's tool surface simply couldn't be
statically read — that remains a coverage miss, a fundamentally different
outcome from `notServer`: one says "we don't know," the other says "there's
nothing here to know."

## `unresolved` outcome — repository not found (v1.4)

When a GitHub repository reference cannot be resolved (repository does not exist
or is not accessible), the outcome is classified as `unresolved` — distinct from
both `notServer` and `INSUFFICIENT DATA`. An `unresolved` card reports no score,
grade, or findings, is excluded from all published statistics (grade distribution,
average score, risk counts), and represents a reference error rather than a
grading outcome.

## Expanded tool extraction (v1.4)

Tool extraction has been widened to cover additional patterns and formats:

- **OpenAPI/Swagger specs:** Now matches specs with a `-openapi.json` or `-openapi.yaml` prefix/suffix
  convention in addition to unprefixed specs (e.g., `server-openapi.json`, `openapi-spec.json`).
- **TypeScript/JavaScript idioms:** Extended matchers include typed object constants (`as const` annotated
  tools), scalar constant tool names, arrays returned from factory functions, and lowercase wrapper
  identifiers alongside the existing `registerTool`/`addTool`/`defineTool` patterns.
- **Python imperative registration:** Added support for imperative `add_tool(..., name=...)` calls that
  use f-strings or other dynamic naming for tool names, extending coverage beyond the previously supported
  decorator and class-subclass forms.

These expansions improve coverage on real-world servers without changing the extraction priority order
or fallback behavior; they remain last-resort compared to hand-authored manifests and primary source idioms.

## Metadata integrity: decode-confirmed hidden payloads are a disqualifying override (v1.5)

trovark statically scans extracted tool metadata and fetched files for
invisible-Unicode encodings (variation-selector runs, tag-block runs, bidi
overrides) that render as nothing but can carry a hidden payload — the same
technique documented in the wild against the OpenVSX/npm ecosystem (GlassWorm,
35k+ installs), not yet observed against MCP servers. A run only counts as a
**decode-confirmed hidden payload** if it decodes entirely to printable ASCII
(≥2 characters); anything else — a qualifying run that doesn't decode, or a
bidi override — is reported as an **observation**, never a payload. See
`docs/superpowers/plans/2026-08-04-integrity-v1.md` for the full threshold
derivation and false-positive measurement (0.00% at run-length ≥ 4 across a
2,133-file / 27.5M-character corpus).

A decode-confirmed hit forces the **security dimension score to 0** — a
disqualifying override, not a weighted rubric signal. This is a deliberate
design choice, made instead of the originally planned `no-hidden-payload`
weighted signal (weight 3): the 400-server audit that measured this technique
found **zero** payloads in the wild, meaning a weighted signal would evaluate
to 1.0 for 100% of the corpus. A constant-valued signal carries no
information, yet adding it to security's weight-6 denominator
(tool-surface 3 + no-secrets 1 + dependency-cves 2) would still *inflate*
every score by diluting the signals that do discriminate — measured effects
include a high-risk exec/shell server moving 60→73 and a high-risk server
with a secret candidate moving 43→62. That is a regression in scoring
quality, not an improvement.

An override avoids this entirely: it has **zero effect** whenever
`hiddenPayloadDecoded` is 0 or undefined — true for every server measured so
far, so this was a provable zero-regression change (confirmed by a full
corpus re-scan showing no grade changes) — and is **decisive** when a hit is
decode-confirmed, since a decode-confirmed payload is positive evidence of
deliberate concealment rather than a probabilistic guess (contrast the
committed-secrets heuristic above, ~13% true-positive rate). Weights and
dimension denominators elsewhere in the rubric are untouched.

**Observations (bidi overrides, invisible-character runs that don't decode)
never affect scoring**, at any weight, in any dimension — they are reported
for transparency only, exactly as in v1's findings-only integration.

## Known limitations (v1.3)

- Tool-schema extraction is best-effort static parsing across languages/idioms;
  it does not cover every framework, and a miss triggers the coverage gate
  (grade withheld) rather than a wrong score.
- The cost token footprint is only computed from genuinely serialized
  schemas; for the ~95% of servers whose tools are extracted from source,
  cost rests on tool count alone and its dimension score is withheld. A
  dimension (or headline grade) resting on unmeasured primaries is withheld
  rather than renormalized — across ALL dimensions, not just cost.
- CVE resolution covers `package-lock.json`/`uv.lock`/`poetry.lock`; other
  lockfiles (pnpm, yarn, Pipfile) still fall back to declared floors.
- Monorepos are scored at repository granularity.
- The committed-secret heuristic is a candidate signal, not a real secret scan.
- Bare package names found on both npm and PyPI are rejected as ambiguous rather
  than guessed — use the `npm:`/`pypi:` prefix.
