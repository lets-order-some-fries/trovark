# trovark

[![CI](https://github.com/lets-order-some-fries/trovark/actions/workflows/ci.yml/badge.svg)](https://github.com/lets-order-some-fries/trovark/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/trovark)](https://www.npmjs.com/package/trovark) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**Trust score for MCP servers.** One command answers: *should I adopt this server?*

    npx trovark github/github-mcp-server

trovark grades any MCP server 0–100 (A–F) from **static, public signals only** —
maintenance health, spec conformance, security hygiene, and tool-surface size.
It never executes the server's code. Every finding links to its evidence.

## Usage

    npx trovark <ref>                    # GitHub URL, owner/repo, npm, or PyPI name
    npx trovark <ref> --json             # machine-readable scorecard
    npx trovark <ref> --fail-under B     # CI gate: exit 1 below the threshold
    GITHUB_TOKEN=... npx trovark <ref>   # higher rate limits + responsiveness signals

A bare package name that exists on both npm and PyPI is rejected as ambiguous — disambiguate with the `npm:<name>` or `pypi:<name>` prefix (e.g. `npx trovark pypi:mcp-server-fetch`).

### About `GITHUB_TOKEN`

- **Scopes needed: none.** trovark only calls public read endpoints
  (`GET /repos/...`, `/commits`, `/releases`, `/issues`, `/issues/{n}/comments`)
  against `api.github.com`. A classic PAT with zero scopes checked, or a
  fine-grained PAT with "Public Repositories (read-only)" access, is enough.
- **Without a token:** everything except median issue time-to-first-response
  is still collected, at GitHub's unauthenticated rate limit (60 requests/hour).
- **With a token:** the same signals, plus median issue time-to-first-response
  (Health dimension), at the authenticated rate limit (5,000 requests/hour).
- **Security note:** the token is sent as a `Bearer` header on `api.github.com`
  requests only, and only ever used for `GET` reads — trovark never writes to
  GitHub.

## CI usage

`--fail-under` turns a scan into a pass/fail gate: exit 0 when the grade meets the
threshold, exit 1 when it doesn't (or when the ref can't be graded at all — see
[Reading a scorecard](#reading-a-scorecard) for the ungradeable states, all of which
fail the gate), exit 2 on a resolution/network error.

```yaml
# .github/workflows/trovark.yml
name: trovark
on: [push]
jobs:
  trust-score:
    runs-on: ubuntu-latest
    steps:
      - run: npx trovark ${{ github.repository }} --fail-under B
```

Set `GITHUB_TOKEN` in the job's `env` for higher rate limits and issue-responsiveness
signals — the default `GITHUB_TOKEN` GitHub Actions provides is sufficient (read-only).
See [About `GITHUB_TOKEN`](#about-github_token) for exactly which scopes it needs (none).

## What the grade means

| Dimension | Weight | Question it answers |
|---|---|---|
| Health | 35% | Is this maintained, or one life-change from abandonment? |
| Reliability | 25% | Does it target the current MCP spec? Is it tested, CI'd, pinned? |
| Security | 25% | Risky tool surface, committed secrets, known CVEs in deps? |
| Cost | 15% | How large is its tool surface? (tool count — the serialized token footprint is reported as a fact where measurable, but does not score) |

Missing data lowers *confidence* — it is never silently scored as zero.
Full methodology: [docs/methodology.md](docs/methodology.md). Rubric is versioned; the scorecard records the version that graded it.

### The observatory

The index also snapshots every scanned server's extracted tool surface on each
scan and publishes changes as a neutral drift feed — the only public index that
remembers what every server's tool surface looked like last month. Snapshots
store hashes, not content; drift events carry zero findings and zero score
impact. Details and honest scope limits:
[Tool-surface observatory](docs/methodology.md#tool-surface-observatory-d2).

## Reading a scorecard

    npx trovark acme/weather-mcp

    trovark  ·  acme/weather-mcp
      resolved: github.com/acme/weather-mcp
    Trust Score: 74/100 (B-)   rubric v1.5.0

      health         75/100  ████████░░  high confidence
      reliability    44/100  ████░░░░░░  high confidence
      security       85/100  █████████░  medium confidence
      cost          100/100  ██████████  high confidence

    Metadata Integrity: 0 findings across 2 files / 239 characters / 1 tool descriptions.

- **`Trust Score: 74/100 (B-)`** — the overall 0–100 score and letter grade, the weighted sum
  of the four dimensions above. `rubric v1.5.0` is the rubric version that produced this
  scorecard; scorecards from different rubric versions aren't directly comparable.
- **Dimension rows** (`health 75/100 ... high confidence`) — each dimension's own 0–100 score
  plus a confidence level (`high` ≥75%, `medium` ≥40%, `low` <40% of that dimension's signals
  were collectible). Low confidence means the score rests on fewer inputs, not that the server
  scored badly.
- **Findings** (printed only when a dimension surfaces one), e.g. for a server exposing a
  `run_bash_command` tool:

      [high] security/shell-exec-tool — Tool "run_bash_command" appears to execute commands or code.
             evidence: src/server.js

  `security/shell-exec-tool` is the finding's stable id, `[high]` its severity, and `evidence:`
  a file path or URL — check it yourself, trovark never asks you to take a finding on faith.
- **`Metadata Integrity`** — a static scan of tool metadata and fetched files for hidden Unicode
  payloads (invisible characters that can smuggle instructions). "0 findings across N files" is
  a clean scan, not an unset one; a separate `not checked — no files fetched` line means the
  scan never ran because no files were retrieved.
- **`Notes`** (printed only when relevant) — plain-language reasons a signal was missing, a
  dimension was excluded, or a grade was withheld.

Not every ref gets a Trust Score — trovark distinguishes "we don't know" from "there's nothing
to grade":

- **`Trust Score: INSUFFICIENT DATA`** — the grade is withheld rather than computed from partial
  signals. This happens when the tool surface can't be statically determined, or two or more
  whole dimensions have zero collectible signals; `Notes` explains why.
- **`LIBRARY — not an MCP server`** — the ref is an SDK, proxy, or distribution stub with no
  tools of its own to grade. No score is computed, and `--fail-under` is a no-op against it.
- **`REPO UNAVAILABLE`** — the reference doesn't resolve to an existing, accessible GitHub repo
  (renamed, deleted, or never existed). No score, no findings.

`--json` carries the same information as structured fields (`overall`, `grade`,
`dimensions[].confidence`, `insufficientData`, `notServer`, `unresolved`) instead of prose — see
[`src/types.ts`](src/types.ts) for the full `Scorecard` shape.

## What trovark is not

- It does not run or sandbox servers (static analysis only — v1).
- Findings are *surfaces and heuristics with evidence links*, not claimed exploits.

Apache-2.0.
