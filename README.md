# Multi-Agent Orchestration Governance Baseline

This repository enforces one hard rule for development:

- Every development step must be **recorded**.
- Every development step must be **rollbackable**.
- Every development step must be **handoff-ready** for another Codex.

## Quick Start

1. Create a new development step record:
   ```powershell
   node scripts/record-step.js --title "Implement X" --objective "Deliver Y"
   ```
2. Implement code/config/docs changes.
3. Fill in generated files:
- `docs/devlog/STEP-YYYYMMDD-NNN.md`
- `docs/devlog/checkpoints/CKPT-YYYYMMDD-NNN.json`
- `docs/handoff/CURRENT.md` (auto-updated, then refine)
4. Run local governance gate:
   ```powershell
   node scripts/verify-governance.js
   ```
5. Run tests:
   ```powershell
   npm test
   ```
6. Run continuity drills (flow integrity + rollback dry-run + handoff drill):
   ```powershell
   npm run drill:continuity
   ```
7. Run deployment readiness drill:
   ```powershell
   npm run drill:readiness
   ```
8. Archive audit events to immutable-style files:
   ```powershell
   npm run audit:archive
   ```
9. Check archive retention policy and integrity:
   ```powershell
   npm run audit:retention
   ```
10. Run scheduled audit maintenance cycle (archive + retention + alert hook):
   ```powershell
   npm run audit:maintenance
   ```
11. Tune escalation policy profiles and dedupe windows:
   - `config/alert_escalation_policy.json`
12. Configure real IM webhook adapters (optional; falls back to in-memory):
   - takeover:
     - `TAKEOVER_WEBHOOK_ADAPTER` (`dingtalk` or `wecom`)
     - `TAKEOVER_WEBHOOK_URL`
     - `TAKEOVER_WEBHOOK_SECRET`
   - ops:
     - `OPS_WEBHOOK_ADAPTER` (`dingtalk` or `wecom`)
     - `OPS_WARNING_WEBHOOK_URL`
     - `OPS_CRITICAL_WEBHOOK_URL`
     - `OPS_WEBHOOK_SECRET`
13. Configure API authentication baseline (optional; default OFF):
   - `config/api_auth.json`
   - supports static bearer tokens and HS256 JWT validation
14. Configure RBAC policy baseline (optional; default OFF):
   - `config/rbac_policy.json`
   - roles: `super_admin`, `task_admin`, `read_only_auditor`
15. Manage provider secrets via encrypted vault (AES-256-GCM):
   - `SECRET_VAULT_MASTER_KEY=... npm run secret:vault -- set --name OPENAI_API_KEY --value <key>`
   - `SECRET_VAULT_MASTER_KEY=... npm run secret:vault -- list`
   - `SECRET_VAULT_MASTER_KEY=... npm run secret:rotate -- --new-key <next-key>`
16. Configure local model runtime adapter (optional; defaults to stub when runtime URL is not configured):
   - `LOCAL_MODEL_RUNTIME_URL` (example: `http://127.0.0.1:11434`)
   - `LOCAL_MODEL_TIMEOUT_MS`, `LOCAL_MODEL_MAX_RETRIES`, `LOCAL_MODEL_RETRY_BACKOFF_MS`
   - `LOCAL_MODEL_MAX_CONCURRENCY`, `LOCAL_MODEL_QUEUE_DEPTH` (capacity signals)
   - set `enableLiveHealthCheck` in adapter options when `/health` should probe runtime endpoints
17. Migrate and enable structured runtime database persistence (optional, recommended for restart durability):
   - `npm run db:migrate:up`
   - set `config/runtime_db.json` to `{ "enabled": true, "db_path": "data/runtime-state.db" }`

## Run Task API

```powershell
npm run start:api
```

API endpoints:

- `GET /tasks` (list tasks for admin UI; supports `state` and `limit` query)
- `POST /tasks`
- `GET /tasks/{id}`
- `POST /tasks/{id}/actions`
- `GET /settings/feature-flags`, `PUT /settings/feature-flags`
- `GET /settings/provider-profiles`, `PUT /settings/provider-profiles`
- `GET /settings/rbac`, `PUT /settings/rbac`
- `GET /settings/provider-secrets`, `POST /settings/provider-secrets`
- `GET /audit/events?task_id=...` or `?trace_id=...`
- `GET /audit/integrity`
- `GET /tasks/{id}/replay`
- `GET /tasks/{id}/takeover`
- `POST /tasks/{id}/takeover/actions`
- `POST /tasks/{id}/discussion`
- `GET /tasks/{id}/discussion/latest`
- `GET /takeovers/pending`
- `POST /integrations/im/events`
- `GET /routing/preview`
- `POST /ops/discovery/run`
- `GET /ops/discovery/latest`
- `GET /ops/alerts`
- `POST /ops/alerts/{alert_id}/ack`
- `GET /ops/audit-maintenance/latest`
- `GET /ops/audit-maintenance/runs`
- `GET /ops/audit-maintenance/failures`
- `GET /health`

Admin UI:

- `GET /admin` (task operations + runtime configuration center)

## Required Structure

- `docs/devlog/`: one step log per atomic change (`STEP_ID`)
- `docs/devlog/checkpoints/`: rollback checkpoint metadata (`CKPT_ID`)
- `docs/handoff/CURRENT.md`: current handoff snapshot
- `docs/handoff/DRILL-LAST.json`: latest drill result snapshot
- `docs/handoff/READINESS-LAST.json`: latest deployment readiness report
- `docs/handoff/RETENTION-LAST.json`: latest archive retention check report
- `docs/handoff/AUDIT-MAINTENANCE-LAST.json`: latest scheduled maintenance run report
- `docs/handoff/OPS-ALERTS-LAST.jsonl`: latest operational alert hook output
- `docs/runbooks/rollback.md`: rollback runbook
- `docs/runbooks/deployment.md`: deployment and rollout runbook
- `docs/backlog.md`: prioritized next work items
- `config/alert_escalation_policy.json`: warning/critical routing profile and dedupe policy
- `src/integrations/webhookClient.js`: webhook dispatch + retry/backoff + signature helper
- `config/api_auth.json`: API authentication baseline config
- `config/rbac_policy.json`: endpoint-level RBAC policy switch and defaults
- `config/secret_vault.json`: secret vault file/audit path and key env reference
- `config/runtime_db.json`: structured runtime DB toggle and DB file path
- `src/persistence/sqliteRuntimeStore.js`: SQLite persistence adapters (task/audit/takeover/alert)

## Default Risk Control

High-risk capabilities are deployable but disabled by default in:

- `config/feature_flags.json`

Flags include:

- `fallback_engine_enabled`
- `takeover_engine_enabled`
- `discussion_engine_enabled`
- `adaptive_routing_enabled`
- `openai_adapter_enabled`
- `gemini_adapter_enabled`
- `claude_adapter_enabled`
- `local_model_adapter_enabled`

## CI Gate

GitHub Actions workflow enforces:

1. `node scripts/verify-governance.js`
2. `npm test`
3. `npm run drill:readiness`
4. `npm run audit:maintenance`

If any gate fails, merge/release is blocked. Latest readiness/continuity/retention/maintenance reports are uploaded as workflow artifacts.
