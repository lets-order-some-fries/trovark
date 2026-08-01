> **RENAMED 2026-08-01:** The product is now **Trovark** (`npx trovark`) — repo `lets-order-some-fries/trovark`. "mcpscore" below is the original working name, kept for historical accuracy.
# mcpscore — Design

**Date:** 2026-07-31 · **Status:** Approved (design); pre-implementation
**Owner:** Ambuj Upadhyay · **Working name:** `mcpscore` (final name is an open decision the owner can change at any time before launch)

## One-line definition

`npx mcpscore <server>` gives any MCP server a trust grade a developer can act on — answering **"should I adopt this server?"** — computed entirely from public, static signals. No code from the scanned server is ever executed. Zero infrastructure cost.

## Why this product (context)

Deep market research (2026-07-31, recorded in the CareerMap repo at `ventures/2026-07-31_ai-market-research-zero-capital.md`) established, via adversarially verified claims:

- Agent security/governance is a confirmed, underserved, growing category (Gartner: $492M → $1B+ by 2030).
- The MCP ecosystem is very large (order 10k+ public servers), but **no trustworthy, first-party data exists on its health** — every viral statistic about MCP rot/vulnerability failed adversarial source-verification.
- The only startup moats that still survive AI-compressed build times: continuously generated operational data, and network effects.

mcpscore attacks that void: it *produces* the first-party data. The scan corpus is the moat; transparent methodology is the credibility.

**Strategy (Approach A):** engine + CLI first → dogfood until the score is credible → then batch-scan the whole public ecosystem and launch the public Trust Index ("we scored every public MCP server") as the distribution event. Never launch the index on an untested rubric.

## Users and core value

- **v1 user:** a developer deciding whether to add an MCP server to their agent stack (Claude Code, Cursor, custom agents). Value: a 5-second, evidence-backed adopt/avoid signal instead of 30 minutes of repo spelunking.
- **v1 secondary user:** a team gating MCP servers in CI (`--fail-under`).
- **Later:** MCP server authors (badges), platform/security teams (private registry scans — the paid product).

## Score model

Composite **Trust Score**: 0–100 plus letter grade, health-led, four dimensions.

| Dimension | Weight | Signals (all static/public) |
|---|---|---|
| Health / Maintenance | 35% | days since last commit and last release; commit activity over trailing 90 days; bus factor (committers with ≥ 3 commits in the trailing 12 months); issue/PR responsiveness (median time-to-first-response over the trailing 90 days); stars + registry downloads; archived/deprecated flags; release cadence & semver hygiene |
| Reliability / Conformance | 25% | MCP SDK dependency version mapped to spec era (pre-/post-session-refactor servers are flagged as churn casualties); CI config present; test files present; lockfile / pinned dependencies; declared transports & capabilities parseable |
| Security / Hygiene | 25% | tool-surface risk from declared tool schemas (shell/exec, filesystem-write, eval, network-egress patterns); destructive tools without auth indication; committed-secret regex scan of the repo tree (gitleaks-style patterns); known CVEs in the dependency tree via OSV.dev; injection-surface heuristics (string-interpolated command construction patterns in source) |
| Cost / Efficiency | 15% | estimated token footprint of the full tool-schema preload (labeled as an estimate); number of tools; schema verbosity ratio |

### Scoring rules

- **Grades:** A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40. Numeric score always shown alongside. `+`/`-` modifiers at the top/bottom 5 points of each band.
- **Confidence:** every dimension carries `high | medium | low` confidence based on how many of its signals were computable. A dimension with < 40% of signals available is scored from what exists but marked `low` and the overall report says so plainly. Missing data lowers confidence, never silently scores zero.
- **Evidence rule (non-negotiable):** every finding is severity-tagged, explained in one plain sentence, and linked to its evidence (file, commit, API response, CVE ID). We report *surface and heuristics*, never claimed exploits. No finding without a link a skeptic can check.
- **Versioned rubric:** weights and signal definitions live in a versioned rubric file; every scorecard records the rubric version it was scored under. Methodology doc is published with the tool.

## Architecture

TypeScript / Node ≥ 20, ESM. Rationale: the MCP ecosystem is JS-native, `npx` is the zero-friction distribution devs expect, GitHub Actions wrap trivially. Dependencies kept deliberately minimal (a security-adjacent tool with hundreds of transitive deps undermines its own message): built-in `fetch`, `commander` (or hand-rolled args), `gpt-tokenizer` for token estimates, `vitest` for tests. No LLM inference in v1 — every run is $0.

Small single-purpose modules; the scoring engine is a pure function.

```
src/
  resolver/        ref (GitHub URL | npm | PyPI | registry slug) → ServerIdentity
  collectors/
    github.ts      repo metadata, activity, contributors, issues/PRs, tree scan
    npm.ts         registry metadata, downloads, deprecation
    pypi.ts        same for Python servers
    osv.ts         dependency CVE lookup (OSV.dev free API)
    schema.ts      static tool-schema extraction (see below)
    spec.ts        SDK version → MCP spec-era mapping
  scoring/
    rubric.ts      versioned weights + signal definitions
    score.ts       pure: Signals → Scorecard (deterministic)
  report/
    terminal.ts    human-readable colored output
    json.ts        stable machine-readable schema
    markdown.ts    for CI comments / index pages later
  cli.ts           resolve → collect (parallel) → score → report
```

**Data flow:** `cli` resolves the ref, fans out collectors in parallel, assembles a `Signals` object (each field present, absent, or errored), passes it to `scoring` (pure), renders via `report`.

**Interfaces:** each collector exports one function `collect(identity, ctx) → Partial<Signals>` and declares which signal keys it owns. `score(signals, rubric) → Scorecard` is total: it accepts any subset of signals and returns a scorecard + confidence annotations. Renderers consume `Scorecard` only. Any module can be replaced without touching the others.

### Static tool-schema extraction (the hard part, honestly scoped)

Best-effort ladder, stop at first success:
1. **Manifests:** `mcp.json`, `smithery.yaml`, `server.json`, `package.json` MCP fields.
2. **Source heuristics:** grep-level AST-lite scan for registration patterns — `server.tool(`, `@mcp.tool` decorators, `ListToolsRequestSchema` handlers — extracting tool names, descriptions, and JSON/zod schemas where parseable.
3. **Fallback:** mark schema-dependent signals unavailable → Security and Cost dimensions drop to `low` confidence with an explicit "could not statically extract tool schemas" note.

This is stated in the methodology doc as best-effort. Dynamic extraction (actually handshaking a sandboxed server) is Phase 3+, not v1.

## CLI contract

```
npx mcpscore <ref>              # human report
npx mcpscore <ref> --json       # machine-readable
npx mcpscore <ref> --fail-under B   # exit 1 if grade below B (accepts letter or number)
```

- `GITHUB_TOKEN` (optional, BYOK) raises API limits; without it the tool works in low-rate mode.
- Exit codes: `0` ok · `1` fail-under violation · `2` execution error.

## Error handling

- Network/API failure: retry ×2 with backoff, then mark that source unavailable and continue. A partial scorecard with honest confidence flags always beats a crash.
- Unresolvable ref: clear error listing accepted ref forms, exit 2.
- Rate-limited without token: proceed on cached/partial data where possible; print one-line hint to set `GITHUB_TOKEN`.
- The scoring engine never throws on missing signals — absence is a modeled state.

## Testing

- **Scoring engine:** table-driven unit tests + golden scorecard fixtures (signals JSON → expected scorecard). The engine is pure, so this is exhaustive and fast. Rubric changes show up as reviewable golden-file diffs.
- **Collectors:** recorded API-response fixtures; no live network in CI.
- **Schema extraction:** fixture corpus of real-world server repos (TS SDK style, Python decorator style, manifest style, unextractable) — this is where correctness is hardest and tests matter most.
- **Smoke:** a checked-in list of ~15 well-known servers + a manual live-run script; used for dogfooding and rubric calibration, not CI.

## Phases

- **v1 (now):** resolver, collectors (github, npm, pypi, osv, schema, spec), scoring engine + rubric v1, terminal/JSON reports, `--fail-under`, tests as above. Done when `npx mcpscore` on the 15-server smoke list produces grades an experienced dev nods at, with every finding evidence-linked.
- **Phase 2 (launch):** `index-builder` batch-runs the engine across all public servers (registries + curated lists) → static public **Trust Index** site; the launch post publishes *our* first-party ecosystem numbers (finally answering "how many MCP servers are actually dead/risky?" with auditable data). GitHub Action packaging. Markdown badges.
- **Phase 3 (business):** hosted private-registry scanning, continuous monitoring + alerts, API access, author badges program. Snyk/Socket playbook. Dynamic sandboxed probing becomes feasible here.

Out of scope everywhere until Phase 3: accounts, servers, databases, LLM-generated prose.

## Distribution & monetization

Free OSS CLI (Apache-2.0 — patent grant suits a security-adjacent tool; owner can veto) + free public index as top-of-funnel. Revenue starts Phase 3 with private scanning in CI — the "scan *our internal* MCP servers" ask that public scanning seeds. GitHub/HN/X only, per zero-capital constraint.

## Risks (honest)

- **Methodology credibility is the whole product.** One viral wrong grade kills trust. Mitigations: evidence rule, versioned public rubric, conservative language ("surface", "heuristic", "estimate"), dogfood-before-launch sequencing.
- **Registries add native trust signals.** npm's existence didn't preclude Snyk/Socket; independence + cross-registry coverage + methodology transparency is the defense.
- **MCP loses standard status.** Currently the confirmed winner (OpenAI/Google/Microsoft adoption, Linux Foundation governance). Monitored; the collector/scoring split means the engine could retarget a successor protocol.
- **Big player clones it.** The scan corpus, published track record, and badge network effects are the defensible parts; speed and focus are the rest.

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| Positioning | Composite trust score, health-led | Broad uncontested funnel now, expands into security spend later (owner-selected) |
| Build order | Engine + CLI → index launch (Approach A) | Score earns credibility before the one big launch |
| Analysis mode | Static/public only in v1 | $0 to run; never execute untrusted code solo |
| Language | TypeScript, Node ≥ 20, ESM | Ecosystem-native, `npx` distribution, trivial CI wrapping |
| Inference | None in v1 | True zero marginal cost; BYOK LLM summaries optional later |
| License | Apache-2.0 (owner may veto) | Patent grant, enterprise-friendly, adoption-maximizing |
| Name | `mcpscore` (working) | Legible in `npx mcpscore`; final naming open |
