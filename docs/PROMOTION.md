# OCP Promotion Strategy — "Stable & Visible"

> **This document is a recommendation for the maintainer to review and adjust, not a committed plan.**
> It reflects the project's current posture (post-v3.21.0) and should be revisited whenever
> the Anthropic billing / ToS environment changes significantly.

---

## 1. Goal: Polish + Low-Key OSS Visibility

The goal is **stability and quiet discoverability**, not growth-hacking. OCP is a personal power tool
that has been open-sourced because others can benefit from it. The right audience finds it via GitHub
search, issue threads in related projects, and word of mouth — not viral posts.

**Explicitly avoid:**

- HN / Reddit front-page pushes, influencer outreach, or any campaign that would attract a large
  influx of users before the ToS/billing situation has settled. Anthropic is actively tightening
  billing and enforcement on subscription-sharing (the June-15 Agent-SDK billing split is
  *paused*, not cancelled — and consumer-ToS enforcement on multi-person sharing is a live risk).
  A high-traffic spotlight right now would draw scrutiny that a low-profile project avoids.
- Promising features that require bypassing the `claude` CLI (raw API calls, OAuth extraction, etc.)
  — that would violate `ALIGNMENT.md` and the ToS simultaneously.

---

## 2. Pre-Requisite: Stability First

Do not promote until the house is in order:

- [x] The concurrency / latency perf fixes are shipped (v3.20.x–v3.21.0).
- [x] Docs honesty is complete (client-tools boundary, ToS sharing disclosure, this doc).
- [ ] The June-15 Agent-SDK billing split is either confirmed cancelled or OCP has a confirmed
      stable path (TUI toggle as insurance — see §5 below).

Promoting a project that has known rough edges in docs or stability only generates support burden
and negative first impressions.

---

## 3. Honest ToS Disclosure on Sharing

Any promotion materials must carry the same disclosure as `README.md § "Deployment model & security"`:

> Pooling a single Claude subscription across **multiple distinct people** may violate Anthropic's
> Consumer Terms of Service and risk account suspension. The defensible framing is "one person,
> your own devices". Friends/team sharing is not.

This framing should appear in any README badge, linked blog post, or issue comment that mentions
LAN sharing. It is not a disclaimer that discourages usage — it is honest positioning that protects
both the project and its users.

---

## 4. What to Explicitly Skip

These items are **not gaps in OCP** — they are deliberate stance decisions:

- **Multi-backend routing** (routing to OpenAI, Gemini, Llama, etc.) — that is the sibling [OLP
  project](https://github.com/dtzp555-max/olp)'s role. OCP stays Claude-only by design.
- **Gateway model-discovery** (auto-detecting which models a remote server offers) — not needed
  for OCP's single-provider, single-subscription model. `models.json` is the SPOT.
- **Raw Anthropic API passthrough** (bypassing the `claude` CLI) — out of scope per `ALIGNMENT.md`.

Do not add these to OCP roadmaps or respond to feature requests for them with "planned" — the
correct answer is "that's OLP territory" or "out of scope per ALIGNMENT.md".

---

## 5. TUI Toggle as Insurance

The `CLAUDE_TUI_MODE` opt-in is the primary mitigation if the June-15 billing split reactivates
and makes the default `-p` path draw from the metered Agent SDK credit pool.

Keep the TUI toggle:
- Functional and tested across the three deployment hosts.
- Documented in the README, including the security constraints (single-user only).
- Easily discoverable for users who get unexpectedly metered.

If the split reactivates, the recommended operator path is: set `CLAUDE_TUI_MODE=true` +
`CLAUDE_CODE_OAUTH_TOKEN` → credential-isolated scratch home → subscription pool. That path is
already shipped and documented.

---

## 6. Low-Key Visibility Actions (when §2 pre-requisites are met)

- Keep the GitHub README polished and honest — it is the primary landing page.
- Respond promptly to issues and PRs — the project's reputation is built on reliability, not
  marketing.
- Add OCP to the `awesome-claude` / `awesome-llm-tools` lists if they exist and allow self-PRs
  — low-effort, targeted, reaches the right audience.
- When related projects (Cline, OpenCode, OpenClaw, Continue.dev) post about local Claude proxies,
  a short factual comment linking to OCP is appropriate — not spam.
- Maintain the `CHANGELOG.md` with clear, honest summaries — users who are already running OCP
  are the best vector for word-of-mouth.

---

*Last updated: v3.21.0 cleanup cycle. Maintainer should re-read before any external promotion.*
