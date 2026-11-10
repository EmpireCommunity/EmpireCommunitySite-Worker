# EmpireCommunitySite-Worker

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
`src/index.ts` implements the read and scheduled handlers. Only Cron writes KV; visitor requests never call Discord.
Failure preserves the last good value or passes to the origin file when no value exists. No request logs are emitted.

## Configuration and deployment (D-55)

`wrangler.jsonc` is the reviewed public source for invite code and guild ID, initially copied from the site's
`src/data/site.yaml`. Keep both repositories in sync during invite rotation according to contract section 2.6.
The guild ID stays a string. No secrets or deploy-time variable overrides belong in this repository.

The **all-zero MEMBERS_KV namespace ID deliberately blocks deployment**. After the owner creates the namespace,
replace it with the actual public ID in a reviewed PR. The exact fail-open route and edge protections are configured
manually; Wrangler never manages routes. Workers.dev and preview URLs remain off, with observability disabled.

Cloudflare Workers Builds deploys merges to main; GitHub Actions only verifies changes. Before connecting Builds,
require owner review and the four checks: `Quality (lint, typecheck, tests)`, `Config check`, `Workflow lint`,
`Secret scan`. Keep non-production branch builds disabled. In Workers Builds, the build command is install-only: `pnpm install --frozen-lockfile`.
The deploy command is `pnpm exec wrangler deploy` (the locked version). Tests, lint, typing and coverage run only
in GitHub Actions, outside the build credential environment. Confirm on the first build that Cloudflare uses the
pinned pnpm and honours the esbuild/workerd lifecycle allowlist; report a mismatch before proceeding. Every merge requires the owner's explicit OK. Nobody should merge or deploy
this bootstrap change until the namespace and operator prerequisites have been completed and approved.

No live deployment or Cloudflare dashboard setting is verified by local tests. After deployment, confirm the sole
route, edge rate limit/query refusal, logs off, origin fallback, production cache and a manually seeded Cron run.
See the site contract and Ops Runbook for the full acceptance procedure.

## License

Code is under the [MIT License](LICENSE). The EmpireCommunity name and logo are not covered: all rights reserved.
