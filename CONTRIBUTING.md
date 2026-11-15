# Contributing to Trovark

## Development setup

```bash
npm ci
npm run build   # tsc
npm test        # vitest run
npm run dev     # run the CLI from source: tsx src/cli.ts
```

Node >= 20 required.

## Workflow

Outside contributions land through pull requests:

1. Branch from `main` (`feat/...`, `fix/...`, `chore/...`).
2. Keep commits scoped; use conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `data:`).
3. Open a PR against `main`. CI runs the build and tests on every pull request and every push to `main`.

## Repository layout

- `index/` builds the public index: `discover.ts` writes `servers.json` from `seed.txt` and linked lists, `scan.ts` grades those servers into `results.json` and records tool-surface snapshots (`surfaces/`, `drift.json`), and `site.ts` renders `docs/index.html`. `audit.ts` (`npm run audit`) is the metadata-integrity measurement.
- `smoke/` is a short list of servers for manual calibration runs (`npx tsx smoke/run.ts`, with `GITHUB_TOKEN` set).

## Reporting issues

Bug reports with a reproducible command (`npx trovark <server>`) and the observed vs expected grade/output are the most actionable.
