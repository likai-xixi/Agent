# Rollback Runbook

This runbook standardizes rollback by checkpoint.

## Inputs

- `CKPT_ID`
- Impacted task IDs
- Incident summary and severity

## Steps

1. Freeze risky write paths and announce rollback window.
2. Find checkpoint file:
   - `docs/devlog/checkpoints/CKPT-YYYYMMDD-NNN.json`
3. Roll back code:
   - Preferred: `git revert --no-edit <checkpoint_commit>`
   - If approved emergency path is required, use a dedicated hotfix branch and open audit trail.
4. Roll back database:
   - Run `db_down_migration` command from checkpoint.
   - If migration is irreversible, restore from approved snapshot and record RTO/RPO impact.
   - If SQLite runtime DB is enabled, verify `config/runtime_db.json` and DB schema compatibility after down migration.
5. Roll back config:
   - Run `config_rollback` command from checkpoint.
6. Run health checks:
   - Execute each command under `health_checks`.
7. Confirm recovery:
   - Error rate, latency, queue depth, and task completion metrics return to threshold.
8. Record rollback audit events:
   - `ROLLBACK_EXECUTED`
   - `CHECKPOINT_CREATED` (if a new stabilization checkpoint is made)
   - `HANDOFF_UPDATED`
9. Update handoff:
   - `docs/handoff/CURRENT.md` must include incident summary and next top 3 actions.

## Rollback Validation Checklist

1. Task state consistency is preserved.
2. No sensitive key material appears in logs.
3. API and scheduler health probes are green.
4. Manual takeover path remains available.
5. `GET /audit/integrity` returns `200` and `integrity.valid=true`.
6. Latest archived audit batch (if present) passes hash verification.
7. Archive retention check passes (`npm run audit:retention`).
8. Audit maintenance cycle passes (`npm run audit:maintenance`).
9. Escalation suppression state is sane (`data/alert-suppression-window.json` not corrupted).
10. Webhook integration can be safely disabled by clearing webhook env vars (falls back to in-memory notifier).
11. Secret vault file and audit log are intact (`data/secret-vault.json`, `data/secret-vault-audit.jsonl`).
12. Structured runtime DB health is sane when enabled (`data/runtime-state.db` readable, expected tables exist).

## Drill Command

Run periodic dry-run validation for the latest checkpoints and handoff snapshot:

```powershell
npm run drill:continuity
```

Drill output is written to:

- `docs/handoff/DRILL-LAST.json`

For pre-release readiness and staged rollout gates, use:

- `docs/runbooks/deployment.md`
