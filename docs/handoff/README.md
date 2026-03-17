# Handoff Convention

`docs/handoff/CURRENT.md` is the single source of truth for takeover.

It must always include:

- Current status
- Current `STEP_ID`
- Blockers
- Next top 3 actions
- Acceptance criteria

Operational report files tracked in this folder:

- `READINESS-LAST.json`
- `DRILL-LAST.json`
- `RETENTION-LAST.json`
- `AUDIT-MAINTENANCE-LAST.json`
- `OPS-ALERTS-LAST.jsonl`
- `ROADMAP-STEP-019-032.md`

Whenever code/config changes happen, update this file in the same commit.
