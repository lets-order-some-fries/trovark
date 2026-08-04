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

All changes land through pull requests — including from the maintainer:

1. Branch from `main` (`feat/...`, `fix/...`, `chore/...`).
2. Keep commits scoped; use conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `data:`).
3. Open a PR against `main`; CI must be green (build + tests) before merge.

## Reporting issues

Bug reports with a reproducible command (`npx trovark <server>`) and the observed vs expected grade/output are the most actionable.
