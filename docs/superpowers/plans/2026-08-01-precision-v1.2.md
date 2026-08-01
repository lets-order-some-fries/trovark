# Trovark Precision Overhaul → rubric v1.2.0

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make every signal ground-truth-accurate and stop confidently-wrong grades, per the empirical precision audit (`.superpowers/sdd/precision-plan.md`, 23 verified defects). Bump `RUBRIC_VERSION` → `1.2.0`.

**Source of truth for each fix:** `.superpowers/sdd/precision-plan.md` (implementation-ready designs with evidence). This plan groups the 18 actionable items into 7 reviewable tasks, respecting the audit's convergences (9=21=23, 12+19, 14 folds 3, 4+6 together).

## Global Constraints
- No new runtime deps (gpt-tokenizer only). NodeNext ESM, `.js` imports. TDD. `npm test` + `npm run build` green before each commit.
- Precision over recall: a withheld/lower-confidence grade beats a confidently-wrong one.
- Never execute scanned code. Every finding evidence-linked. Absence lowers confidence, never fakes a value.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `RUBRIC_VERSION` becomes `'1.2.0'` in Task P1; update the one real-pipeline assertion in `tests/score.test.ts` and `tests/cli.test.ts`; leave hand-built `'1.0.0'`/`'1.1.0'` fixture literals in report/site tests only if they are pure renderer inputs (they are).

---

### Task P1 — ⭐ Grade-withholding coverage gate (audit 9+21+23)

**Files:** `src/scoring/score.ts`, `src/types.ts`, `tests/score.test.ts`; `RUBRIC_VERSION` in `src/scoring/rubric.ts`; `docs/methodology.md`.

**Defect:** `insufficientData` trips only below 4 *total* signals; health(7)+reliability(5) always clear it, so when schema extraction fails, security renormalizes onto the lone weight-1 `no-secrets` candidate → security=100, confident A+. 238/382 servers affected.

**Fix:** In `score()`, after computing dimensions, add a **coverage gate**: define each dimension's PRIMARY signal (security→`tool-surface`, reliability→`spec-era`, health→`commit-recency`, cost→`token-footprint`). Compute `insufficientData = availableTotal < 4 || securityPrimaryAbsent || (dimensionsFullyDropped >= 2)` where `securityPrimaryAbsent` = the `tool-surface` signal evaluated to undefined (i.e. `signals.toolSurfaceRisk === undefined`). Keep the existing `<4` clause. Do NOT cap or zero any score — only route to the existing insufficientData handling (withhold the confident letter grade; the report already renders `INSUFFICIENT DATA` and CLI exits 2). Add note: `` `Security tool surface could not be determined — grade withheld to avoid a false clean bill.` `` when securityPrimaryAbsent.

- [ ] **Step 1 (RED):** add to `tests/score.test.ts`:
```ts
it('withholds grade when the security tool-surface signal is absent', () => {
  const s = healthy(); s.toolSurfaceRisk = undefined
  const card = score('x', s, 'T')
  expect(card.insufficientData).toBe(true)
  expect(card.notes.join(' ')).toMatch(/tool surface|grade withheld/i)
})
it('does NOT withhold when tool-surface is present (even if low)', () => {
  const s = healthy(); s.toolSurfaceRisk = 'high'
  expect(score('x', s, 'T').insufficientData).toBe(false)
})
it('withholds when two or more dimensions are fully dropped', () => {
  const s = empty(); s.daysSinceLastCommit = 5 // only health has 1 signal; reliability/security/cost empty
  expect(score('x', s, 'T').insufficientData).toBe(true)
})
```
Also update the existing `rubricVersion` assertion `'1.1.0'`→`'1.2.0'`.
- [ ] **Step 2:** run → the new tests fail (current code returns insufficientData=false for a fully-healthy card with tool-surface undefined).
- [ ] **Step 3:** implement the gate in `score.ts` + bump `RUBRIC_VERSION='1.2.0'` + update `tests/cli.test.ts` version literal + methodology header/version.
- [ ] **Step 4:** `npm test` + `npm run build` green.
- [ ] **Step 5:** commit `fix(scoring): withhold confident grade when security tool-surface is undetermined (v1.2.0)`.

---

### Task P2 — Reliability coverage across languages (audit 4, 5, 6-partial, 7, 8)

**Files:** `src/derive/specEra.ts`, `src/derive/repoChecks.ts`, `src/collectors/github.ts` (ALWAYS_FETCH basename match), tests for each.

**Fixes:**
1. **specEra fastmcp (5):** add a Python branch matching `fastmcp`/`fastmcp-slim` in dependency context (optional `[extras]`/version); any match → `'modern'`. (Standalone fastmcp is 2.x+, inherently modern.)
2. **specEra multi-ecosystem (4):** add readers for `go.mod` (`github.com/modelcontextprotocol/go-sdk` or `github.com/mark3labs/mcp-go`), `Cargo.toml` (`rmcp`), `build.gradle`/`build.gradle.kts`/`pom.xml` (`io.modelcontextprotocol`/`mcp` SDK), `.csproj` (`ModelContextProtocol`). When an MCP SDK is detected but era unknown → `'modern'` (these SDKs only existed post-2025 → ~zero FP). Judge library repos (mcp-go itself) as libraries — matching their *require* lines fixes downstream servers, not the lib.
3. **Non-root manifests (6):** in `github.ts`, change `ALWAYS_FETCH.has(b.path)` to basename match (`ALWAYS_FETCH.has(b.path.split('/').pop() ?? '')`) so workspace monorepos' nested manifests are fetched. Guard: keep the existing `FILE_CAP`; manifests already sit in the always-fetch list ahead of source, so they win budget naturally — but add a note that manifest fetches shouldn't starve source (acceptable at current cap; revisit in P4 if needed).
4. **Go tests (7):** add `/_test\.go$/` to `repoChecks` TESTS.
5. **Lockfiles (8):** add `go.sum`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `gradle.lockfile` to LOCKFILES.

- [ ] Write RED tests first for each: fastmcp pyproject→modern; fastmcp-slim→modern; `go.mod` with go-sdk→modern; `Cargo.toml` with rmcp→modern; a `.csproj` with ModelContextProtocol→modern; `foo_test.go`→hasTests; `go.sum`/`Cargo.lock`→hasLockfile; basename-match fetches `packages/x/package.json`. (specEra tests are pure-fn; the basename-fetch test extends `tests/github.test.ts` with a nested-manifest tree fixture.)
- [ ] Implement; `npm test` + build green; commit `fix(reliability): spec-era for fastmcp + Go/Rust/JVM/.NET; Go tests + more lockfiles; non-root manifests`.

---

### Task P3 — Schema extraction breadth (audit 10, 12+19, 13, 20, 15-safety, 11)

**Files:** `src/derive/schema.ts`, `src/collectors/github.ts` (file ranking), tests.

**Fixes:**
1. **registerTool (10):** JS matcher `/\.(?:registerTool|tool)\(\s*["'`]([\w.-]+)/`; keep capturing the following config as `schemaText`.
2. **Python imperative/bare (13):** add `\.tool\(\s*name\s*=\s*["']([\w-]+)`, `\b(?:add_tool|tool)\(\s*name\s*=\s*["']([\w-]+)`, and bare `@\w+\.tool\b` (decorator possibly split across lines from `def name(`).
3. **ListTools sibling-check (12+19):** in the `ListToolsRequestSchema` fallback, only count a `name:"x"` when the SAME object literal also has an adjacent `description:` or `inputSchema:` sibling (regex over a small window). This drops logger/config `name:` phantoms AND the `new Server({name})` identity phantom (tavily 6→5).
4. **Low-level Tool() literals (13-py/15-recall):** extract `Tool(name="x", description=...)` / `types.Tool(...)` literals (JS + Python) inside `list_tools` handlers.
5. **Exclude non-server paths + dedup (20):** exclude `tests/`, `__tests__`, `*_test.*`, `*.test.*`, `examples/`, `docs/`, `docs_src/` from schema file selection; dedupe tool names before counting/tokenizing.
6. **child_process safety floor (15-sec):** if any fetched file imports `child_process`/`spawn`/`execSync`/`subprocess`/`os.system` but no tools extracted, set `toolSurfaceRisk='medium'` (floor) so an arbitrary-shell-exec server can't score security 100 on secrets alone.
7. **File ranking grep pre-pass (11):** in `github.ts`, before spending the source-file budget, prefer files whose path matches `tools?/|server|index|main` AND whose (already-fetched-or-cheaply-probed) content bears a registration idiom. Keep `FILE_CAP` gated (no unbounded raise). Minimal version: rank the source candidates by a tool-signal score (path hint + ext) rather than pure shortest-path.

- [ ] RED tests (extend `tests/schema.test.ts`): registerTool extracts; `add_tool(name=...)` extracts; bare `@mcp.tool` extracts; a file with a logger `name:"log"` (no description sibling) is NOT counted; `new Server({name:"srv"})` is NOT a tool; a `tests/x.py` server file is excluded; duplicate tool names dedupe; a file importing `child_process` with no extractable tools → `toolSurfaceRisk` medium.
- [ ] Implement; green; commit `fix(schema): registerTool + python imperative/low-level extractors; sibling-checked ListTools; exclude test/example paths; shell-import risk floor`.

---

### Task P4 — Token-set tool-surface classifier (audit 16)

**Files:** `src/derive/schema.ts` `classify()`, tests.

**Defect:** unanchored substrings mis-tier in both directions — `get_execution_status`→high (`exec` in "execution"), `list_dropdown_options`→medium (`drop`), while `edit_file`/`run_notebook`/`bash_command`/`run_python`/`fork_repository`→none.

**Fix:** split the tool NAME on `_` and camelCase into tokens; classify by token-SET membership (so `execute`∈HIGH but the noun `execution` is not `exec`); use `\b`-anchored patterns for the description; weight NAME over description. Tiers:
- HIGH tokens: `exec, execute, spawn, eval, shell, bash, terminal, sh, python, run, code, interpreter, notebook, command, cmd` (and `child_process`/`subprocess` in text).
- MEDIUM tokens: `write, delete, remove, unlink, rm, drop, edit, create, update, modify, put, patch, append, upload, move, rename, overwrite, push, merge`.
- LOW tokens: `fetch, http, request, url, download, get, read, list, search, query`.
- else none. Overall = max across tools.

- [ ] RED tests: all 14 verified cases — `get_execution_status`→none/low (not high), `list_dropdown_options`→low (not medium), `edit_file`→medium, `run_notebook`/`bash_command`/`run_python`→high, `fork_repository`→medium, `search_files`→low (not high), a benign `add_numbers`→none.
- [ ] Implement token-set classifier; green; commit `fix(security): token-set tool-surface classifier (fixes exec/drop substring mis-tiers)`.

---

### Task P5 — Real staleness stat + true median (audit 22, 17)

**Files:** `index/scan.ts` (thread `daysSinceLastCommit` into `IndexEntry`/`toEntry`, compute `staleOver180 = entries with days>180`), `src/collectors/github.ts` (even-length median avg), `tests/scan.test.ts`, `tests/github.test.ts`.

- [ ] RED: `summarize` counts stale from a `daysSinceLastCommit>180` field (add it to the test entries); median of `[1,5]`→3 average not 5 (the existing token-path github test asserts upper-middle — UPDATE it to the true average `(1+5)/2=3` and note the intended change).
- [ ] Implement; green; commit `fix(index,health): real >180d staleness stat; true even-length median`.

---

### Task P6 — Bus-factor pagination over the true 365-day window (audit 14, folds 3)

**Files:** `src/collectors/github.ts` commits fetch, `src/util/http.ts` (headers helper), `tests/github.test.ts`, `tests/http.test.ts`.

**Fix:** paginate the `commits?since=365d&per_page=100` fetch (follow `Link: rel="next"` until commits pass the cutoff or a page cap, e.g. 10 pages), then apply the ≥3-commit bus-factor threshold and `commitsLast90Days` over the full window. Reject `/contributors` (all-time, wrong window) and `/stats/contributors` (202 async). Page cap prevents runaway on huge repos.

- [ ] RED: extend the `Http` interface/fake to expose response headers (add `jsonWithHeaders<T>(url): Promise<{data:T; headers:Headers}>` to `http.ts`, same retry path); a fake returning two commit pages via a `Link: <...page=2>; rel="next"` header → busFactor counts authors across BOTH pages (author with 2 on page1 + 1 on page2 = 3 → counts).
- [ ] Implement pagination + the headers helper (minimal, tested). Green; commit `fix(health): paginate 365d commits for accurate bus factor + activity`.

---

### Task P7 — Dependency CVEs at resolved versions (audit 15)

**Files:** `src/derive/lockfile.ts` (new), `src/collectors/osv.ts`, `src/assemble.ts`, tests.

**Defect:** dep ranges stripped to floor and queried at floor → over-reports CVEs already fixed in-range and misses transitive; committed lockfiles never parsed. `exa-mcp`: 32 findings at floors vs 18 at resolved (grade-flip).

**Fix (scoped to the common ecosystems):** add `src/derive/lockfile.ts` `parseLockfile(files: RepoFile[]): Dep[]` covering `package-lock.json` (v2/v3 `packages` map → name+exact version, incl. transitive), `uv.lock` and `poetry.lock` (Python). In `assemble`, if a supported lockfile is in the fetched tree, use its resolved deps for OSV; else fall back to `depsFromManifest` floors (labelled approximate).

- [ ] RED tests: `parseLockfile` on a `package-lock.json` v3 fixture yields exact versions incl. a transitive dep; assemble prefers lockfile deps when present.
- [ ] Implement; green; commit `fix(security): query OSV at resolved lockfile versions, not manifest floors`.

---

## Deferred (documented, not built now)
- **Cost token-footprint rework (audit 16/18):** requires a brace-matching `inputSchema` capture + band recalibration + a SEPARATE rich token source so it doesn't inflate security classify() inputs. Gated behind stable extraction (P3). Track as v1.3. Note in methodology that cost is an under-estimate today.

## After P1–P7
- Re-scan 400 servers; compare grade distribution, count of security==100-low-confidence (target: →0 via the gate), schema-extraction success rate (target: large increase), and spot-check flagship + dangerous servers (k8s/shell servers must no longer be confident A+).
- Update `docs/methodology.md` signal list + limitations to reflect v1.2.0.

## Self-review
- Coverage: all 23 verified defects map to P1–P7 or the documented defer (16/18, and 3 folds into P6). Convergences respected (9=21=23→P1; 12+19→P3; 4+6→P2/P3; 14 folds 3→P6).
- No placeholders; each task has RED tests + exact fix.
- Rubric version bumped once (P1); grade-affecting changes (gate, spec-era, classifier, CVE) justify 1.1.0→1.2.0.
