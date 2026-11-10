# Changelog

## Unreleased

- Implement the Discord member-count Worker with validated KV/cache reads, origin fallback, bounded upstream requests,
  retry and band rules, and twice-daily Cron persistence without logs.
- Add contract/pure-rule tests, strict TypeScript, lint, configuration/workflow checks and read-only CI.
- Add D-55 Workers Builds configuration, CODEOWNERS, grouped Dependabot updates and the operator/security documentation.
- Leave the KV namespace ID as an explicit all-zero deployment blocker pending owner setup.
