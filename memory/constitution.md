# OCP Constitution
<!-- Created by spec-kit integration (github/spec-kit v0.7.3) -->
<!--
NOTE TO CLAUDE SESSIONS: This file is the spec-kit constitution for the OCP repo.
It coexists with — and is subordinate to — the project-specific constraints in
~/ocp/AGENTS.md. Always read AGENTS.md first for memory policies, protected files,
and development discipline rules. This constitution covers spec-driven development
principles for new features.
-->

## Core Principles

### I. Spec-First Development
All non-trivial features begin with a specification in `specs/` before any code is written.
Use `/speckit-specify` to create the spec, `/speckit-plan` for the implementation plan,
`/speckit-tasks` to generate the task list, then `/speckit-implement` to execute.

### II. Server Integrity (NON-NEGOTIABLE)
`server.mjs`, `models.json`, `package.json`, and `keys.mjs` are protected files.
No spec-driven workflow may modify them without explicit approval from the project
maintainer. If a spec calls for changes to these files, halt and escalate.

### III. Test-First
Implementation tasks include tests before code. The `/speckit-implement` command
must follow TDD for any logic touching the proxy or model-routing paths.

### IV. Additive by Default
Features should be additive — new endpoints, new model entries, new config flags —
not modifications to existing contracts unless the spec explicitly justifies the
breaking change and the plan documents a migration path.

### V. Cross-Device Compatibility
OCP runs on multiple machines. Specs and plans committed to `specs/` serve as the
cross-device handoff artifact. Keep `specs/NNN/tasks.md` updated as the canonical
work-state file.

## Constraints

- Follow CC 开发铁律 v1.3 (Iron Rules) as loaded via `/cc-rules` in CLAUDE.md.
- One PR per reviewable unit (Iron Rule 11 IDR).
- Independent review required before merge (Iron Rule 10).
- Pre-brainstorm prior-art search required (Iron Rule 12).

## Governance

This constitution is subordinate to `AGENTS.md` for project-specific memory policy
and to CC 开发铁律 for development discipline. Amendments require a PR reviewed by
the project maintainer.

**Version**: 1.0.0 | **Ratified**: 2026-04-21 | **Last Amended**: 2026-04-21
