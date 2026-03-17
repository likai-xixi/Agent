# Backlog

## Top Priority

1. [x] Build orchestrator state machine (`PENDING` to terminal states) with durable event persistence.
2. [x] Implement provider adapter interface and initial OpenAI/Gemini/Claude/local adapters.
3. [x] Add task API endpoints (`POST /tasks`, `GET /tasks/{id}`, `POST /tasks/{id}/actions`).

## Next

1. [x] Add fallback strategy policy evaluator and retry budget manager.
2. [x] Add takeover workflow with IM interaction hooks.
3. [x] Add audit query API and replay tool.

## Future

1. [x] Add multi-agent discussion engine with configurable quorum.
2. [x] Add adaptive model routing with health and cost signals.
3. [x] Add automated provider discovery and health alarms.
4. [x] Add continuity drill automation for rollback and handoff readiness.
5. [x] Add provider fault-injection reliability suite.
6. [x] Add security and least-privilege audit hardening tests.
7. [x] Add deployment readiness drill and staging rollout runbook.
8. [x] Phase-2: persist takeover workflow records across restart.
9. [x] Phase-2: adopt immutable/WORM audit storage backend adapter.
10. [x] Enforce CI/CD release block on failed readiness report.
11. [x] Add audit archive retention policy gate and reporting.
12. [x] Add scheduled audit maintenance automation and operational alert hooks.
13. [x] Expose audit maintenance run history and failure summary query API.
14. [x] Add alert escalation policy profiles and dedupe suppression windows.
15. [x] Integrate DingTalk/WeCom webhook adapters for takeover and ops alerts.
16. [x] Add API auth baseline with token/JWT validation and identity audit fields.
17. [x] Implement RBAC least-privilege authorization matrix.
18. [x] Harden secret management with encrypted vault and rotation script.
19. [x] Integrate real OpenAI provider adapter path with normalized errors.
20. [x] Integrate real Gemini provider adapter path with normalized errors.
21. [x] Integrate real Claude provider adapter path with normalized errors.
22. [x] Integrate local model runtime path with health and capacity signals.
23. [x] Build Web admin UI MVP with task list/detail and operator actions.
24. [x] Add role/model/provider configuration UI and settings APIs.
25. [x] Move core runtime persistence to structured SQLite database adapters.
26. [x] Production readiness closeout with final regression, rollback rehearsal, and release decision pack.
27. [x] Add local closed-loop governance plane with secure runner, IM bridge, interrupted-step resume, portable data root, skills, and self-heal controls.
