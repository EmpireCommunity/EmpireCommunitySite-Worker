# EmpireCommunitySite-Worker

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge)](LICENSE)

Cloudflare Worker publishing the EmpireCommunity member count at
`https://empirecommunity.org/data/members.json` for the
[site](https://github.com/EmpireCommunity/EmpireCommunitySite).
The [normative contract](https://github.com/EmpireCommunity/EmpireCommunitySite/blob/main/docs/contracts/members-json.md)
and [security model](docs/security.md) describe the behavior and operator prerequisites.

## Development

Use Node 24 and pnpm 12.15.0 (`corepack enable`). All packages are development tools; runtime dependencies are empty. Package resolution requires a three-day
minimum release age with no exceptions, and install scripts run only for esbuild and workerd.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm check:config
pnpm check:workflows
pnpm test:coverage
pnpm build
```

`build` bundles a local dry run only. Tests use mocked upstream/KV/cache, injected time and fake timers.
`src/rules.ts` owns parsing and decisions, `src/upstream.ts` owns the bounded invite request and retries, and
`src/handlers.ts` implements the read and scheduled handlers; `src/index.ts` exports their Worker entrypoint.
Only Cron writes KV; visitor requests never call Discord.
Cron failures preserve the last good value. Requests pass to the origin file when no valid value exists or a cache/KV
operation fails, including `cache.put` even when KV has a valid record. No request logs are emitted.

## Configuration and deployment (D-55)

`wrangler.jsonc` is the reviewed public source for invite code and guild ID, initially copied from the site's
`src/data/site.yaml`. Keep both repositories in sync during invite rotation according to contract section 2.6.
The guild ID stays a string. No secrets or deploy-time variable overrides belong in this repository.

`empirecommunitysite-worker` is the Worker/package name and must match the Workers Builds dashboard name (D-61).
The KV namespace title remains `empirecommunity-members`; its public ID is configured in `wrangler.jsonc`.
`check:config` permanently rejects an all-zero namespace ID and requires 32 hexadecimal characters.
The exact fail-open route and edge protections are configured
manually; Wrangler never manages routes. Workers.dev and preview URLs remain off, with observability disabled.

Cloudflare Workers Builds deploys merges to main; GitHub Actions only verifies changes. Before connecting Builds,
require the four checks: `Quality (lint, typecheck, tests)`, `Config check`, `Workflow lint`,
`Secret scan`. Owner review is a procedural gate (D-57): GitHub requires zero approvals and code-owner review is off
for the single-account setup. Keep non-production branch builds disabled. In Workers Builds, the build command is install-only: `pnpm install --frozen-lockfile`.
The deploy command is `pnpm exec wrangler deploy --config wrangler.jsonc` (the locked version). GitHub Actions runs tests, lint and typechecking
outside the build credential environment. These checks and coverage (`pnpm test:coverage`) can run locally; CI does not run coverage. Confirm on the first build that Cloudflare uses the
pinned pnpm and honours the esbuild/workerd lifecycle allowlist; report a mismatch before proceeding. Every merge requires the owner's explicit OK. Nobody should merge or deploy
this bootstrap change until the operator prerequisites have been completed and approved.

No live deployment or Cloudflare dashboard setting is verified by local tests. After deployment, confirm the sole
route, edge rate limit/query refusal, logs off, origin fallback, production cache and a manually seeded Cron run.
See the site contract and Ops Runbook for the full acceptance procedure.

## License

Code is under the [GPL v3](LICENSE) (GPL-3.0-only). The EmpireCommunity name and logo are not covered: all rights reserved.
