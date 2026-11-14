# Changelog

## Unreleased

- Backlog B-WK1b and B-WK1c: `checkFreshness` answers `stale` for a run time that is not finite; tests cover the Cron
  entrypoint through the real wiring and the 100 and 599 status edges; coverage runs with every test run and has a floor.

- Read the member count from the site's relay on the VPS instead of `discord.com` (B-WK1, D-82, site ADR-0005): the
  upstream is the constant `https://empirecommunity.org/data/members-source.json`; a pure `checkFreshness` with the
  run time injected rejects a malformed `fetchedAt` (`invalid_response`) and one older than 24 hours or more than
  5 minutes ahead (`upstream_unavailable`, same retries); a `404` from the relay is `upstream_unavailable` with the same
  retries (X1), so `invite_not_found` is no longer produced (an older record still parses). Every Cron run writes
  `members:status:v1` (`at`, `outcome`, `lastError` or `store_failed`, `httpStatus` of the last attempt) after the
  record write; a failed KV read still writes neither key, and the request handler never reads it. `wrangler.jsonc`
  is unchanged.

- Relicense the project code from MIT to GPL-3.0-only (GPL v3), using the unchanged official GNU license text (T-58, D-75).

- Select the reviewed Wrangler configuration explicitly for local builds and deployment.

- Isolate the Worker entrypoint from internal handler exports and harden the configuration check.

- Harden the configuration check, use manual upstream redirect handling and preserve HTTP outcomes on cleanup failure.
- Add the npm Dependabot cooldown and clarify the procedural owner-review gate (D-57).

- Implement the Discord member-count Worker with validated KV/cache reads, origin fallback, bounded upstream requests,
  retry and band rules, and twice-daily Cron persistence without logs.
- Add contract/pure-rule tests, strict TypeScript, lint, configuration/workflow checks and read-only CI.
- Add D-55 Workers Builds configuration, CODEOWNERS, grouped Dependabot updates and the operator/security documentation.
- Address PR #1 review: clarify cache-error origin fallback and local-only coverage; preserve invalid-response classification
  when oversized-body cancellation rejects, with regression coverage.
- Rename the Worker/package to empirecommunitysite-worker (D-61), configure the owner-provided public KV namespace ID,
  and permanently reject all-zero IDs in the config check with tests.
