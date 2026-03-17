# Devlog Convention

Each atomic development change must create one `StepRecord` file:

- Path: `docs/devlog/STEP-YYYYMMDD-NNN.md`
- ID format: `STEP-YYYYMMDD-NNN`
- One file maps to one rollback checkpoint file.

## Required Sections

- `## Objective`
- `## Change Scope`
- `## Commands Run`
- `## Test Results`
- `## Risks`
- `## Rollback`
- `## Next Step`

## Checkpoint Mapping

Each step file must map to:

- `docs/devlog/checkpoints/CKPT-YYYYMMDD-NNN.json`

Checkpoint includes:

- Git commit/tag for rollback target
- DB down migration command (or explicit N/A + snapshot plan)
- Config rollback command
- Health verification commands

