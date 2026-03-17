# Deployment Runbook

This runbook defines deployment gates for staging and production rollout.

## 1. Pre-Deploy Gates

Run the readiness drill:

```powershell
npm run drill:readiness
```

Required pass conditions:

1. Governance check passed.
2. Test suite passed.
3. Continuity drill passed.
4. Load test metrics meet thresholds:
   - `successRate >= 0.99`
   - `p95LatencyMs <= 150`
5. High-risk feature flags remain disabled by default.
6. API smoke checks pass:
   - `GET /health` returns `200` with `status=ok`.
   - `GET /audit/integrity` returns `200` with `integrity.valid=true`.
7. If API auth is enabled (`config/api_auth.json`), unauthorized requests return `401` and authorized token/JWT requests succeed.
8. If RBAC is enabled (`config/rbac_policy.json`), role matrix checks pass:
   - `read_only_auditor` can read audit/ops history endpoints.
   - sensitive write operations require `task_admin` or `super_admin`.
9. Secret vault policy is healthy:
   - `SECRET_VAULT_MASTER_KEY` is available in runtime environment.
   - secret listings are masked (`npm run secret:vault -- list`).
   - rotation dry-run command is executable (`npm run secret:rotate -- --new-key <new-key>`).
10. Local runtime adapter health is understood before rollout:
   - if local runtime is configured, `/health` shows `providers.local.mode` as `configured` or `live`.
   - `providers.local.capacity_signals` includes `max_concurrency` and `queue_depth`.
   - when live probing is enabled, model list discovery from runtime endpoint is non-empty.
11. If structured runtime DB is enabled (`config/runtime_db.json`):
   - migration up command is executable (`npm run db:migrate:up`).
   - task creation + restart smoke retains task state (`GET /tasks/{id}` after restart).
   - rollback migration command is prepared (`npm run db:migrate:down` only in controlled rollback window).

## 2. Staging Rollout

1. Deploy current checkpoint tag to staging.
2. Run baseline probes:
   - `GET /health`
   - `GET /admin` (UI shell loads)
   - `GET /tasks?limit=20` (UI data feed healthy)
   - `GET /settings/feature-flags` and `GET /settings/provider-profiles`
   - `GET /audit/integrity`
   - `POST /tasks` + normal execution flow
   - takeover path (`WAITING_HUMAN` and manual action)
   - webhook smoke (DingTalk/WeCom):
     - configure `TAKEOVER_WEBHOOK_URL` and `OPS_WARNING_WEBHOOK_URL` in staging
     - trigger one takeover + one ops alert and verify delivery/HTTP 2xx
3. Observe for at least 30 minutes:
   - error rate
   - p95 latency
   - provider fallback rate
   - takeover backlog

## 3. Production Rollout

1. Start with canary traffic (10%).
2. Hold for 15 minutes and observe same probe set.
3. Increase to 50%, hold for 15 minutes.
4. Move to 100% only if no rollback trigger is met.

## 4. Rollback Triggers

Execute immediate rollback to last stable checkpoint if any condition is met:

1. `GET /audit/integrity` fails or returns `integrity.valid=false`.
2. Sustained `successRate < 0.99` in live request windows.
3. p95 latency exceeds SLO for 10+ minutes.
4. Unbounded growth in pending takeover queue.
5. Security signal indicating secret leakage in logs/audit payloads.

Rollback execution uses:

```powershell
node scripts/rollback-from-checkpoint.js --checkpoint docs/devlog/checkpoints/CKPT-YYYYMMDD-NNN.json --execute
```

## 5. Post-Deploy Handoff

1. Update `docs/handoff/CURRENT.md` with rollout result and next top 3.
2. Persist latest readiness report:
   - `docs/handoff/READINESS-LAST.json`
3. Archive latest audit events:
   - `npm run audit:archive`
   - verify archive manifest and hash check result.
4. Verify archive retention policy:
   - `npm run audit:retention`
   - ensure `success=true` in `docs/handoff/RETENTION-LAST.json`.
5. Run scheduled maintenance cycle and alert hook smoke:
   - `npm run audit:maintenance`
   - verify `docs/handoff/AUDIT-MAINTENANCE-LAST.json` has `success=true`.
   - verify `docs/handoff/OPS-ALERTS-LAST.jsonl` only contains expected alert records.
   - verify webhook signature header is sent (`x-webhook-signature` or configured override).
   - verify escalation profile behavior:
     - warning alerts route to `ops-warning` profile channel.
     - critical alerts route to `ops-critical` profile channel.
     - duplicate alerts are suppressed within `dedupe_window_seconds`.
   - verify maintenance API query path:
     - `GET /ops/audit-maintenance/latest`
     - `GET /ops/audit-maintenance/runs`
     - `GET /ops/audit-maintenance/failures`
6. If rollback occurred, record incident summary and new stabilization checkpoint.
