# trovark

[![CI](https://github.com/lets-order-some-fries/trovark/actions/workflows/ci.yml/badge.svg)](https://github.com/lets-order-some-fries/trovark/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/trovark)](https://www.npmjs.com/package/trovark)

trovark gives an MCP server a 0–100 score and a letter grade (A–F), to help you
decide whether to adopt it. It reads only static, public signals (maintenance
health, reliability, security hygiene and tool-surface size) and never runs the
server's code. Every finding links to its evidence.

    npx trovark github/github-mcp-server

[The index](https://lets-order-some-fries.github.io/trovark/) applies it to 400
public MCP servers. Its latest scan, from 2026-08-15 (trovark 0.1.8, rubric
1.7.0), graded 310 of them; 55 were withheld for insufficient data, 16 were
classified as libraries rather than servers, 1 has a dynamic tool surface, and
18 repositories were unavailable.

## Usage

    npx trovark <ref>                    # GitHub URL, owner/repo, npm, or PyPI name
    npx trovark <ref> --json             # machine-readable scorecard
    npx trovark <ref> --fail-under B     # CI gate: exit 1 below the threshold
    GITHUB_TOKEN=... npx trovark <ref>   # higher rate limits + responsiveness signals

A bare package name that exists on both npm and PyPI is rejected as ambiguous — disambiguate with the `npm:<name>` or `pypi:<name>` prefix (e.g. `npx trovark pypi:mcp-server-fetch`).

## CI usage

`--fail-under` turns a scan into a pass/fail gate: exit 0 when the grade meets the
threshold, exit 1 when it doesn't, exit 2 on a resolution or network error.

The threshold is a number or a grade. A grade with a modifier gates at that label's
floor (`B+` = 80, `A-` = 85); a bare letter gates at the whole band (`B` = 70, the same
as `B-`), so `--fail-under B` passes a B-.

The [ungradeable states](#reading-a-scorecard) do not all fail the gate the same way,
so a workflow that branches on the exit code needs the distinction:

| State | with `--fail-under` | without |
|---|---|---|
| `INSUFFICIENT DATA` | 2 | 2 |
| `REPO UNAVAILABLE` | 2 | 2 |
| `LIBRARY` | 1 | 0 |
| `DYNAMIC TOOL SURFACE` | 1 | 0 |

The first two are errors either way: nothing was measured. The last two are correct,
successful answers — there is genuinely no grade to give — so they only fail once a
threshold demands one.

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

Each index scan also stores a hash-based snapshot of every tool surface it could
read (268 servers in the 2026-08-15 scan, under `index/surfaces/`) and lists
changes between scans as a drift feed. Snapshots store hashes, not content;
drift events carry no findings and do not affect scores. Details and limits:
[Tool-surface observatory](docs/methodology.md#tool-surface-observatory-d2).

## Reading a scorecard

An illustrative card (`acme/weather-mcp` is a made-up repository):

    npx trovark acme/weather-mcp

    trovark  ·  acme/weather-mcp
      resolved: github.com/acme/weather-mcp · graded at main@3f9c1ab
    Trust Score: 74/100 (B-)   rubric v1.7.0

      health         75/100  ████████░░  high confidence
      reliability    44/100  ████░░░░░░  high confidence
      security       85/100  █████████░  medium confidence
      cost          100/100  ██████████  high confidence

    Metadata Integrity: 0 findings across 2 files / 239 characters / 3 tool descriptions.

- **`Trust Score: 74/100 (B-)`** — the overall 0–100 score and letter grade, the weighted sum
  of the four dimensions above. `rubric v1.7.0` is the rubric version that produced this
  scorecard; scorecards from different rubric versions aren't directly comparable.
- **Dimension rows** (`health 75/100 ... high confidence`) — each dimension's own 0–100 score
  plus a confidence level (`high` ≥75%, `medium` ≥40%, `low` <40% of that dimension's signal
  weight was measured; for cost it reflects how the tool count was obtained). Low confidence
  means the score rests on fewer inputs, not that the server scored badly.
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
- **`DYNAMIC TOOL SURFACE`** — the ref is a gateway, proxy or registry that assembles its
  tools at runtime from servers it federates, so there is no static surface to read. Grading
  what such a repo declares about itself would measure the wrong thing. No score is computed,
  and `--json` carries `notServerReason: "dynamic"`.

**An `npm:` or `pypi:` ref is scored at repository granularity.** The package resolves to the
repository that hosts it, and everything below — the tool count, every finding, every piece of
evidence — describes that whole repository. For a monorepo, two different packages therefore
score identically, and a finding can cite a file belonging to a sibling package. When that is
the case the card says so in `Notes`, naming the repository and the package.

**Every ref is graded at the repository's default branch, as of `generatedAt`.** The card names
the revision it read — `resolved.branch`, `resolved.commit` and `resolved.treeRefSha` in `--json`,
and a `graded at <branch>@<sha>` segment on the terminal header — so the score can be
re-derived later rather than merely re-run. For an `npm:` or `pypi:` ref this is deliberately
**not the published version**: the package name resolves the repository, and the files are then
read from that repository's default branch, which for most packages has moved past the commit
the release was cut from. `resolved.npmVersion` records the version that *would* be installed,
and when npm publishes a `gitHead` for it and that commit differs from the branch tip, the card
says so in `Notes`. When npm publishes no `gitHead`, no divergence is claimed either way — the
`resolved:` line still states exactly which branch and sha were read.

`--json` carries the same information as structured fields (`overall`, `grade`,
`dimensions[].confidence`, `insufficientData`, `notServer`, `unresolved`) instead of prose — see
[`src/types.ts`](src/types.ts) for the full `Scorecard` shape.

Abridged, from `npx trovark@0.1.10 github/github-mcp-server --json`, run on 2026-11-15
without a token:

    {
      "ref": "github/github-mcp-server",
      "rubricVersion": "1.7.0",
      "checksVersion": "1.0.0",
      "overall": 93,
      "grade": "A",
      "dimensions": [
        { "id": "health",      "score": 100,  "confidence": "high", "available": 6, "total": 7, "findings": [] },
        { "id": "reliability", "score": 100,  "confidence": "high", "available": 5, "total": 5, "findings": [] },
        { "id": "security",    "score": 77,   "confidence": "high", "available": 3, "total": 3, "findings": [ … ] },
        { "id": "cost",        "score": null, "confidence": "low",  "available": 0, "total": 1, "findings": [] }
      ],
      "notes": [ "No cost signals could be collected; cost is excluded from the overall score." ],
      …
      "resolved": {
        "repo": { "owner": "github", "name": "github-mcp-server" },
        "branch": "main",
        "commit": "0663b830582af923e30fb14cb2e10dd3248baa86",
        "treeRefSha": "0663b830582af923e30fb14cb2e10dd3248baa86"
      }
    }

`available` and `total` show how much of each dimension was measured. Health is 6 of 7 here
because the run had no `GITHUB_TOKEN`, so issue responsiveness was not collected. Cost is
`null` rather than a guessed number, and `notes` says it was left out of the overall score.

## About `GITHUB_TOKEN`

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

## What trovark is not

- It does not run or sandbox servers; the analysis is static only.
- Findings are *surfaces and heuristics with evidence links*, not claimed exploits.

Apache-2.0.
