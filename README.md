# mcpscore

**Trust score for MCP servers.** One command answers: *should I adopt this server?*

    npx mcpscore github/github-mcp-server

mcpscore grades any MCP server 0–100 (A–F) from **static, public signals only** —
maintenance health, spec conformance, security hygiene, and context-token cost.
It never executes the server's code. Every finding links to its evidence.

## Usage

    npx mcpscore <ref>                    # GitHub URL, owner/repo, npm, or PyPI name
    npx mcpscore <ref> --json             # machine-readable scorecard
    npx mcpscore <ref> --fail-under B     # CI gate: exit 1 below the threshold
    GITHUB_TOKEN=... npx mcpscore <ref>   # higher rate limits + responsiveness signals

## What the grade means

| Dimension | Weight | Question it answers |
|---|---|---|
| Health | 35% | Is this maintained, or one life-change from abandonment? |
| Reliability | 25% | Does it target the current MCP spec? Is it tested, CI'd, pinned? |
| Security | 25% | Risky tool surface, committed secrets, known CVEs in deps? |
| Cost | 15% | How many context tokens does its tool schema eat? |

Missing data lowers *confidence* — it is never silently scored as zero.
Full methodology: [docs/methodology.md](docs/methodology.md). Rubric is versioned; the scorecard records the version that graded it.

## What mcpscore is not

- It does not run or sandbox servers (static analysis only — v1).
- Findings are *surfaces and heuristics with evidence links*, not claimed exploits.

Apache-2.0.
