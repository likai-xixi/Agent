# Release Checklist - 2026-03-16

## Build and Governance

- [x] `node scripts/verify-governance.js` passed.
- [x] `npm test` passed (`125/125`).
- [x] `npm run drill:readiness` passed (`overall_passed=true`).
- [x] `npm run drill:continuity` passed (`overall_passed=true`).
- [x] `npm run test:load` passed (`successRate=1`, `p95LatencyMs<150`).

## Reliability and Rollback

- [x] Fault-injection rerun passed (`tests/fault-injection.test.js`).
- [x] Latest rollback dry-run passed:
  - `node scripts/rollback-from-checkpoint.js --checkpoint docs/devlog/checkpoints/CKPT-20260316-031.json`
- [x] Runtime DB migration commands verified:
  - `npm run db:migrate:up`
  - `npm run db:migrate:down`

## Operational Artifacts

- [x] Latest readiness report updated:
  - `docs/handoff/READINESS-LAST.json`
- [x] Latest continuity report updated:
  - `docs/handoff/DRILL-LAST.json`
- [x] Latest audit maintenance report updated:
  - `docs/handoff/AUDIT-MAINTENANCE-LAST.json`
- [x] Latest retention report updated:
  - `docs/handoff/RETENTION-LAST.json`

## Release Decision

- [x] Go-live decision documented in:
  - `docs/handoff/GO-LIVE-DECISION-20260316.md`
