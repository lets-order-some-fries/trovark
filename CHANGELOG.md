# Changelog

All notable changes to this project are documented in this file, reconstructed
from git history. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

- A committed `package-lock.json` / `uv.lock` / `poetry.lock` is now actually read.
  It ranked last inside the shared file budget, so any repository with a dozen or
  more source files never had its lockfile fetched and the CVE check ran at the
  manifest's declared floor (`^1.12.0` → `1.12.0`). Measured on `npm:loreweave`:
  three `security/dependency-cve` findings against `@modelcontextprotocol/sdk@1.12.0`
  that do not apply to the pinned `1.30.0`; the bare `lets-order-some-fries/loreweave`
  ref had no dependency check at all (security 2/3 signals, medium confidence).
  Lockfiles now get a dedicated fetch slot, as the README already did, so no source
  file is displaced. Dev-only lockfile entries (`dev: true`) are skipped — the
  registry path never counted devDependencies either. Cards can change: fewer
  false findings, and `dependency-cves` becomes measurable on repository refs.
  This is a correction to what was read, not a rubric change; the rubric version
  is unchanged.
- When a supported lockfile was not read but declared floors were queried anyway
  — which happens for an `npm:`/`pypi:` ref, where the registry manifest supplies
  them — the card now says the versions are floors, so a `dependency-cve` finding
  can be checked against what is actually installed. This caveat is scoped to
  registry refs on purpose. A bare `owner/repo` ref has no manifest to take
  floors from, so an unsupported lockfile (pnpm, yarn, bun, Cargo, `go.sum`,
  Pipfile, composer, or a lockfileVersion 1 `package-lock.json`) leaves it with
  **no dependency check at all** rather than a floor-based one: `dependency-cves`
  is reported unavailable and security scores on two signals. Every entry in the
  published index is a bare repo ref, so that is the usual outcome there.
- A committed lockfile that resolves to no runtime dependencies — every entry
  `dev: true`, or none — now scores as the clean measurement it is (check
  available, `cveWorst: none`) with a note saying so, instead of silently
  removing the dependency check. It removed it before: `seleniumboot/selenium-mcp`
  went C+/67 to C/62 with security 60 to 40 and zero findings on either side.
- A committed lockfile that could not be downloaded no longer voids the whole
  scorecard. It degrades to "no lockfile was read" and is named on the card;
  previously it forced a partial tool surface and withheld the grade, which took
  `TheLunarCompany/lunar` (A+/96) to `insufficient data` on one attempt in three.

## [0.1.9] - 2026-09-10

An adversarial pass over everything the CLI says when something goes wrong, and
over what a scanned repository can make it print.

- `--fail-under` honours `+`/`-` modifiers. `B+` now gates at 80 (it gated at 70, the
  bare-B floor, because the modifier was stripped before lookup); `A+` at 96 (was 85),
  `C+` at 65 (was 55), `D+` at 50 (was 40). Bare letters and minus forms are unchanged,
  so `--fail-under B` still passes a B-. If a CI gate used a plus form, it was weaker than
  it read and will now enforce what it says.
- An exhausted GitHub rate limit, a rejected `GITHUB_TOKEN`, or an unreachable registry is
  reported as that — the caller's budget, credential, or network — instead of as
  `INSUFFICIENT DATA` about the ref or as a malformed reference.
- Repository content can no longer drive the terminal (control characters in tool names,
  paths and decoded payloads are rendered as visible escapes; `--json` is untouched), forge
  report lines, or make extraction quadratic.
- `bun.lock`, `deno.lock`, `packages.lock.json`, `pdm.lock` and `npm-shrinkwrap.json` count
  as lockfiles. Four indexed repositories gain the signal on the next rescan.
- A package ref that resolves into a monorepo says so on the card; `--help` exits 0.

## [0.1.8] - 2026-08-15

Rubric 1.7.0, the tool-surface observatory, and the fixes an adversarial fault
hunt found in everything above.

- **The observatory (D2):** every scan records a hash-based snapshot of each server's tool surface; the git history of `index/surfaces/` is the dataset. Drift between scans is published as a neutral feed — counts and dates, never a characterization of intent. Baseline: 268 surfaces. First measured drift: 2 of 250 re-snapshotted servers in ~21h.
- **Rubric 1.7.0 — cost scores tool-surface size.** `token-footprint` is computable for ~5% of servers, and through the 3-of-4 coverage gate it was silently keeping 22% of the corpus from being graded at all. It is now published as a fact (`cost/token-footprint`) and informs confidence, but does not score. Cost confidence reflects the quality of the count: high when every schema was readable, medium when counted from code, low when read from a README.
- **Stopped publishing "not an MCP server" about real MCP servers** — including Microsoft's `Azure/azure-mcp`. An absence claim now requires a non-empty sample, no self-identification as a server, and a language the detector can read (9 of 20 such verdicts were false).
- **A headline grade requires 3 of 4 measured dimensions.** 42 servers had been publishing letters computed from half the rubric.
- **Withheld grades are withheld in the DATA**, not just the display: 29 of 29 insufficient-data servers had been publishing letter grades, several "A".
- **Dimensions with no measurement report `null`**, never a fabricated 100 or 0; a partial tool surface can no longer publish a clean risk verdict.
- **Scanner honesty:** a scan now either writes an index or says why it did not — completeness gate, outage gate that counts gracefully-degraded entries, a deadline that actually fires, and failed blob fetches recorded rather than swallowed.
- `--fail-under` no longer exits 0 on an ungraded card; `--version` no longer reports 0.1.0.

## [0.1.7] - 2026-08-07

Rubric 1.6.0: a number is measured or it is withheld.

- Token footprint is now measured from real tool schemas or withheld entirely, rather than scored from an estimate (`dfc1d19`).
- Classifying a repo as "not an MCP server" requires evidence the scanner actually looked, not mere absence of a signal (`1d92dac`).
- Covered the CLI's `--fail-under` exit-code contract with tests, including that no threshold can turn INSUFFICIENT DATA into a pass (`a46c7f8`, #12).
- Re-scanned all 400 servers under rubric 1.6.0 and published the index (`982a42b`).

## [0.1.6] - 2026-08-06

Hidden-payload override (rubric 1.5.0) + the W6 coverage wave: six published falsehoods removed.

- Integrity phase 2: a decode-confirmed hidden-payload finding now disqualifies the grade outright, instead of the planned weight-3 signal — a check that fires for 0% or 100% of a corpus carries no information (`5f4deaf`).
- A partial tool surface may no longer publish a clean risk verdict (`e0c807e`).
- Withheld grades are withheld in the data itself, not just the display (`95c0e16`).
- Secrets scanning skips all documentation extensions, not only `.md` (`b390dce`).
- Shell-import risk floor scoped to README-sourced tool lists (`3814b38`).
- README catalogs and dynamic tool surfaces recognised by extraction; corpus re-scanned (`a86adaf`, `677b40c`).
- Added a README section on reading a scorecard (`eafc3df`, #11).

## [0.1.5] - 2026-08-04

Sampling reach + metadata-integrity differentiator (`feat/coverage-v1.5`).

- Added a decode-confirmed invisible-payload detector (findings only, no scoring change yet) (`3a35f07`).
- Recorded stricter, pre-audit integrity threshold clarifications (`d75864d`).
- Fixed the integrity scanner to never throw on scanned content and to whitelist only real RGI flags (`5a38ab5`).
- Published the first invisible-payload prevalence measurement across 400 servers (`f876f1b`).
- `SOURCE_HINT` now contributes to a ranking score rather than a hard gate; added fan-out budget and partial-surface honesty to collectors (`195668e`).
- Scoped the non-server fetch quota to `rankedSource` (`277464d`).

## [0.1.4] - 2026-08-03

Residual coverage recovery + two correctness fixes (rubric v1.4.0, `feat/coverage-v1.4`).

- Shipped rubric v1.4.0: unresolved-repo outcome + widened extraction (`b5e4cc1`).
- Added a second Python idiom pack and TS idiom pack for tool-schema extraction (`bc79750`, `96c2f16`).
- Fixed bracket scanning to be string/comment-aware, closing a phantom-tool detection vector (`899b244`).
- Stopped publishing a grade for unresolved repos (previously 18 false F cards) (`9681ace`).
- Accepted prefixed OpenAPI/Swagger spec filenames (e.g. Notion-style) (`8e0d48d`).
- Re-scanned the 400-server corpus: withheld 95 → 41, graded 267 → 305, 18 separated as unresolved (`640b982`).

## [0.1.3] - 2026-08-03

Coverage overhaul recovering previously-ungraded servers (rubric v1.3.0, `feat/coverage-v1.3`).

- Added a Go tool extractor (official go-sdk, mark3labs, self-register idioms), scoped to MCP-related files (`56474de`, `f0c13d8`).
- Added a TS idiom pack (`addTool`/`defineTool`/keyed-factory/class-based/wrapper extractors) and a Python class/decorator + OpenAPI extractor (`878dee7`, `2f85ac6`).
- Added library/SDK/proxy repo detection so those report "not a server" instead of insufficient data (`5d80495`, `e002edc`).
- Fixed MCP SDK 2.x detection, OpenAPI rung ordering, false-tool guards, and `notServer` semantics (`51ecf47`).
- Fixed monorepo sampling: dynamic budget, tool-signal ranking, larger entrypoint reads (`39ab510`).
- Restored starved entrypoint/manifest/extractor-tier files (a 16-server regression from the coverage work) (`fcf4051`).
- Re-scanned the corpus: 189 withheld → 95, 267 graded, 38 identified as libraries (`a099acc`).

## [0.1.2] - 2026-08-01

Precision overhaul from a 23-defect empirical audit (rubric v1.2.0, `feat/precision-v1.2`).

- Withhold a confident grade when the security tool-surface is undetermined, rather than guessing (`e137ab5`).
- Added a token-set tool-surface classifier, fixing exec/drop substring mis-tiering; dropped ambiguous run/code tokens from HIGH via a co-occurrence rule (`a214e4b`, `b60ceeb`).
- Query OSV at resolved lockfile versions instead of manifest floors; scoped the shell-import risk floor to source files (`58cf8b7`, `b18641b`).
- Stopped schema property names from inflating tool risk (`2a89606`).
- Fixed staleness stat (true >180-day check) and bus-factor/activity accuracy via paginated 365-day commit lookups (`e0ccc53`, `2a9c031`).
- Extended spec-era detection to fastmcp, Go, Rust, JVM, and .NET manifests (`0bebfcc`, `52cbc13`).
- Published methodology v1.2 covering the coverage gate, multi-language spec-era, token-set classifier, and resolved-version CVEs (`d845755`).
- Re-scanned all 400 servers twice against rubric v1.2: 238 → 0 confident-wrong grades, extraction 36% → 52%, 24 benign tools un-inflated (`674c9c8`, `48ec81e`).

## [0.1.1] - 2026-08-01

Phase 2 Trust Index + secret-detection precision fix (`feat/trust-index`).

- Rebranded the project from `mcpscore` to Trovark (`56db3f4`).
- Added the Trust Index pipeline: server discovery (`dbecec4`), concurrency-limited batch scanner (`ab95b97`), and a self-contained static site generator (`bb0563f`).
- Published the first live Trust Index: 400 servers scored under rubric v1.1.0 (`7e60780`).
- Demoted committed-secret findings to low-confidence candidates and hardened the secret detector to reject env-var references, identifiers, placeholders, and comments (`ea5bcb7`, `d13cf6f`).

## [0.1.0] - 2026-08-01

First published release: `mcpscore` CLI for MCP server trust scoring (`feat/v1`).

- Rubric v1.0.0 and a pure `score()`/`grade()` function with a confidence model (`3517617`, `81364cc`).
- Ref resolver for GitHub URLs, owner/repo shorthand, npm, and PyPI packages (`6677ac0`, `67664c4`).
- Collectors for GitHub metadata, npm downloads/deprecation, PyPI deps, and OSV CVE lookups (`f040d20`, `ae2d377`).
- Derivers for repo health checks, MCP spec-era detection, tool-schema extraction, surface risk, token estimate, and committed-secret scanning (`79a3fb5`, `95012be`, `20c9490`).
- Assemble pipeline combining collectors and derivers into `Signals` with graceful degradation on partial data (`9524398`).
- Terminal report renderer (ANSI, bars, findings) and stable JSON output (`491dbe3`).
- `mcpscore` CLI command with exit codes and `--fail-under` gate; initial README and methodology docs (`ad68a3b`).

[0.1.5]: https://github.com/lets-order-some-fries/trovark/compare/1aad802...8956f57
[0.1.4]: https://github.com/lets-order-some-fries/trovark/compare/a5f0a06...640b982
[0.1.3]: https://github.com/lets-order-some-fries/trovark/compare/3f37d2b...a099acc
[0.1.2]: https://github.com/lets-order-some-fries/trovark/compare/5c4bde8...3f37d2b
[0.1.1]: https://github.com/lets-order-some-fries/trovark/compare/6506373...7cbbc4d
[0.1.0]: https://github.com/lets-order-some-fries/trovark/commits/6506373
