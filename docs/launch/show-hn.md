# Show HN launch draft — Trovark

*Draft for Ambuj to review, edit into his own voice, and post when ready. Nothing here is posted automatically. Numbers are from the 2026-08-01 scan of 400 servers (rubric v1.1.0) and should be regenerated right before posting so they're current.*

---

## Title (pick one)

- **Show HN: Trovark – I scored 400 MCP servers for trustworthiness (npx trovark)**
- **Show HN: A trust score for MCP servers, from static public signals**
- **Show HN: Trovark – "should I install this MCP server?" as one command**

## URL

`https://lets-order-some-fries.github.io/trovark/`  *(the Trust Index — links to repo + npm)*

## Body

I kept adding MCP servers to my agents without any real sense of which ones were maintained, safe, or about to break. So I built **Trovark**: one command that grades any MCP server 0–100 from **static, public signals only** — it never runs the server's code.

    npx trovark github/github-mcp-server

Four dimensions: **health/maintenance** (is it actively maintained, or one commit from abandonment?), **reliability** (does it target the current MCP spec? tests, CI, pinned deps?), **security hygiene** (risky tool surface, dependency CVEs via OSV, committed-secret candidates), and **context cost** (how many tokens its tool schema eats). Every finding links to its evidence — a file path or a CVE ID — so you can check my work. The rubric is versioned and public.

Then I ran it across **400 servers** from the community lists and put the results in a Trust Index (link above). First-party numbers, since I couldn't find anyone else publishing them:

- **Grade curve:** A 140 · B 130 · C 79 · D 27 · F 6 — average 77. Not everything gets an A.
- **~14% (58 servers) are in poor health** — stale/abandoned by the maintenance signals. This is the "will this still work in six months" question nobody quantifies.
- **13 expose shell/exec tools** — a real capability worth knowing about before you wire one into an autonomous agent.
- **18 came back "insufficient data"** — gone private, moved, or renamed. Trovark says *insufficient data* and withholds a grade instead of inventing one.

**The part I'm most torn about, told straight:** I also scan for hardcoded secrets. My first run flagged 32 servers — including some well-known companies. Before publishing that, I manually audited a sample and found **zero real leaks** — all env-var references, placeholders, and identifiers. I tightened the detector and re-ran: 15 flagged, and on a full manual audit only ~2 held up (~13% true-positive rate). So I **demoted secret findings to a low-confidence "candidate" signal** that no longer dominates a grade, and I don't headline a count. If you need real secret scanning, use gitleaks or trufflehog — they scan full history and verify liveness. I'd rather ship an honest weak signal than a scary wrong number.

Stack: TypeScript, one runtime dependency, runs on free public APIs (bring your own `GITHUB_TOKEN` for higher rate limits). Apache-2.0. It's early — the biggest known gap is tool-schema extraction coverage, and the roadmap is a hosted index + CI gate. Methodology and limitations are written up in the repo.

I'd genuinely like to hear where the grades feel wrong — that feedback is how the rubric gets calibrated.

Repo: https://github.com/lets-order-some-fries/trovark
npm: https://www.npmjs.com/package/trovark

## Posting notes (for Ambuj, not the post)

- Regenerate the scan the morning you post (`discover → scan → site`), so numbers are current, then update them here.
- Post 8–10am ET on a weekday for best HN visibility.
- Be around for the first 2–3 hours to reply. HN rewards the author engaging.
- Lead every reply with substance; concede real limitations fast (the tool-extraction gap, the secret-scanning honesty above). The audience here respects "here's what it can't do yet."
- Do NOT name specific repos as having secrets/problems in comments — aggregate only. Per-repo claims need per-repo verification.
- If asked "why not just gitleaks / why trust your grades": Trovark answers a different question (adopt-or-not health+reliability+cost), not deep secret scanning; and every grade is evidence-linked and reproducible, not a black box.
