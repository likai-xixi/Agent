# Go-Live Decision - 2026-03-16

## Decision

- Decision: `GO (staged rollout)`
- Approved by: `codex`
- Decision Time: `2026-03-16T23:45:35Z`

## Evidence

1. Governance gate passed on current change set.
2. Full test suite passed (`125/125`).
3. Readiness drill passed with healthy smoke checks and load thresholds.
4. Continuity drill passed, including rollback dry-run for latest stable checkpoint.
5. Runtime persistence migration/rollback commands are available and test-covered.

## Rollout Plan

1. Deploy checkpoint `checkpoint/CKPT-20260316-032` to staging.
2. Run staging probes from `docs/runbooks/deployment.md`.
3. Start production canary at 10%, then 50%, then 100% if no rollback triggers.

## Rollback Trigger Reminder

- Execute immediate rollback to latest stable checkpoint if:
  - integrity check fails,
  - success rate drops below threshold,
  - p95 latency breach persists,
  - takeover queue grows unbounded,
  - security leakage signal appears.
