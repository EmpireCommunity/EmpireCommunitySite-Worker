# Changelog

## Unreleased

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
