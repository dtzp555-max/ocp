# Changelog

## v3.11.1 — 2026-04-21

### Fixes
- Concurrency slot leak on subprocess timeout (#37). The request-timeout handler called `proc.kill("SIGTERM")` without decrementing `stats.activeRequests`. A subprocess stuck in a syscall that ignored SIGTERM would hold its slot until (or beyond) the 5s SIGKILL escalation actually reaped it. Slot release is now wired to `proc.once("exit", cleanup)` so every termination path — normal close, error, SIGTERM, SIGKILL — releases the slot exactly once.

## v3.11.0 — 2026-04-20

### Features
- `ocp update` now automatically syncs OpenClaw's registry with the latest models (scripts/sync-openclaw.mjs)
- Server logs warn if OpenClaw registry drifts from models.json

### Refactor
- models.json is now the single source of truth for model list
- server.mjs and setup.mjs derive MODEL_MAP/MODELS from models.json
- Adding a new model is now a one-file edit

### Fixes
- OpenClaw's model dropdown now shows all 4 current models (opus-4-7, opus-4-6, sonnet-4-6, haiku-4.5) on existing installs after `ocp update`. Previously setup.mjs only wrote the registry at install time.
