# trovark

**Trust score for MCP servers.** One command answers: *should I adopt this server?*

    npx trovark github/github-mcp-server

trovark grades any MCP server 0–100 (A–F) from **static, public signals only** —
maintenance health, spec conformance, security hygiene, and context-token cost.
It never executes the server's code. Every finding links to its evidence.

## Usage

    npx trovark <ref>                    # GitHub URL, owner/repo, npm, or PyPI name
    npx trovark <ref> --json             # machine-readable scorecard
    npx trovark <ref> --fail-under B     # CI gate: exit 1 below the threshold
    GITHUB_TOKEN=... npx trovark <ref>   # higher rate limits + responsiveness signals

A bare package name that exists on both npm and PyPI is rejected as ambiguous — disambiguate with the `npm:<name>` or `pypi:<name>` prefix (e.g. `npx trovark pypi:mcp-server-fetch`).

## What the grade means

| Dimension | Weight | Question it answers |
|---|---|---|
| Health | 35% | Is this maintained, or one life-change from abandonment? |
| Reliability | 25% | Does it target the current MCP spec? Is it tested, CI'd, pinned? |
| Security | 25% | Risky tool surface, committed secrets, known CVEs in deps? |
| Cost | 15% | How many context tokens does its tool schema eat? |

Missing data lowers *confidence* — it is never silently scored as zero.
Full methodology: [docs/methodology.md](docs/methodology.md). Rubric is versioned; the scorecard records the version that graded it.

## What trovark is not

- It does not run or sandbox servers (static analysis only — v1).
- Findings are *surfaces and heuristics with evidence links*, not claimed exploits.

Apache-2.0.
