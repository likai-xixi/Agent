# Roadmap: STEP-019 to STEP-032

This document is the handoff source for all planned next steps after `STEP-20260316-018`.

## How To Use

1. Start from the first `pending` step.
2. For each step, create/update:
   - `docs/devlog/STEP-YYYYMMDD-NNN.md`
   - `docs/devlog/checkpoints/CKPT-YYYYMMDD-NNN.json`
   - `docs/handoff/CURRENT.md`
3. Implement, test, and commit one atomic step at a time.
4. Tag each step checkpoint as: `checkpoint/CKPT-YYYYMMDD-NNN`.

## Global Rules

1. Every step must be recorded, rollbackable, and handoff-ready.
2. High-risk changes must ship behind feature flags and default to OFF.
3. Every step must pass:
   - `node scripts/verify-governance.js`
   - `npm test`
   - `npm run drill:readiness`
   - `npm run drill:continuity`
   - `npm run test:load`

## Step Catalog

### STEP-019

- Goal: Expose audit maintenance history and query API.
- Scope:
  - Add persistent run history storage for maintenance cycles.
  - Add API endpoints for latest run, run list, and failure summary.
- Main Deliverables:
  - `src/monitoring/*` history store
  - `src/api/taskApiServer.js` new `/ops/audit-maintenance/*` endpoints
  - tests and docs updates
- Acceptance:
  - Latest and historical run reports are queryable.
  - Failure reasons can be aggregated by reason code.

### STEP-020

- Goal: Add alert escalation policy profiles.
- Scope:
  - Warning/Critical channel profiles.
  - Alert dedupe/suppression windows.
- Main Deliverables:
  - escalation policy module + config
  - notifier routing updates
  - tests and runbook updates
- Acceptance:
  - Duplicate failures in window are suppressed.
  - Critical failures route to critical channel profile.

### STEP-021

- Goal: Integrate real IM webhook adapters.
- Scope:
  - Implement DingTalk/WeCom webhook client adapters.
  - Keep in-memory notifier as fallback.
- Main Deliverables:
  - `src/takeover/imNotifier.js` real adapters
  - `src/monitoring/opsNotifier.js` real adapters
  - secure config and tests
- Acceptance:
  - Takeover and ops alerts can reach real webhook endpoints.
  - Failures are retried and audited.

### STEP-022

- Goal: Add API authentication baseline.
- Scope:
  - Token/JWT validation middleware.
  - API auth config and audit logging.
- Main Deliverables:
  - API auth middleware
  - auth config and tests
  - deployment docs updates
- Acceptance:
  - Unauthorized calls are rejected.
  - Authorized calls pass with auditable identity fields.

### STEP-023

- Goal: Implement RBAC and least-privilege controls.
- Scope:
  - Roles: super admin, task admin, read-only auditor.
  - Endpoint-level access matrix.
- Main Deliverables:
  - RBAC policy module
  - API authorization guard
  - tests for allow/deny matrix
- Acceptance:
  - Sensitive operations require correct role.
  - Audit queries are accessible by read-only auditor role.

### STEP-024

- Goal: Harden secret management.
- Scope:
  - Encrypt API keys at rest.
  - Key rotation and masking policy.
- Main Deliverables:
  - secret vault abstraction
  - key rotation command/script
  - tests and runbook updates
- Acceptance:
  - Secrets are never exposed in logs or API payloads.
  - Rotation flow is executable and audited.

### STEP-025

- Goal: Replace OpenAI stub with real provider implementation.
- Scope:
  - Real request/response integration with retries and timeout handling.
  - Health checks and provider-specific error normalization.
- Main Deliverables:
  - `src/providers/openaiAdapter.js` production path
  - tests with failure injection
- Acceptance:
  - OpenAI provider executes real requests and reports normalized errors.

### STEP-026

- Goal: Replace Gemini stub with real provider implementation.
- Scope:
  - Real execution, health check, and error normalization.
- Main Deliverables:
  - `src/providers/geminiAdapter.js` production path
  - tests and docs updates
- Acceptance:
  - Gemini provider joins fallback/routing path with real responses.

### STEP-027

- Goal: Replace Claude stub with real provider implementation.
- Scope:
  - Real execution, health check, and error normalization.
- Main Deliverables:
  - `src/providers/claudeAdapter.js` production path
  - tests and docs updates
- Acceptance:
  - Claude provider joins fallback/routing path with real responses.

### STEP-028

- Goal: Integrate local model runtime.
- Scope:
  - Real local inference client integration.
  - Runtime health checks and capacity signals.
- Main Deliverables:
  - `src/providers/localAdapter.js` production path
  - tests and deployment guidance
- Acceptance:
  - Local model path executes real inference and participates in routing.

### STEP-029

- Goal: Build Web admin UI MVP.
- Scope:
  - Task list, status cards, detail page, retry/takeover actions.
- Main Deliverables:
  - frontend app scaffold + API integration
  - responsive layout and tests
- Acceptance:
  - Operators can monitor and operate tasks from UI without CLI.

### STEP-030

- Goal: Add role/model/provider configuration UI.
- Scope:
  - Guided configuration forms and defaults.
  - Feature-flag aware controls.
- Main Deliverables:
  - UI pages for roles, models, provider keys (masked)
  - backend settings APIs (if needed)
  - tests and docs
- Acceptance:
  - Core configuration is manageable in UI with minimal manual steps.

### STEP-031

- Goal: Move core persistence to structured database.
- Scope:
  - Task, audit, takeover, alert persistence adapters.
  - Migration and rollback scripts.
- Main Deliverables:
  - DB schema and data access layer
  - migration up/down scripts
  - compatibility tests
- Acceptance:
  - Core runtime state survives restarts and supports query workloads.

### STEP-032

- Goal: Production readiness closeout.
- Scope:
  - Full regression + fault injection rerun.
  - Staged rollout rehearsal and rollback drill.
  - Final handoff pack and release checklist.
- Main Deliverables:
  - updated readiness, continuity, and ops reports
  - release checklist and go-live decision record
- Acceptance:
  - All gates pass and rollback drill succeeds with latest checkpoint set.

## Per-Step Execution Checklist

1. Create step record/checkpoint via `node scripts/record-step.js ...`.
2. Implement code/config/docs for one atomic change set.
3. Run required tests and drills.
4. Update rollback commands and health checks in checkpoint file.
5. Update `docs/handoff/CURRENT.md` with blockers and next top 3.
6. Commit and tag checkpoint.

