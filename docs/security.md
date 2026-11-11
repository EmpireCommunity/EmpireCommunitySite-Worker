# T-14b: contract and threat model

Risk: High (external data published to visitors and deployment supply chain).
Architecture owner: Alicerce. Security model: Sentinela T-14c, all controls.
Normative behavior: [members-json v1](https://github.com/EmpireCommunity/EmpireCommunitySite/blob/main/docs/contracts/members-json.md),
sections 1, 2.2–2.5, 2.7–2.10, 7 and 8; configuration updated by D-55/T-14a.

## Behavior and boundaries

The sole public output is schema 1, with the last accepted Discord member count, last success timestamp and source.
GET and HEAD read the Cache API, then the validated KV record. Missing, corrupt or unavailable data falls through to
the site's built-in file. Other methods return 405. Cron alone writes `members:v1`, at 00:00/12:00 UTC.
No successful value yet plus a failed run leaves KV absent. An ordinary success or a failure resets the jump streak;
three consecutive jumps accept the new count. Failures preserve the count and timestamp and increment the failure counter.

## Assets, threats and controls

- Count integrity: Discord is untrusted. Code and guild strings must match the public configuration; the count must
  be an integer in 1..1,000,000. No upstream fields are copied into persisted or public objects. The band rule prevents
  a single dramatic change from replacing a value of at least 50.
- Request budget and memory: fixed HTTPS destination, redirects rejected, 8 second deadline including streamed body,
  64 KiB measured byte cap, at most three attempts (including a single 429 retry, integer Retry-After 0..10 seconds).
  Network/5xx retries wait 2 then 6 seconds. The maximum run uses three fetches and two KV operations.
- Cache poisoning: the sole cache key is the fixed public URL, GET, without visitor headers. Queries/other URLs pass
  through without touching the cache or KV; only Worker-produced 200 responses enter the cache. HEAD shares the GET
  cache entry, with no body. KV data is validated and projected onto the public three-field Discord object.
- Privacy: no logs, cookies, CORS headers, personal data, credentials or runtime packages. Cron diagnostics live only
  in KV. Cloudflare infrastructure metrics and zone processing remain outside the Worker's control.
- Supply chain: exact devDependency pins, lockfile integrity hashes, frozen install, lifecycle scripts allowed only
  for esbuild and workerd (pnpm 12 `allowBuilds`), three-day minimum release age without exceptions. Tooling exists only for build, lint, typing, tests, schema and configuration/workflow checks.
  Cloudflare build commands install only; tests/checks run in GitHub Actions without build credentials.
  Source AST checks reject npm imports, import assignments and dynamic imports/requires.
  Dependabot proposes grouped weekly PRs without auto-merge; CODEOWNERS covers every file; CI has read-only contents
  permission, SHA-pinned actions, bounded job timeouts and no deploy credentials or deploy command.

## Operator controls and accepted limits

Before connecting Workers Builds, the owner must require all four CI checks on main. Owner review is a procedural
gate (D-57): GitHub requires zero approvals and code-owner review is off for the single-account setup.
Every merge is a production deployment and requires the owner's explicit OK. Non-production branch builds stay off.
The build token must have the narrowest available permissions; install scripts execute in that build environment.
The only route is created manually, exact path and fail open; it is absent from Wrangler. Workers.dev, preview URLs
and observability are disabled. The operator must apply the mandatory `/data/` rate limit and query refusal at the
edge and origin. The Free-plan request quota remains account-wide; a malicious merge can still publish an integer.
The owner's public KV namespace ID is configured in Wrangler; the config check permanently rejects all-zero IDs.

## Validation

Vitest tables cover upstream identity/bounds, all failure outcomes, band boundaries and reset/acceptance, first-run
failure, HTTP schema/headers/methods, cache and origin fallback, bounded stream reading, timeout and retry limits,
and Cron persistence. Time and waits are injected or fake. No live Discord request or deploy is needed for these tests.
Post-deploy route, edge rules, Workers Builds settings, actual Cache API/origin behavior and logs-off verification
remain operator acceptance work and are not established by local tests.

## Documentation consulted

- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/): GET-only cache writes and matching.
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/): bindings, Cron and observability.
- [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/): Worker entrypoint.
- [Discord invite API](https://docs.discord.com/developers/resources/invite#get-invite): identity and approximate count.
