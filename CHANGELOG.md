# Changelog

## Unreleased

### Fixed

- **The five remaining probes in `ocp` that narrated a local `curl` fault as a fact about the proxy (#296, #299, #300).** Each was a bare `curl` whose `else` branch asserted a *specific cause* for every nonzero exit — "bound to localhost only" (`ocp lan`), "Proxy not responding after restart" (`cmd_restart`'s own verdict), "key may be invalid or revoked" and "proxy is reachable but chat completion did not succeed" (`cmd_connect`) — so a machine with no usable `curl` was told to change `CLAUDE_BIND`, or to regenerate a working key, or that a successful restart had failed. `cmd_restart`'s is the worst of the five: it is the check that decides whether a restart worked, and its `return 1` propagates into `_cmd_update_light`'s `restart_status` (#255) on the recovery path.
  - **Two of the five were not in any issue.** `cmd_connect`'s smoke-test pair (Step 8) was found by this change's own tests, not by reading. Three prior enumeration passes (#261, #273, #278) each believed they had the complete list; each was assembled by eye.
  - New `_curl_probe` serves the verdict-shaped sites with **three** states — succeeded / ran-and-failed / could-not-run — because for a caller that narrates its own conclusion, collapsing the last two into one nonzero *is* the defect. The payload-shaped sites keep `_curl_or_die`. The could-not-run predicate is now extracted to `_curl_is_local_fault` and shared, so the two helpers cannot drift.
  - Guarded **behaviorally**, not by grepping for `curl`: each case removes curl from `$PATH` (or exits 127 at one URL) and asserts what the command *says*, and each is paired with a control proving the genuine-remote diagnosis is still produced. A source-grep would pass the moment a bare `curl` reappeared in an unanticipated shape — which is exactly how the three prior passes missed sites.
  - `set -e` note: `_curl_probe` on its own line terminates the script on every failing case. Both call sites use `|| rc=$?`. This was a real bug in the first draft, caught by these tests.
- **`start.sh`'s Linux bind check ran a bare `ss`, the same restricted-PATH exposure #246 fixed for `lsof` on macOS (#298).** `resolveBinaryPath` was applied to the darwin branch only; the Linux branch emitted `ss -tlnp` with no absolute-path preference. `ss` lives at `/usr/sbin/ss` on Debian and Raspberry Pi OS, so a `PATH` without `/usr/sbin` loses it — and this is the branch that runs on the majority of this project's own serving hosts. Both branches now resolve, with the same fallback direction (absolute when present, bare name otherwise, so an unusual layout is never worse off than before). `classifyBindCheck` threads the new `ssPath` through; without that the resolution would exist but be unreachable from `setup.mjs`, its only caller.
  - The netstat cross-check is still deliberately **not** extended to Linux: GNU netstat's `-p` means "show PID/program name", not BSD/macOS's "protocol filter" `-p tcp`, and reusing the darwin command shape there could make the first-ever start on a fresh Linux host refuse. Path resolution carries no such risk — it is a preference with a fallback to the exact prior behavior, not a new command shape.
  - The existing linux test asserted `cmd === "ss -tlnp"` with no `existsSyncFn` injected, which would have made it **host-dependent** under this change: green on macOS (no `/usr/sbin/ss`), red on a Debian runner. Replaced with both branches driven explicitly, mirroring the darwin pair.
  - Corrected while touching it: this file's header described the non-darwin branch as "still a bare `lsof` call". It never was — the branch emits `ss`. The conclusion was right, the identifier wrong; #298's own filing had to correct the same slip in the review that prompted it.
- **`ocp update --target=vX.Y.Z` (equals form) was silently dropped by the Node CLI parser (#297).** `ocp`'s bash layer has understood both spellings since #272 and forwards the user's argv verbatim (`exec node .../upgrade.mjs "$@"`), but the Node side did `args.indexOf("--target")` — separate-token form only. So the equals form arrived as `target: undefined`: #272's refusal never fired on `fresh_install`, and on the full/cross-minor path #259's pin was silently not applied and the upgrade went to `doctor.latest_version`. That is exactly the "user believes they pinned a version and did not" failure #260 exists to prevent, reintroduced across a layer boundary.
  - Both spellings now go through one `parseFlagValue(args, flag)`, which reports `seen` separately from `value`. That split is load-bearing: `--target=` and a trailing `--target` used to collapse into "not passed" and drop a *typed* pin in silence. They are now refused, matching the guard `--post-flight-only` already carried and bash's own `_TARGET_SEEN`/`_TARGET_VAL` contract.
  - `--post-flight-only` uses the same parser. Its equals form is **not** reachable from the product (`ocp` only ever invokes it internally with separate tokens), so this is not a second instance of the defect — but two parsers for the same shape in one file is how they drift.
  - **Why #297 slipped is the part worth keeping:** #272's tests exercised the equals form at the bash layer, where its fix was, and every Node-side #272 test calls `runUpgrade({target})` directly. Nothing ever drove argv → parse → `runUpgrade`, so the boundary itself had no coverage. There is now a wiring test that spawns the real CLI, and it is discriminating for that gap alone — reverting only the entry point (leaving `parseFlagValue` correct) fails that test and nothing else.
- **`ocp-connect` under-declared four of the seven models it registers into a client's OpenClaw config (#309).** The write loop hardcoded `contextWindow: 200000` for every model; after #213/#307 declared `claude-opus-5`, `-4-8`, `-4-7` and `claude-sonnet-5` at a native 1M, that literal capped four of them at a fifth of their real window. **Not named in the issue, found while measuring:** `claude-sonnet-5`'s `maxTokens` was under-declared too — the family key `"claude-sonnet" -> 32000` was correct while `claude-sonnet-4-6` was the only sonnet, and `claude-sonnet-5` is 64000. Four of seven models were mis-declared; all seven now match `models.json` exactly.
  - **The issue's suggested fix does not work as stated.** `contextWindow` is not a family property — `claude-opus-5` (1M) and `claude-opus-4-6` (200k) share the `claude-opus` prefix — so "add a context-window column to `get_model_meta`" is only correct together with the longest-prefix-wins ordering the function already had. Specific ids are simply longer keys, so they win over their own family with no new matching logic.
  - Family rows keep `contextWindow: 200000` as the conservative floor, and the unknown-id fallback gets it too, following this file's own established rule: under-advertising caps a client lower than the model allows (safe), over-advertising promises capacity that does not exist. A window is raised only for an id verified against the SPOT.
  - **The suite was structurally blind to this.** Its model-registry test asserts `<=` — "never OVER-advertises" — and an under-advertisement passes that by definition. The new test asserts **equality** against `models.json` for both numeric columns, for every id the SPOT declares, so a model added there now fails until `ocp-connect` is updated too.
  - `contextWindow` also moved out of the write loop's pinned literal-constants snapshot and into its meta-derived assertions. It was pinned as a literal precisely *because* the classifier did not return it; leaving it there would have re-frozen the number this issue was about, in the place that made it invisible.
- **`ALIGNMENT.md`'s Hybrid note cited unrelated code, and the citation style that produced that is now changed (#292).** The note routed reviewers to `server.mjs` line 845–849 for the `anthropic-ratelimit-unified-*` extraction block; those lines are the `OCP_LOCAL_TOOLS` boot gate. This repo's entire enforcement model is line-cited evidence a reviewer is expected to open, so a citation that lands on unrelated code is a defect in the enforcement mechanism itself, not a typo. Verified stale as far back as v3.26.0. **The correction is anchored on a grep-able marker rather than a line number**, because #292's own corrected range (2349–2354) was *already stale again* by the time the fix was written — the block is at 2374–2379 today. `// ALIGNMENT:` appears exactly once in `server.mjs` and marks this block deliberately.
- **A forced `tool_choice` is now refused instead of silently answered with prose (#311, ADR 0013 — Proposed).** OCP accepts `tools`/`tool_choice` and emits no `tool_calls` at all (`grep -c 'tool_calls' server.mjs` → **0** before this change; it is 2 after, both occurrences inside the explanatory comment this change adds). Under a permissive `tool_choice` that is spec-conformant — the model *may* call a tool and text is a legal outcome — so those requests are **unchanged**. Under a forcing `tool_choice` (`"required"`, or a named function) the specification requires `finish_reason: "tool_calls"`, and answering with prose and `finish_reason: "stop"` is not a degraded answer but a **silently wrong** one: no 400, no warning field, and `"stop"` means the turn ended normally, so the client has nothing to branch on. Those now return `400` with the spec's own error shape (`code: "unsupported_parameter"`, `param: "tool_choice"`).
  - **All five spec-defined forcing forms are covered**, not just the two the first draft caught: `tool_choice: "required"`, `{type:"function"}`, `{type:"custom"}`, `{type:"allowed_tools", allowed_tools:{mode:"required"}}`, and the deprecated-but-accepted `function_call: {name}`. The three missing ones were found by cross-vendor review reading the installed OpenAI SDK types — `ChatCompletionToolChoiceOption` is a five-member union and `function_call` is a separate field entirely, so each miss left that request on the original silently-wrong path: the same defect through a different door. `error.param` names the field the client actually sent, so a legacy caller is not sent to fix `tool_choice` they never set.
  - Their permissive siblings stay permissive: `allowed_tools` with `mode: "auto"` only *narrows* the set the model may pick from, and `function_call: "auto"|"none"` permit a text answer. Refusing those would break a client that is merely constraining its tool list.
  - **The narrowness is the safety property, not a compromise.** Refusing whenever `tools` is present would have taken down every OpenClaw agent on this project's fleet the day it shipped — every OpenClaw turn carries a tool list and accepts a text answer. That case is pinned by a test and by a mutation that fails it.
  - **Why refuse rather than implement:** `claude` owns its agentic loop and executes its own tools; OpenAI's protocol is stateless and the *client* owns the loop. A CLI `tool_use` block is the CLI reporting what it is about to do itself — forwarding it as a `tool_call` would instruct the HTTP client to run `Bash`/`Read` while the CLI ran them anyway. Checked against CLI 2.1.220: no flag delegates execution back to the caller (`--allowedTools`/`--tools` select built-ins, `--mcp-config` points at servers the CLI itself calls, `--agents` defines subagents). ADR 0013 records the shape a real implementation would take and why it is its own feature.
  - Honest about what remains: a client that *offers* tools and genuinely wants them used still gets prose with no signal. This does not fix that; it removes the class where OCP's answer contradicts an explicit instruction.

### Changed

- **Adding a read-only field to a grandfathered Class B.2 endpoint no longer requires its own ADR (#288, ADR 0012 — Proposed, needs maintainer sign-off).** ADR 0006 froze the grandfathered B.2 surface and made "any change to the response shape" a new authorization request; a response gaining a field is a response-shape change, so by the text every additive field needed an ADR. Four shipped without one (`/cache/stats` `inflight`/`requesters`; `/health` `tui`, `auth.lastOutcome`/`consecutiveFailures`, `pool`), three of them riding along inside feature ADRs written for other reasons — so the rule was neither followed nor enforced. ADR 0012 supplies the authorization **once, standing**, bounded by six conditions (additive only, read-only, no new endpoint or method, same endpoint purpose, field names in the PR body and CHANGELOG, B.2 only), and retroactively records the four. What still costs an ADR — new endpoints, new methods, new subjects, changed semantics — is unchanged. The loosening is real and ADR 0012 says so explicitly, along with the revert path if the bet is wrong.
- **The request-body cap said "5MB" while counting characters (#310).** `MAX_BODY_SIZE` is compared against `body.length` — UTF-16 code units — because the accumulator is a JS string (`body += chunk`). The label rendered it as `MB`, so every reader reasoned in bytes. This is not cosmetic: it made two review rounds of #307 conclude a 3,000,000-character CJK prompt would be rejected with a 413, put that conclusion into ADR 0011 with a threshold computed against the wrong quantity, and nearly shipped operator guidance to raise a knob that did not need touching. Measured: 3,000,000 CJK characters is 9,000,000 bytes on the wire and sails past the 5,242,880-**character** cap.
  - Worse than misleading at the default: with `CLAUDE_MAX_BODY_SIZE=1000` the old label rendered **`max 0MB`**, because `Math.round(1000 / 1048576)` is `0`. Any cap below ~512 KB produced a nonsense message.
  - The comparison is **deliberately unchanged**. A byte cap of the same number is never more permissive (UTF-8 byte length ≥ UTF-16 unit length for every character class — ASCII 1:1, Latin-1 2:1, CJK 3:1, astral 4:2), so switching to bytes would reject bodies accepted today. That is a Class B.1 contract change, not a label fix. What changed is that the label and the 413 body now state the quantity they measured.
  - `README.md`'s environment-variable table and limits table said "bytes, default 5 MB" — the same misconception, propagated to the user-facing docs. Both corrected.
- **`warn_count`'s WARN-multiplicity gap is closed, and the second site is classified rather than papered over (#304).** Mutating either `warn_count` computation to `Math.min(1, …)` survived the whole suite, because every doctor shape the suite exercised had **at most one WARN**. `doctor.mjs` prints `Summary: N FAIL, M WARN` from that number, so a cap at 1 tells the operator that one of two real warnings does not exist.
  - The two sites survive for **different reasons**, and the distinction is the finding. `doctor.mjs:879` (the full run) is genuinely **uncovered** — a 2-WARN shape is reachable and nothing produced one; a new test combines #289's inconclusive-auth WARN with #220's two-enabled-units WARN on a fully mocked host and asserts `warn_count === 2`. `doctor.mjs:981` (`runOauthOnly`, the `--check oauth` path) is **unreachable by construction** — all three of its push sites push the same `oauth_ok` id on mutually exclusive branches, so its `checks` array can never hold two entries and a cap there is unobservable, not wrong.
  - The second test therefore pins the **premise**, not the cap: it drives all three branches and requires exactly one check from each. If a future change adds a second check to that path, the gap becomes real at that moment and this test says so — which is the only guard with any content there. Verified by mutation: adding a second `push()` inside `runOauthOnly` fails it by name.
- **`runPostFlightCheck`'s real probe lane laundered "could not run" into "unreachable" (#291).** A bare `catch { /* retry */ }` collapsed five distinct failures — curl missing (127), curl not executable (126), connection refused (7), HTTP error (22), timeout (28), and a non-JSON body — into one outcome, and the caller then printed `(unreachable)`: a claim about the **service**, made just as readily when the fault was that curl could not run on this machine. This is the exact conflation the #261 → #267 → #273 → #278 → #286 arc removed from sixteen bash sites, still sitting in the function those sites now **delegate their final verdict to** (`_cmd_update_light` and `_cmd_update_restart` both report whatever `--post-flight-only` says).
  - Each kind is now classified and rendered differently, and only the genuinely remote ones are narrated as remote. A local fault says so explicitly and tells the operator the upgrade may well have succeeded.
  - The `version-mismatch` branch — the one that was already correct and specific — keeps its message **byte-for-byte**, pinned by a test.
  - **The coverage note in the issue was the important half.** Every pre-existing test drove `opts.mockProbe`; the lane that ships is the `execSync` one, so a fix verified through the mock would have been verified on the lane that was never broken. `opts.execFn` makes the real lane drivable (mirroring `classifyBindCheck`'s injection convention), and all seven new tests use it — including one asserting the *success* path still works through the injected lane, so a broken injection cannot leave the group passing over a dead lane.
- **macOS restart resolution probed only the `gui` launchd domain, making a root LaunchDaemon a permanent refusal (#290).** `ocp` installs a per-user LaunchAgent, so `gui/<uid>` is the common case — but a root LaunchDaemon is a supported deployment (`scripts/doctor.mjs`'s own multi-unit-risk check looks for `/Library/LaunchDaemons`), and it is genuinely *not* registered in `gui`. The probe returned the "not-registered" sentinel, resolution reported `no-unit`, and the operator was told to bring a service under launchd that was already running. Fail-closed and loud — but on a false premise, and with no way out.
  - **The module's own comments were why nobody looked.** Two paragraphs stated there is "no multi-label ambiguity to resolve the way Linux has system-vs-user scope". That conflates two things and denies the real one: there is no multi-**label** ambiguity, but launchd has exactly the system-vs-user **domain** split those words dismissed. Corrected in place.
  - Both domains are probed now, and escalation is gated on the specific `""` signal ("gui says this label is not registered here") and **never** on `null` ("gui could not tell"). Escalating on `null` would convert an honest *unknown* — the verdict that makes resolution refuse rather than guess — into a confident claim about a domain with no evidence behind it.
  - **Scope, deliberately:** this detects and refuses *accurately*; it does not restart a root LaunchDaemon. That needs `sudo launchctl`, and running sudo from the upgrade path is a different operation with its own hazard surface. The refusal now says the service is running correctly and hands over the exact `sudo launchctl bootout system/… ` / `bootstrap system /Library/LaunchDaemons/…` pair, instead of blaming a service that is fine.
  - The escalation rule is extracted as `probeLaunchdDomains(run, expectedUnit)` — a pure function over an injected runner, matching `classifyLaunchdJob`/`classifyCmdlineOwner` — because a rule reachable only through a full `runUpgrade` is a rule nobody can pin.

- **`models.json` now declares each model's true context window, and the prompt truncation ceiling is derived per model instead of once globally (#213, ADR 0011).** The SPOT said `contextWindow: 200000` for every model, including `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7` and `claude-sonnet-5`, which the CLI registry declares at a native 1M — a 5x understatement that made OCP truncate prompts those models would have accepted. It could not be corrected as metadata because ADR 0009 derived **one** ceiling as `max(contextWindow) × 3` across all entries, so a single 1M row would have raised the ceiling from 600k to 3,000,000 chars for *every* model, including `claude-haiku-4-5-20251001`, which really is 200k — converting clean OCP-side truncation into upstream API rejections. That coupling is now gone: `promptCharBudgetFor(models, modelId)` resolves the ceiling from the model the request actually named.
  - **Per model today:** 3,000,000 chars for the four native-1M models, 600,000 for `claude-opus-4-6`, `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`. The 200k models' ceiling is **unchanged** — that is the property distinguishing this from simply raising the ceiling, and it is pinned end-to-end against a live server child by "integration (#213): the SAME oversized prompt is truncated for a 200k model and NOT for a 1M model", which also asserts the 1M model still truncates at exactly 3,000,000 rather than not at all.
  - **Windows verified id-anchored against the compiled CLI 2.1.220 binary**, each record bounded at the next `{id:"` separator. A fixed-width window after the anchor bleeds into the neighbouring record and reports `claude-opus-4-6`/`claude-sonnet-4-6` as `native_1m`, which they are not; cross-validated binary-wide (`native_1m:!0` 6x, `context:{window:1e6` 6x, same six records). The per-entry regression table now requires the registry value exactly — the previous "registry value **or** the deliberate 200000 cap" branch is removed, which makes that table discriminating for the first time (all seven rows used to resolve to 200000).
  - **`CLAUDE_MAX_PROMPT_CHARS` and `ocp settings maxPromptChars` are unchanged in kind — still absolute overrides, exactly as ADR 0009 specified — but they are now explicitly *global*:** setting either pins the ceiling to that one number for every model and suppresses the derivation. `GET /settings` still returns a plain number and, with no override set, still returns **600,000** (the fallback: smallest known window × 3), so the default-path response does not move. A Class B.2 contract change under ADR 0006, authorized by ADR 0011. There is deliberately no `PATCH` value that clears the override back to per-model derivation; restart without the env var.
  - Downstream: OpenClaw's compaction budget scales linearly off `contextWindow`, so `ocp update` will now sync a 1M window for those four models, diverging from OpenClaw's own bundled registry (which hardcodes 200000; [openclaw#22979](https://github.com/openclaw/openclaw/issues/22979) was closed not-planned). `/v1/models` is **not** affected — it emits only `{id, object, owned_by, created}` and has never carried `contextWindow`.



## v3.27.0 — 2026-08-02

Minor release. Two new tunables (`CLAUDE_AUTH_CHECK_INTERVAL_MS`, `CLAUDE_AUTH_CHECK_TIMEOUT_MS`) and two new `/health` fields (`auth.lastOutcome`, `auth.consecutiveFailures`) land — see Added — alongside the large CLI/doctor reliability batch below and one `server.mjs` correctness fix (#232) to the async auth-probe verdict.

37 PRs landed on `main` after v3.26.0 before this entry was written; only one of them (issue #232, merged as PR #275) got an `Unreleased` line at merge time, written by that PR's own author. The other 36 shipped silently — a coordination gap, not a quality gap: every one of these PRs carried an independent fresh-context reviewer (Iron Rule 10) and mutation-proven tests, and several went through two or three review rounds that caught real defects the first pass missed. This entry reconstructs them after the fact, grouped by story rather than by PR number.

Read together, most of this batch is one shape of bug, hit independently at a dozen call sites: **a check's own failure to run got treated as the answer it would have given if it had run and found nothing.** A hard-coded restart target got "restarted" whether or not it was the process actually holding the port. `cmd_restart` had no failure exit code at all. `lsof`/`curl`/`python3` simply being absent from `$PATH` looked identical, downstream, to each of them running cleanly and reporting an empty or negative result. The fix, repeated a dozen times across this batch, is always the same: distinguish "the command could not run" from "the command ran and told you something." First fixed at the request-diagnostics layer by #232 below, the same pattern turned out to also describe most of the control-plane tooling (`ocp update`, `ocp restart`, rollback, and the bash CLI's own status commands).

The other thing worth reading in its own right, because it changes exit codes on scripts people may already have automated around: **`ocp update --target` now behaves consistently everywhere it appears, and that consistency is enforced by refusing rather than by silently doing the old thing.** See Changed below before you script around it.

`server.mjs` is untouched by every PR in this entry except #232 (unchanged from the existing write-up below) — confirmed by diffing every one of the other 36 merge commits against `server.mjs` individually.

### Changed

- **`ocp update --target <version>` is now honored or refused everywhere it appears — previously it was silently honored on only one of five paths and silently dropped on the other four.** `doctor`'s `next_action.kind` has five real update-shaped values (`noop`, `restart`, `update`, `upgrade`, `fresh_install` — `fix_oauth`/`fix_service` already exit non-zero on their own paths and were never affected). Before this batch, the *same* `ocp update --target vX.Y.Z` command silently pinned or silently didn't, depending only on where the host happened to sit in the release cycle:
  - **`upgrade` (cross-minor, the full path)** — was silently ignored (checked out `doctor.latest_version` regardless of the pin); now **honored for the `--target vX.Y.Z` (space-separated) form** — validated (`^v?\d+\.\d+\.\d+$`, and must be strictly newer than the current version — no accidental downgrades through this path) and threaded into the `git checkout` step (#257/#259). An independent review of that fix additionally found the interpolated value shell-injectable and firing *before* the tag-existence refusal; both fixed in the same PR before anything shipped past review.
  - **`update` (light/patch-bump, the single most common invocation)** — silently ignored; now **prints an explicit warning and remains a no-op** (#241/#255). This path is a `git pull --ff-only`, not a tag checkout, so honoring the pin for real would mean swapping the underlying mechanism — deliberately scoped out as a separate, larger decision, not bundled into a warning fix.
  - **`noop` and `restart`** — silently accepted the flag and dropped it with **no signal at all**; now **refused outright by bash itself, non-zero exit, before any state changes** (#260/#272), via a shared `_detect_target_flag` helper that recognizes both `--target v1.2.3` and `--target=v1.2.3` and is also reused by the light-path warning and `--check`'s own preview. **`fresh_install`** gets the same refusal, but from `scripts/upgrade.mjs` rather than bash — reachable only through the space-separated form (see the caveat below).

  **Caveat, found by an external review of this reconstruction and verified against the code:** the refusal/honoring logic in `scripts/upgrade.mjs` (the `upgrade` and `fresh_install` rows above) still parses argv with a plain `args.indexOf("--target")` — it does not recognize `--target=vX.Y.Z`. `ocp update --target=vX.Y.Z` on either of those two paths silently behaves as if no target were given at all: `upgrade` falls back to `doctor.latest_version` exactly as before this batch, and `fresh_install` does not refuse. `noop`/`restart` are unaffected — their refusal runs entirely in bash, ahead of `scripts/upgrade.mjs`, via `_detect_target_flag`, which does handle both forms. This equals-form gap on the Node-side paths is being tracked as its own issue, not fixed by this batch.

  **Upgrade note:** if you have automation invoking `ocp update --target <version>` unconditionally, audit it against the behavior above before upgrading past this point — specifically anywhere that assumed a bare `ocp update --target` was always either a real pin or a harmless no-op, and anywhere that uses the `--target=vX.Y.Z` form on a path doctor might resolve to `upgrade` or `fresh_install`.

- **`ocp update`'s `fresh_install` path (pre-v3.4.0 hosts) now requires an explicit `--fresh-install` flag in addition to `--yes` (issue #227).** #217/#260 reconnected this arm, but its real `ai_executable` steps (`mv ~/.ocp ~/.ocp.backup-<epoch>`, `rm -rf ~/ocp`, a fresh `git clone`, `node setup.mjs`) have never been execution-verified — not in CI, where the test suite only ever reaches `runFreshInstall()` with `execSync` mocked out, and not by hand. `--yes` alone — the same flag every other non-interactive `ocp update` invocation already passes, including doctor's own suggested remediation for `update`/`upgrade`/`restart` (`ai_executable: ["${ocpDir}/ocp update --yes"]`) — no longer runs it: a bare `ocp update --yes` on a host doctor classifies as `fresh_install` now refuses, naming the doctor conclusion, the explicit command to opt in (`ocp update --fresh-install --yes`), and where to read the limitation. `ocp doctor --json`'s `next_action` is unchanged — only automatic execution through `ocp update` is gated; the ai_executable steps it lists were already fully explicit. See `docs/upgrading.md`'s "Old version (< v3.4.0)" section and the README Troubleshooting bootstrap-quirk entry for the full statement of what has and hasn't been verified.

### Fixed

- **A successful `ocp update`, `ocp restart` or rollback no longer reports failure — and `ocp doctor` no longer prints `auth.ok=false` for a value that is `null` — on a host whose auth probe timed out (#289).** ADR 0010 (shipped as #275, immediately above) correctly made a probe timeout **inconclusive**: `auth.ok` holds the last *conclusive* verdict, so a timeout preserves it rather than recording a rejection, and `/health` keeps reporting `status: "ok"`. What did not change was the consumers. Every one of them still required a strict `auth.ok === true`, with retry budgets two orders of magnitude smaller than the window in which `null` persists — `postFlightOk`'s budget is 10 × 1s, the next probe is up to 600s away, and an inconclusive result does not shorten that wait. Post-flight only ever runs against a *freshly restarted* process, which by definition has no earlier conclusive verdict to preserve, so on exactly the loaded host ADR 0010 was written about, `auth.ok` was `null`, `null !== true`, and a restart that had worked was reported as a failure — with `runRollback` throwing `rollback post-flight failed: restored tree may not be what's running` about a rollback that had succeeded.
  - **`postFlightOk` now asks the question it actually needs answered**: `status === "ok"` plus the version match, instead of `auth.ok === true` plus the version match. `status` is the field ADR 0010 built specifically to answer "can this proxy serve", which is what post-flight is verifying about the process now holding the port. The version arm is untouched, so #173's orphan-holds-the-port case still fails exactly as before. The trade is deliberate in both directions: the new predicate is **stronger** against an unusable `claude` binary (which makes the probe fail to *spawn* — inconclusive — so a stale `auth.ok: true` used to survive it, while `status` goes `degraded`), and **weaker** against a single conclusive rejection (ADR 0010 holds that one rejection is a token-rotation race, not a condition; a real credential outage is caught before this point, by `ocp doctor` selecting `fix_oauth` and `ocp update` refusing to run).
  - **`ocp doctor` stops asserting a state that did not occur.** Both call sites (the full run and the `--check oauth` fast path) used a falsy check, which put `null` on the same branch as `false` and then described it with a hard-coded `auth.ok=false` string. They now share one `classifyAuthOk()` helper that keeps the three-valued domain three-valued: `true` → PASS, `false` → FAIL (unchanged — still selects `fix_oauth`), `null`/absent → **WARN**, reporting the value actually observed (`auth.ok=null`, plus `lastOutcome`) instead of a literal. WARN rather than FAIL because a FAIL here is a decision, not a label: it selects `next_action.kind = "fix_oauth"`, whose remediation is "reinstall the claude binary", and it makes the next `ocp update` refuse — neither of which is a correct response to "no probe has concluded yet", which on a freshly restarted proxy is the *expected* state for up to one probe interval.
  - **The suite now replays ADR 0010's own motivating incident through every consumer and asserts each consumer's decision**, not just the endpoint payload — `postFlightOk`, `runPostFlightCheck`, `runRollback`, both `doctor` paths, `ocp-plugin`'s `/ocp health` and `/ocp status` (driven through the real plugin over real HTTP), and `dashboard.html`'s Status card. That gap — reasoning about consumers in prose while testing only the payload — is what let this ship. ADR 0010's consumer enumeration itself carried three factual errors, now corrected in place in the ADR rather than deleted.
  - **`ocp doctor --check oauth` now counts its warnings.** `runOauthOnly` hard-coded `warn_count: 0`, which was true while that path could only emit PASS or FAIL and became false the moment a WARN became reachable there — printing `Summary: 0 FAIL, 0 WARN` directly beneath the `[WARN] oauth_ok` line it had just emitted, and under-reporting to any agent reading `--json`. Found by independent review of this change: the same hard-coded-literal-asserting-an-unobserved-state defect, reintroduced inside the fix for it. `warn_count` is now derived from `checks` on both doctor paths, and is asserted non-zero by tests so it cannot silently return to a constant.
  - **Fleet note:** v3.26.0 does not have this defect, because it does not have ADR 0010 either. Anything already updated to a `main` newer than #275 does.

- **Restart, rollback, and `cmd_restart` no longer guess which process owns the OCP port — they resolve it from live state and refuse when they can't tell (#214/#217, #215/#221/#249, #226/#229, #220/#230, #233/#240, #237/#251, #239/#265, #254/#268, #234/#250, #253/#271, #277, #280, #238/#244, #263/#270).** Before this batch, every restart path in OCP — the cross-minor upgrade phase, the `--rollback` phase, and bash's own `cmd_restart()` (used by `ocp restart`, the patch-bump update path, and direct restart) — pointed at a single hard-coded unit name (`ocp-proxy.service` / `dev.ocp.proxy`) with no check that it was actually the process holding the port. A live incident showed this "restarting" a user-scope unit while a system-scope unit was the real listener, leaving an orphan `server.mjs` unable to bind, while every layer reported success — `cmd_restart` in particular **had no failure exit code at all**; every path, success or not, fell through to an implicit `return 0`.
  - **The resolver (#221)**, plus **#217**'s earlier fix that catches the narrower "tree already updated, service never restarted" case (a new `next_action.kind: "restart"` path) and **#229**'s fix to stop `setup.mjs`'s reconfigure phase from re-enabling/starting a unit ahead of the restart phase (so it can't re-arm the same race), rebuilt the core logic in a new `scripts/lib/restart-unit.mjs`: on Linux, a leaf-to-root `/proc/<pid>/cgroup` walk identifies the real owning systemd unit (system vs. user scope); on macOS, `lsof`, cross-checked against `netstat` for `lsof`'s ambiguous exit-1/empty-stdout signature (a fix in its own right — **#240** — since that ambiguity had made the rollback-on-a-down-service recovery path unreachable on macOS). Any state the resolver can't confidently classify — an unattributable owner, a process not managed by any unit, a system unit needing sudo it doesn't have — **refuses with an actionable message rather than guessing**. **#230** adds a complementary static pre-flight check (`multi_unit_boot_race`) that warns on `ocp doctor`/`ocp update` when two enabled units (systemd or launchd) are both configured for the OCP port, independent of which one is live right now.
  - **#249** brought bash's own `cmd_restart()` onto this same resolver instead of its separate hard-coded fallback cascade (which included an `ai.openclaw.proxy`/`openclaw-proxy` legacy-name chain and an unmanaged `pkill`+`nohup` last resort) — and gave it a real exit code for the first time: a refusal now returns 1 instead of silently returning 0. **#270** applies the identical "distinguish couldn't-run from ran-and-failed" treatment to `cmd_restart`'s OpenClaw-gateway sub-step (OpenClaw is an optional sibling tool — its absence is now reported calmly and exits 0; a real failure to restart an installed gateway is now loud and exits 1; previously both crashed the whole `ocp` process identically via `set -e`).
  - Beyond the core resolver, four independently-discovered identity gaps were closed one at a time, each its own PR per Iron Rule 11: **#251** refuses when the resolved unit's live process is confirmed *not* to be `server.mjs` (closing a path where a misconfigured port pointed at an unrelated service like `nginx.service` and would have been restarted as if it were OCP's own); **#265** brings the same process-identity check to macOS via `launchctl print` (launchd has no `pid → label` lookup, so this asks the reverse direction — what PID launchd itself believes owns `dev.ocp.proxy` — and compares); **#268** adds a Linux-only, warn-only working-directory check so a second OCP checkout (e.g. a dev tree beside a production install) sharing the same process name doesn't get treated as the production instance — its first draft compared against a hard-coded default that was dead code in every real invocation, corrected to derive from the running module's own file location; and on the rollback side specifically, **#250** closes a guard gap where a mismatched *user-scope* unit (as opposed to system-scope, already refused) fell through untouched, and **#271** fixes the rollback fallback's warning to name a real second enabled unit instead of asserting none exists.
  - **Rollback also gains a real post-flight check for the first time (#277)**: it previously reported success unconditionally once the restart command exited 0, never confirming the restored tree actually came back up serving the right version. It now verifies `/health.version` against the snapshot's own recorded `fromVersion` (deliberately not `toVersion` or `doctor.latest_version`, either of which would check against the wrong target). **#280** hardens the rollback git-checkout itself: the snapshot's recorded commit SHA is now shape-validated (`^[0-9a-f]{7,40}$`) and passed via `execFileSync`'s argv form instead of a shell-interpolated string — defense-in-depth, not a live vulnerability today (the value is generated by OCP's own `git rev-parse HEAD`, not attacker-reachable), mirroring the same hardening #259 already applied to the sibling upgrade-path checkout.
  - **Platform scope is explicit, not incidental.** Linux restart-target resolution is complete: unit identity, process identity, foreign-unit refusal, working-tree match, and rollback-specific guards are all live and covered by CI. macOS is narrower by design — #240 and #265 brought it listening-state and unit/process-identity parity, but the working-tree check (#268) has no macOS equivalent (no `/proc`), and per #265's own review record, the entire darwin branch runs nowhere in this repo's CI (Linux-only runners) — verified only live, read-only, against a real host.
  - **#244** is a documentation-only sweep, correcting eight places that still described #221 as unmerged after it had actually landed — the same category of staleness this very changelog entry exists to fix, at smaller scale.

- **A dozen places in the bash CLI (`ocp`) and installer (`setup.mjs`) that ran `curl`, `lsof`, `netstat`, or `python3` could no longer tell "the command itself didn't run" from "it ran and told us the real answer is negative or empty" (#256/#258, #242/#252, #261/#267, #246/#269, #246/#285, #273/#279, #278/#286).** The shape repeats: `2>&1`-into-capture, a bare pipeline under `set -euo pipefail`, or a catch-all that discards every failure identically — so a missing binary (shell exit 127, "command not found") produced the same "proxy unreachable" or empty-JSON output as the binary running cleanly and reporting nothing. Two shared helpers now anchor most of this surface: `_curl_or_die()` (introduced in #267; wired at 14 curl call sites across `ocp` — `usage`, `usage --by-key`, `keys add`, `keys revoke`, `keys` (list), `status`, `settings` GET/PATCH, `health`, `logs`, `models`, `sessions`, `clear`, and `connect`'s own initial reachability probe) and `_pyfail()` (introduced in #252, covering the nine-then-ten `curl | python3` display commands with a raw-JSON fallback plus a loud warning instead of silent death). `setup.mjs`'s two bare `lsof`/`netstat` sites (the `start.sh` port check that gates whether a second `server.mjs` gets `nohup`'d, and the post-install bind check — two distinct checks, not one) got the same treatment via a new extracted module, `scripts/lib/start-sh.mjs` (#269, #285), though the two checks diverge in how far the fix reaches on each platform: the `start.sh` port check moves to absolute-path `lsof`/`netstat` plus a `netstat` cross-check on macOS (a restricted `PATH`, e.g. a launchd job's default environment, can omit `/usr/sbin` entirely) but stays a bare, non-absolute-path `lsof` on Linux, deliberately; the post-install bind check moves to absolute-path `lsof` only (no cross-check) on macOS, and uses a bare `ss -tlnp` — not `lsof`/`netstat` at all — on Linux. Separately, **#258** fixed a real crash in the same neighborhood: `ocp usage --by-key` and `ocp keys` could hit bash 3.2's `set -u` unbound-variable error on macOS's stock shell when no admin key is configured (the default), which is exactly the shape this whole cluster is about — a real failure, mislabeled or swallowed.
  - **Not every curl call site in `ocp` went through this fix — verified directly, not assumed.** `cmd_lan`'s own reachability probe is still a bare `curl`; a missing `curl` binary makes it print "✗ Not LAN-accessible (bound to localhost only)" — actively wrong, not just silent, since the service may be correctly LAN-bound and the real problem is that `curl` itself never ran. `cmd_connect`'s onboarding flow has the same gap in its own later steps: the initial health probe is wrapped (`_curl_or_die`, counted above), but its subsequent `/v1/models` access check and `/v1/chat/completions` smoke test are both bare `curl`, unwrapped. So is `cmd_restart`'s own post-restart confirmation probe — on a missing `curl`, it prints "✗ Proxy not responding after restart" regardless of whether the restart actually worked, the exact failure mode this whole cluster exists to close. None of these three are fixed by any PR in this range; each is being tracked as its own issue.

- **`ocp update --dry-run` on the light/patch-bump path silently performed a real update, and a missing `python3` silently killed `ocp update` before it printed anything (#235 and #236, found and fixed together in #243, the same PR that also built the bash CLI wiring harness tracked as #225).** `_cmd_update_light` never forwarded its arguments and had no `--dry-run` handling at all, so the flag was accepted and ignored; fixed by mirroring the restart path's existing preview-then-return behavior. Separately, one WARN/INFO formatting block inside `cmd_update` piped into `python3 -c "..."` without the `|| true` fallback its sibling line already had, so under `set -e` a host lacking `python3` died silently mid-dispatch, before `cmd_update` ever reached its own kind-dispatch logic. Both were found while building a new bash CLI wiring harness for `test-features.mjs`, which several of the fixes above extend rather than duplicate.

- **The auth health probe no longer blocks the event loop, and one bad probe no longer reports `degraded` for ten minutes (#232).** Two defects in the same eight lines. **(A)** `execFileSync(CLAUDE, ["auth","status"], { timeout: 10000 })` sat inside an `async function`, which does not make a synchronous call asynchronous — it froze the whole process for up to 10s at boot (*before* `server.listen()`, so the proxy could not even begin serving) and again on every 10-minute tick. It is now a real async `execFile`, with a module-level in-flight guard so a tick landing on a still-running probe is skipped instead of stacking another spawn onto an already-slow host. The 10s timeout is deliberately unchanged: it bounds a stuck child, and lengthening it would only widen the window in which the verdict is stale. **(B)** `status` was `binaryOk && authStatus.ok !== false ? "ok" : "degraded"` — duplicated verbatim in `/status` and `/health` — so a single failed probe pinned `degraded` until the next tick. Captured in production: `/health` said `status=degraded, auth.ok=false, "spawnSync ... ETIMEDOUT"` in the same minute `POST /v1/chat/completions` returned 200. Probe outcomes are now classified (`authenticated` / `rejected` / `timeout` / `unavailable`), and only a **conclusive rejection** (a numeric non-zero exit) counts: a timeout or spawn failure preserves the last known `auth.ok` and leaves the tally alone, because a probe timeout measures host load, not credential validity. `degraded` now means the `claude` binary is unusable **or** the probe has returned **2 consecutive** conclusive rejections, evaluated by one shared `proxyHealthStatus()` helper used at both sites so the two expressions cannot drift apart again. Value domain is unchanged (`ok` / `degraded`). Semantics change to two grandfathered Class B.2 endpoints, authorized by **[ADR 0010](docs/adr/0010-health-verdict-semantics.md)** per ADR 0006 ¶39/¶109; no `cli.js` citation applies (`/health` and `/status` are OCP-owned surface).
  - **Downstream behaviour change, called out deliberately:** `auth.ok` now survives an inconclusive probe. The consumer this actually changes is `scripts/doctor.mjs` (`:668` / `:869`), which reads `auth.ok` with a falsy check: against a long-running instance that has a prior conclusive success and a recent inconclusive probe, `oauth_ok` now PASSes where it previously FAILed. It does **not** change `ocp update`'s post-flight check — `runPostFlightCheck` only ever runs against a freshly restarted process, where `auth.ok` is `null` and there is no earlier verdict to preserve, so `postFlightOk` returns `false` exactly as before. (`ocp update` does benefit from the async probe itself: `/health` is reachable within milliseconds of boot instead of after a blocking probe, so the retry budget is no longer spent on connection-refused.)
  - **Correction, added with #289 (see the entry above):** that last sentence is true of the *return value* and misleading about the *outcome*. The value `postFlightOk` returns "exactly as before" is `false` — on a restart that succeeded. Reporting a working update as a failure is a behaviour change in everything except the function's return type, and it was shipped as a non-change because only the return value was checked. #289 is the fix.

### Added

- **`CLAUDE_AUTH_CHECK_INTERVAL_MS` (default `600000`) and `CLAUDE_AUTH_CHECK_TIMEOUT_MS` (default `10000`)** — the auth probe's interval and per-probe timeout are now tunable, parsed fail-closed through `parseIntEnv` (empty / NaN / non-positive keeps the default).
- **`/health`'s `auth` object gains `lastOutcome` and `consecutiveFailures`** so an operator can tell a host-load timeout from a real credential rejection. Purely additive — no existing field is renamed, removed, or re-typed (same standard ADR 0007 applied when it added the `tui` block).
- **`ocp doctor`'s `next_action.kind` gains `"restart"`** (#217) — a fifth update-shaped outcome alongside `noop`/`update`/`upgrade`/`fresh_install`, covering the case where the tree is already at the latest version but the running service is stale (a previous `ocp update` was interrupted after checking out the tag but before the restart phase ran). `ocp update` handles it automatically; the doctor JSON is otherwise unchanged in shape.
- **`ocp doctor` gains a new pre-flight check, `multi_unit_boot_race`** (#220/#230) — warns (never fails) when two enabled service units (systemd or launchd) are both configured to serve the OCP port, ahead of any live-ownership question the restart resolver above answers at restart time.

### Internal

- **Test-only hardening, no production code changed (#216, #210/#218, #222/#245, #231/#247, #248/#264, #219/#266).** Guards against future drift in the model-registry SPOT tables (a per-entry `contextWindow` pin distinguishing a deliberate 1M cap from a typo, and a reverse-direction check on `maxTokens`), `ocp-connect`'s model classifier (now exercised by running its real, sliced-out source rather than asserting on it textually), the generated autostart unit-file template (10 behavioral properties previously only checked by log-membership), and two independent sources of flakiness in the `ltBoot` live-server integration harness (a polling deadline that didn't account for measured overshoot, and 11 test bodies spawning real `server.mjs` children fully concurrently). None of these six change what a running OCP instance does.
- **Governance-documentation corrections, no code changed (#223/#228, #276/#281, #284, #282/#287).** #228 writes down testing-discipline rules (mutation-proving every test, restoring from a file backup rather than `git checkout`, defining bash test stubs only after `source`) that had been enforced as unwritten conditions on prior reviews. #281/#284 correct `CLAUDE.md`/`AGENTS.md`/`README.md`/the PR template/the ADR index, which had told every contributor to justify a missing `cli.js` citation under `ALIGNMENT.md` Rule 2 regardless of which class of endpoint they were touching — Rule 2 is a prohibition, not an authorization, and the fix makes the required evidence branch on Class A vs. Class B.1 vs. Class B.2 surface instead. #287 corrects two historical design-spec documents that had cited an invented "Rule 2 carve-out" that appears nowhere in `ALIGNMENT.md`. All four affect contributors and reviewers preparing or reviewing a PR against this repo; none change OCP's runtime behavior.

## v3.26.0 — 2026-07-27

Maintenance release. One user-visible change — advertised `maxTokens` now tells the truth — and four rounds of repairs to the machinery that is supposed to catch mistakes: a schema for the model SPOT, a release-job bug that would have shipped an empty release body, and the integration-test harness that had been failing 4 runs in 5 without anyone noticing.

Every PR carried an independent fresh-context reviewer (Iron Rule 10). Two reviewers refuted the author's stated rationale while the change itself stood; in both cases the rationale was rewritten rather than the finding waved off, and one reviewer retracted its own earlier finding after the evidence was re-derived. `server.mjs` is untouched in this release, so no `cli.js` citation applies.

### Changed

- **`maxTokens` now matches the CLI registry (#195).** The previous values were not uniform: six entries were 16384 and `claude-haiku-4-5-20251001` was 8192. Every Opus entry and `claude-sonnet-5` go to **64000**, `claude-sonnet-4-6` and `claude-haiku-4-5-20251001` to **32000** — the `max_output_tokens.default` each model declares in the compiled CLI 2.1.220 registry. Every model except `claude-sonnet-4-6` (1.95x) moves by the same 3.91x — haiku included, from its lower base. This corrects **advertised metadata only**: `models.json` is the SPOT (ADR 0003) and every value in it should be the truth about the model. **It changes nothing about how OCP behaves.** OCP never enforces `maxTokens` — `buildCliArgs` passes no output-token flag to the CLI at all — and OpenClaw addresses a local OCP over `openai-completions`, whose request field (`max_completion_tokens`) appears nowhere in this repo. The value is consumed only by clients that choose to honour it, via `setup.mjs` / `scripts/sync-openclaw.mjs` / `ocp-connect`. **Expect no change in answer length or quota burn.** `ocp-connect`'s independent family table moves to the floor over each family's current `models.json` members (opus 64000, sonnet 32000, haiku 32000), since prefixes cannot distinguish versions. Its unknown-id fallback stays at **8192** — the registry's global minimum, held by `claude-3-5-haiku` and `claude-3-5-sonnet`, which are the only real ids that reach it (`claude-3-5-*` matches no family prefix).

### Added

- **`models.schema.json` — the model SPOT now has a schema, enforced in CI (#196).** `models.json` declares it via `$schema`, and `test-features.mjs` validates the SPOT against it using the repo's **own** `validateJsonSchema` from `lib/structured-output.mjs` — no new dependency. A malformed entry now fails the build instead of surfacing downstream in OpenClaw. The schema's description names exactly which keywords that validator enforces and which it **silently ignores** (`minimum`, `maxLength`, `pattern`, `uniqueItems`, …), so nobody adds a constraint that buys nothing; those go in `test-features.mjs` instead. Guard tests cover 8 distinct corruptions plus uniqueness and whitespace on every name field.

### Fixed

- **`release.yml` would have produced an empty release body on any repo state without `CHANGELOG.md` (#202).** The no-changelog branch set an output pointing at a notes file it never wrote, and the create step then read a missing path. Rare, but it fails exactly when you least want it to — during a release. The branch now writes the file.
- **The `ltBoot` integration harness was failing 4 runs in 5 (#199, #209).** Measured with a control arm — full suite × 4 concurrent × 50 rounds against unmodified `main` and against the fix — clean runs went **42/200 → 200/200**, with `EADDRINUSE` **246 → 0**. Four distinct races: two tests gated on a stdout marker and then asserted on a **stderr** line written 12 `console.log` calls later (different pipes, nothing ordering them); every fixed port replaced with `ltFreePort()` (the old 39321–39364 range sits *inside* Linux's default ephemeral range, so CI was more exposed than a Mac); `close` instead of `exit` where a test reads a buffer after termination; and retrying teardown against grandchildren still writing into the temp dir. **#203 is NOT fixed and remains open** — it has never reproduced on macOS (0 across both 200-run arms) and all four sightings are Linux CI, one of them on #205 inside this very release. #211 adds a manual `workflow_dispatch` harness to hunt it on Linux with a pre-#204 positive control. Diagnostics now print exit/signal/closed/elapsed/Node version plus a head+tail sample of both streams — sized so the sample provably reaches the one line that distinguishes "booted" from "refused", with a test pinning that budget so it cannot silently degrade.

### Internal

- **Guard comments on the asymmetric cache-key construction (#200)** — `structuredHash` and `dedupKey` carry deliberately different guards, and the resemblance invites a "cleanup" that would collapse them. Now documented at the site.
- **`AGENTS.md` § "Testing: reaching faults inside `server.mjs`" (#197)** — writes up the fault-injection method these fixes needed, including the `--stack-size` lever and why running a flaky scenario *in isolation* removes the very concurrency that causes it.
- **`ocp-connect` documentation corrections.** Its family table is the floor over each family's *current* `models.json` members — not over the registry family — and its unknown-id fallback stays at 8192, the registry's global minimum. Both had comments asserting otherwise. Its model table and fallback remain **untested**; tracked as #210.
- **Known gap, deliberately not fixed here: `contextWindow` does *not* match the registry (#213).** The same CLI 2.1.220 bundle declares `window:1e6, native_1m:true` for `claude-opus-5`/`-4-8`/`-4-7` and `claude-sonnet-5`, while `models.json` says 200000. Unlike `maxTokens`, this cannot be corrected as metadata: `derivePromptCharBudget` takes `max(contextWindow) × 3` across **all** entries, so one 1M model would raise `MAX_PROMPT_CHARS` from 600k to 3M for every model — including `claude-haiku-4-5-20251001`, which really is 200k native — turning clean OCP-side truncation into upstream API rejections. Fixing it needs per-model prompt budgets (ADR-level). Recorded so this release's "the SPOT tells the truth" claim is not read as covering it.

## v3.25.0 — 2026-07-27

Minor release. Headline: **Claude Opus 5** joins the model list and the `opus` alias now resolves to it. Alongside it, two `server.mjs` correctness fixes found by review rather than by users — a monotonic in-flight-counter leak, and cache keys that were hashing the alias string instead of the model it resolves to. The three TUI/prompt fixes that landed after v3.24.0 are included here too.

Every code PR carried an independent fresh-context reviewer (Iron Rule 10); #192 additionally went through the external codex gate, which is what surfaced the cache-key defect. No new endpoint, no new env var, no new `cli.js` wire behavior.

### Added

- **Claude Opus 5 (`claude-opus-5`) (#192).** New `models.json` entry — `/v1/models` goes 6 → 7 and OpenClaw picks it up on the next `ocp update` (via `scripts/sync-openclaw.mjs`). Verified against the installed CLI rather than assumed: the compiled `claude` 2.1.220 bundle carries `latest_per_family:{fable:"claude-fable-5",opus:"claude-opus-5",sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"}`. Availability confirmed with a live `claude -p --model claude-opus-5` completion on the subscription pool. `claude-opus-4-8` is retained for pinning.
- `contextWindow` is deliberately **200000**, not Opus 5's native 1M. Two reasons, both verified: (1) `MAX_PROMPT_CHARS` is a **single global** budget — `derivePromptCharBudget` takes `max(contextWindow) × 3` across *all* entries (`lib/prompt.mjs`), so a 1M entry would raise the truncation ceiling to 3,000,000 chars for `claude-haiku-4-5` too, which is genuinely 200k native, converting clean OCP-side truncation into an upstream API rejection; (2) OpenClaw scales its history budget linearly off this value (`contextWindow × maxHistoryShare × SAFETY_MARGIN` = `× 0.6`, plus an oversized-message threshold at `× 0.5`, per `compaction-planning` in OpenClaw 2026.7.1), and its own bundled registry hardcodes 200000 for Claude — the upstream request to raise it to 1M ([openclaw#22979](https://github.com/openclaw/openclaw/issues/22979)) was closed *not planned*. A new regression test pins the invariant so a future 1M entry has to be a deliberate, reviewed change. Raising it for real needs per-model budgets — tracked separately, ADR-level.

### Changed

- **The `opus` alias now resolves to `claude-opus-5` instead of `claude-opus-4-8` (#192).** Every request that names `opus` — and OpenClaw's opus entry — moves to Opus 5 on upgrade. This mirrors what the CLI itself defaults to (`latest_per_family.opus` above), the same reasoning as #168's `sonnet` → `claude-sonnet-5` repoint in v3.23.0. **Pricing is unchanged** ($5/$25 per MTok; CLI registry `pricing:"tier_5_25"` for both Opus 4.8 and Opus 5), so this carries no cost change. Pin `claude-opus-4-8` explicitly to stay on the previous model.

### Fixed

- **Cache keys hashed the alias, not the model it resolves to (#194).** `model` enters `cacheHash` exactly as the client sent it, so a request for `"opus"` was cached under the literal `"opus"` — and since `models.json` is read once at boot while the SQLite `response_cache` outlives a restart, repointing an alias kept serving the **old model's** answers under it until TTL expiry. That would have silently defeated this release's own `opus` repoint for anyone running with the cache on. All three call sites now hash `Object.hasOwn(MODEL_MAP, model) ? MODEL_MAP[model] : model`, which fixes the normal, structured **and** single-flight keys at once and covers `legacyAliases` for free, with precise invalidation (only the repointed alias's entries change key) rather than a whole-cache flush. (`hasOwn` rather than a bare lookup: `MODEL_MAP` is a plain object, so `MODEL_MAP["__proto__"]` would return a truthy *object* and not even fall through to the `|| model` guard.) **Also closes a latent gap from #177:** the structured and dedup keys never passed `configEpoch` at all, so a `CLAUDE_SYSTEM_PROMPT` change — the original #176 scenario — kept serving structured answers composed under the old config, live since #153. Found by the external codex review of #192.
- **In-flight request counter leaked permanently on a pre-spawn throw (#193, reported by @konceptnet in #180).** `stats.activeRequests` was incremented ~40 lines before the child spawn, while its only decrement is reached through that process's events — so any synchronous throw in between (`buildCliArgs`, env assembly, the spawn decision, or `spawn()` itself) leaked `+1` forever, and `/health` and `/status` over-reported in-flight work monotonically. The increment now sits immediately after `activeProcesses.add(proc)`, structurally pairing it with the decrement; no reconciliation pass and no try/catch. Observability-only field, so no admission decision changes.
- **TUI: the host `CLAUDE.md` could leak into proxied turns (#187, contributed by @sumlin).** The TUI pane now spawns with `--safe-mode`.
- **TUI: `shift+tab to cycle` is accepted as an input-ready marker (#188, contributed by @sumlin).** Claude renders one of two ready-state footers depending on the build — the classic `? for shortcuts` hint, or `shift+tab to cycle` (as part of `⏵⏵ bypass permissions on (shift+tab to cycle)`) on newer 2.1.x. The matcher only knew the classic string, so on those builds it silently reported "never ready": every boot timed out with `tui_pane_not_ready`, and with the warm pool on, every pre-boot failed.
- **`OCP_LOCAL_TOOLS` no longer hard-codes a tool list in its wrapper (#191, closes #185).** The positive wrapper claimed a fixed set of tools regardless of `CLAUDE_ALLOWED_TOOLS`, so a narrowed tool surface was described inaccurately to the model.

### Testing

- The response-cache and counter fixes ship with **mutation-proven integration tests** built on the existing `ltBoot` child-process fixture (real `server.mjs`, fake `claude` binary, so no quota cost). The counter test reaches a synchronous fault *inside* `spawnClaudeProcess` from environment alone — no production fault hook — by running the child under `--stack-size=200` to lower the spread-throw threshold enough to fit Linux's `MAX_ARG_STRLEN`. Suite: **447 → 457** across this release (per PR: #188 +1, #187 +1, #191 +0, #194 +4, #192 +3, #193 +1).

## v3.24.0 — 2026-07-21

Minor release. Headline: two long-requested **OpenAI-compat features** land — **multimodal vision** (`image_url` parts) and **structured outputs** (`response_format` / JSON schema). Also: the prompt-char budget now derives from the model SPOT instead of a hand-set constant, an agentic-turn bug that dropped the model's final answer is fixed, and `OCP_LOCAL_TOOLS` supports the OpenClaw-backend use case. Four of the six landed from external contributors (@vvlasy-openclaw). Every code PR carried a fresh-context reviewer (Iron Rule 10); no new endpoint, no new `cli.js` wire behavior.

### Added

- **Multimodal vision — OpenAI `image_url` parts (#154, contributed by @vvlasy-openclaw).** `/v1/chat/completions` forwards OpenAI `image_url` content parts to `claude` as native Anthropic image blocks via `--input-format stream-json` (the CLI's own contract — no invented wire shape, verified live). Base64 `data:` URIs by default; remote `http(s)` URLs are off unless `CLAUDE_IMAGE_ALLOW_URL=1` (and even then OCP never fetches them — no SSRF surface). Byte/count caps (`CLAUDE_MAX_IMAGE_BYTES`, `CLAUDE_MAX_IMAGES`, `CLAUDE_MAX_IMAGE_TOTAL_BYTES`), all fail-closed on a misconfigured value. TUI mode returns `400 images_unsupported_in_tui_mode` (it can't carry image blocks) and an image present only in a `system` message returns `400` rather than being silently dropped. README § "Images / Multimodal".
- **Structured outputs — OpenAI `response_format` (#153, contributed by @vvlasy-openclaw).** `/v1/chat/completions` honors `response_format: { type: "json_schema" | "json_object" }` so OpenAI-SDK clients (Home Assistant AI Tasks, Honcho, scripts) get machine-parseable JSON in `content`. Validates against the schema (incl. `$ref`/`$defs` + `allOf`/`anyOf`/`oneOf` — the shapes the OpenAI SDK emits), retries with a stronger instruction up to `OCP_STRUCTURED_MAX_ATTEMPTS` (default 3, fail-closed), and on exhaustion returns OpenAI's own `refusal` field (200/`content:null`) rather than an invented error. Cyclic-`$ref` schemas fail closed (no stack overflow); a pathologically deep model reply returns a refusal, not a 500 (#181). Single-flight dedup + structured-keyed cache bound the cost. Class B.1 (ADR 0006). README § "Structured Outputs".
- **SPOT-derived prompt-char budget (#179, ADR 0009).** `MAX_PROMPT_CHARS` default now derives from `max(models.json contextWindow) × 3 chars/token` (600,000 today) instead of the hand-set 150,000 (~37.5k tokens) that silently under-delivered the advertised window ~5×. `CLAUDE_MAX_PROMPT_CHARS` and the settings API remain absolute overrides; a garbage value fails closed to the derived default.
- **`OCP_LOCAL_TOOLS` — positive local-tools system-prompt wrapper (single-user, loopback only; default off) (#182, contributed by @vvlasy-openclaw).** The `-p` path prepends a wrapper telling the model it has no local filesystem/shell access — correct for a shared gateway, but it makes a personal instance's model (e.g. an OpenClaw agent on its own local OCP) refuse to use the server-side `claude` tools it legitimately has. `=1` swaps in a positive wrapper. Changes **only the prompt**, never the tool surface (`--allowedTools`/`--disallowedTools` untouched; multi-tenant still disallows the FS surface); it does **not** enable client-side `tool_calls` (still unsupported by design). Fail-closed boot gate mirroring `OCP_TUI_FULL_TOOLS` (ADR 0007): refuses to start under `CLAUDE_AUTH_MODE=multi`, a non-loopback bind, or `PROXY_ANONYMOUS_KEY`. Inert (and logged as such) in TUI mode. The active wrapper is folded into the config epoch so toggling it invalidates the standard response cache. No new `cli.js` wire behavior (reuses the already-cited `--system-prompt` flag).

### Fixed

- **Agentic turns dropped the model's final answer (#183, contributed by @vvlasy-openclaw).** On a tool-using turn, `/v1/chat/completions` returned only the opening preamble ("I'll find the repo…") and silently discarded the post-tool-use final answer: aggregate-`assistant` extraction was gated on `isFirstDelta` (which flips false after the first text), and OCP runs pure-aggregate mode (no `--include-partial-messages`), so each of an agentic turn's several assistant messages after the first was lost. Now guards on `sawTextDelta` and accumulates every assistant message (streaming and buffered paths assemble byte-identically).
- **Deep structured reply returned a 500 instead of a refusal (#181 / #184).** `validateJsonSchema` recurses on the model reply's nesting depth; a ~2000-level-deep reply overflowed the stack → caught `RangeError` → generic 500. A crash-safe façade converts that (only) into a validation miss → refusal; any other throw still surfaces.

## v3.23.0 — 2026-07-17

Minor release. Headline: **the default `sonnet` alias now resolves to Claude Sonnet 5** — a behavior change for every request that omits `model` (pin `claude-sonnet-4-6` by full ID to keep the previous default). Also: Windows-safe upgrade snapshots, two upgrade-system reliability fixes from a live fleet update, the `CLAUDE_SYSTEM_PROMPT` env var made functional, cache-key honesty for config changes, a billing-policy status correction (the 2026-06-15 `-p` split is PAUSED by Anthropic), and a major README restructure. No new endpoint; no new `cli.js` wire behavior. Every code PR carried a fresh-context reviewer (Iron Rule 10).

### Changed

- **Default `sonnet` alias → `claude-sonnet-5` (#168, contributed by @vvlasy-openclaw).** The `sonnet` alias (the model used for every `/v1/chat/completions` request that omits `model`, and OpenClaw's OCP primary via `ocp-connect`) now resolves to `claude-sonnet-5` instead of `claude-sonnet-4-6`. `claude-sonnet-4-6` remains available by full ID for pinning. Mirrors the shipped Claude CLI's own `latest_per_family` mapping (`sonnet → claude-sonnet-5`, verified from binary 2.1.211). Split out from the additive model entry (#152) per Iron Rule 11.
- **`CLAUDE_SYSTEM_PROMPT` is now functional (#175).** The var was read, documented, and echoed on `/health.systemPrompt` but never reached a request (dead since the `APPEND_SYSTEM_PROMPT` retirement). It is now appended (last, trimmed) to the composed system prompt on the default `-p` path via the new pure `lib/prompt.mjs`; TUI-mode panes are unaffected. Unset ⇒ byte-identical composition to before. README § Environment Variables documents it, including the cache caveat below.

### Fixed

- **Windows-safe upgrade snapshot paths (#167, contributed by @nyxst4ck).** Snapshot directory timestamps now use `-` instead of `:` (Windows forbids `:` in names); legacy colon-named snapshots keep parsing, and `listSnapshots` now orders by **parsed timestamp** (with a deterministic name tie-breaker) so mixed legacy/new names sort chronologically — the initial revision's raw-string sort could delete the newest recovery snapshot at the format boundary and was caught in review; regression tests pin the same-hour mixed-format case.
- **`ocp update` reliability — two live-incident fixes (#174, closes #173).** (1) The doctor now runs `git fetch --tags` (offline-tolerant) before computing `latest_version` — previously it compared against the locally cached `origin/main`, so machines that hadn't pulled since a release reported "Already at latest" forever. (2) Post-flight now asserts `/health.version` equals the upgrade target (new `postFlightOk` predicate) instead of accepting any `auth.ok` — a stale orphan process holding the port used to pass post-flight while still serving the old version; the failure message now reports the last-seen version and points at `ss -ltnp`/`lsof -i`.
- **Response-cache key now carries a boot-config epoch (#177, closes #176).** The persistent cache keyed on model+key+params+messages but not on server config that shapes answers (`CLAUDE_SYSTEM_PROMPT`, wrapper text, `CLAUDE_ALLOWED_TOOLS`, `CLAUDE_NO_CONTEXT`) — changing any of these and restarting could serve stale-config answers until TTL expiry. A sha256 config-epoch is folded into every key; any config change is an instant whole-cache invalidation. One-time side effect: existing cache entries miss once after this upgrade.

### Docs

- **Billing-policy status corrected (#171).** Anthropic **paused** the announced 2026-06-15 `claude -p` billing split on its effective date (official help-article citation in README § How It Works): the default `-p` path currently bills the subscription, and TUI-mode is reframed as the ready-made **hedge** for if/when a reworked change lands. All in-force assertions of the split are now date-stamped and conditioned.
- **LAN mode scoped to chat-class workloads (#171).** New "workload fit" paragraph: multi-device OCP is for text-in/text-out workloads; client-machine coding agents are architecturally out of scope (tools execute on the OCP host).
- **README restructured, 1205 → ~500 lines (#172).** Operations-manual content moved to `docs/lan-mode.md`, `docs/tui-mode.md`, `docs/troubleshooting.md`, `docs/upgrading.md` (verbatim moves + two canonical dedups; zero content loss verified section-by-section). README keeps the quickstart, the release-kit-pinned reference tables, and summary stubs with links. Plus a staleness sweep (#170): 6-model examples, removal of the never-existed `ocp stop` command, `ocp-connect` claims corrected, current version examples.

## v3.22.1 — 2026-07-17

Minor release: TUI-mode latency and streaming features — **all opt-in and off by default**, so the default request path (`-p` / `--output-format stream-json`) is byte-for-byte unchanged — plus hardening from an independent (Codex) re-review of the streaming work, Windows `claude.exe` startup resolution, and the Claude Sonnet 5 model entry. No new `cli.js` wire behavior and no new endpoint; the new surface is entirely OCP-owned TUI-mode configuration (env vars), startup binary discovery, model metadata, and `/health` observation. Every code PR carried a fresh-context reviewer (Iron Rule 10). (Version note: v3.22.0 was prepared but never tagged; its contents ship here as v3.22.1 together with the additions below.)

### Added

- **Claude Sonnet 5 in the model SPOT (#152, contributed by @vvlasy-openclaw)** — `claude-sonnet-5` added to `models.json` (`contextWindow` 200000 / `maxTokens` 16384 / `reasoning` true, consistent with existing entries), exposed via `/v1/models` and the OpenClaw sync. Purely additive: the `sonnet` alias still resolves to `claude-sonnet-4-6` (the repoint is tracked separately in #168). `ocp-connect`'s model classifier now matches on the model *family* prefix (`claude-sonnet`/`claude-opus`/`claude-haiku`) instead of version-pinned prefixes, so current and future versioned IDs register with correct `reasoning`/`maxTokens` metadata. New referential-integrity tests guard that every alias target exists in `models[]`.
- **Windows `claude.exe` startup resolution (#161, contributed by @nyxst4ck, diagnosis credit #147 @Justinsato)** — on Windows, `resolveClaude()` now discovers a native `claude.exe` (`%USERPROFILE%\.local\bin`, WinGet Links, WindowsApps, then `where.exe`) and rejects npm `.cmd`/`.bat`/`.ps1` shims, which cannot be spawned without a shell — previously startup resolved a shim and failed. A non-`.exe` `CLAUDE_BIN` on Windows is a fatal error with an actionable hint. The macOS/Linux path is byte-for-byte unchanged. Note: this is startup binary resolution only — full Windows support is not yet claimed (snapshot-path portability is tracked in #167).

### Added — TUI mode (all opt-in, default off)

- **Spawn effort control — `OCP_TUI_EFFORT` (default `low`) (#156)** — the interactive `claude` is now spawned with an explicit `--effort` flag. `low` cuts measured TTFT p50 by ~40% and collapses run-to-run variance ~15× versus an inherited `xhigh`; proxied requests rarely benefit from extended thinking. Set `inherit` to omit the flag and restore the pre-flag HOME-dependent behaviour. Banner-verified to stay on the subscription pool (`· Claude Max`); an invalid value warns and falls back to `low`. README § "Environment Variables".
- **Warm pane pool — `OCP_TUI_POOL_SIZE` (default `0` / off) (#158)** — pre-boots up to 4 single-use `claude` panes so a request skips the cold boot: measured end-to-end p50 `10.17s` → `6.00s` (−41%) on a Mac mini (Sonnet 4.6, `--effort low`). Opt-in because each warm pane is a live idle process held whether or not a request ever arrives. Panes are single-use (one turn, then killed and replaced in the background), port-scoped (`ocp-tui-<port>-p<hex>`), and coexist with the zombie reaper by a synchronous drain→reap→resume sweep. README §§ "Environment Variables" + "How It Works".
- **Real SSE streaming — `OCP_TUI_STREAM` (default `0` / off) (#159, #160)** — `stream:true` turns emit real `delta.content` chunks as `claude` generates them, sourced from `claude`'s own `MessageDisplay` hook (registered via `--settings` on the ordinary interactive spawn — banner-verified on the subscription pool). Granularity is block-level, and it moves the *first* byte, not the last. The transcript stays authoritative: streamed text is asserted equal to it at end-of-turn, the auth-banner and truncation gates still run before anything is committed, and a turn whose stream cannot be reconciled is **refused** (SSE error frame, not cached) and counted on `/health` (`tui.streamDivergences`; a silent total-hook-failure is counted separately as `tui.streamZeroDeltaTurns`). Tunables: `OCP_TUI_STREAM_HOLDBACK` (default `100`), `OCP_TUI_STREAM_DIR`, `OCP_TUI_STREAM_POLL_MS`. See ADR 0007 (2026-07-13 amendment). README §§ "Environment Variables" + "How It Works".

### Fixed

- **Streaming auth-banner guard: a null `message_id` on the first hook fire (#160)** — a first `MessageDisplay` fire with a null `message_id` could disarm the auth-banner guard; re-landed after a #159 squash dropped it (`lib/tui/stream.mjs`).
- **Test suite wrote live, unrevoked API keys into the operator's real key store (#163)** — `npm test` had been opening `~/.ocp/ocp.db` (the running server's DB) and writing two junk `api_keys` rows per run (737 accumulated on the maintainer's host), because the isolation the comments claimed was never wired (ESM import hoisting). `keys.mjs` now honors `OCP_DIR_OVERRIDE` under `NODE_ENV=test` and the suite points at a scratch dir; a child-process probe verifies a production process (no `NODE_ENV`) cannot be redirected.
- **Streaming holdback floor + billing-pool observation on failed turns (#164)** — (A1) `OCP_TUI_STREAM_HOLDBACK` now clamps up to the safe floor (`100`) with a boot warning, closing a latent auth-banner leak when an operator set a sub-floor value. (A3) the `cc_entrypoint` (billing-pool) observation is now recorded before the honesty gates that throw, so `/health` no longer goes blind to exactly the failed turns most likely to signal a silent degrade to the metered Agent SDK pool.
- **Test-only key-store redirection vars can no longer reach a server OCP launches (#165)** — (A4) `NODE_ENV`/`OCP_DIR_OVERRIDE` are stripped from every service unit `setup.mjs` writes (`plist-merge`'s `NEVER_PRESERVE`) and from the `ocp restart` manual nohup fallback (`env -u`); #163's overstated "a prod server can NEVER be redirected" comments were softened to name the one residual hand-launch path and the loud `getDb()` "NOT the default" backstop.

### Docs

- **README billing honesty (#162, closes #136)** — removed a feature bullet that promised what the § "honest limits" section forbids.
- **TUI latency plans + streaming-achievability spike (#155, #157)** — measured latency decomposition, backlog, and the `MessageDisplay`-hook streaming prereq spike under `docs/plans/2026-07-13-tui-latency/`.

## v3.21.1 — 2026-07-07

Patch release: three bug fixes from an independent concurrency/session-lifecycle audit, each its own PR with a fresh-context reviewer (Iron Rule 10). No new `cli.js` wire behavior, no new endpoint, header, or env var; the `/health` field set is unchanged (only value truthfulness improved).

### Fixed

- **TUI session-scope / boot-reap (#148)** — `lib/tui/session.mjs`'s tmux session prefix is now scoped per-instance by listen port (`ocp-tui-<port>-`) instead of a bare host-wide `ocp-tui-` constant, so a second OCP instance on the same host (e.g. a temporary verification instance) can no longer have its live TUI sessions reaped or `kill-server`'d by another instance's boot/periodic sweep. The one-time boot reap also claims exact-shape legacy `ocp-tui-<8hex>` sessions (pre-fix naming) once, to clean up zombies left behind across an in-place upgrade.
- **`-p` spawn-token mutex + keychain caching (#150)** — the real-HOME token fallback used when the keychain token is within its 5-minute expiry window is now serialized behind a mutex, so concurrent `-p` spawns no longer race the same single-use refresh token against each other (the credential-fork hazard). Added a 30s TTL cache + last-good-label memoization for the keychain read, cutting per-spawn event-loop blocking. The isolation decision (`/health` isolated/real-home reporting) is now re-evaluated per spawn instead of memoized forever, so `/health` no longer misreports a stale decision. New module `lib/spawn-auth.mjs` extracts the pure, unit-testable primitives (mutex, TTL cache, expiry gate, label ordering).
- **Concurrency queue / disconnect handling (#149)** — the shared semaphore now honors a runtime-lowered `maxConcurrent` immediately (previously a decrease was silently ignored until in-flight tasks finished on their own) and wakes queued waiters right away when the limit is raised. Queued `-p`/TUI requests are now linked to the client's HTTP connection via `AbortSignal`; a client that disconnects while queued is spliced out of the queue instead of still spawning `claude` once a slot frees. A singleflight follower whose leader disconnected now retries instead of inheriting a spurious 500, and a queued-then-disconnected request is no longer recorded as a usage failure or logged as an error (quiet disconnect handling).

## v3.21.0 — 2026-06-25

Cleanup + docs release: TUI dead-code removal, docs honesty, and release prep. No new `cli.js` wire behavior; the default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI dead-code / footgun cleanup

- **A1 — removed inert entrypoint-env path** (`lib/tui/session.mjs`): deleted `resolveTuiEntrypointEnv()` and the redundant env-strip block in `runTuiTurn`. The `{env}` object passed to `spawnSync` (tmux itself) was the wrong target — tmux does NOT forward the spawning process's environment to the pane; the pane's `claude` gets its env exclusively from the `env` prefix string built inside `buildTuiCmd` (verified live 2026-06-01). The spawnSync env is now intentionally minimal (`HOME` only). Behavior is unchanged: `buildTuiCmd` already handled all claude-specific env vars via its prefix string.
- **A2 — removed test-only transcript helpers** (`lib/tui/transcript.mjs`): deleted `encodeCwd()` and `transcriptPath()` exports and the tests that pinned them. Production resolves transcripts exclusively via `findTranscriptPath()` (glob by session-id), which is immune to the exact path-encoding rule. No non-test importers existed (grep confirms). A `// TODO` comment near `findTranscriptPath()` notes that a CI fixture-contract test would make claude-schema drift fail loudly.
- **A3 — removed headless-unusable `--dangerously-skip-permissions` branch** (`lib/tui/session.mjs` + `README.md`): `OCP_TUI_FULL_TOOLS=1` now always takes the `--allowedTools` path. The removed branch pushed `--dangerously-skip-permissions` when `CLAUDE_SKIP_PERMISSIONS=true`; on claude v2.1.x this triggers an interactive bypass-acceptance screen that a headless tmux pane cannot answer → the turn hangs to the wallclock cap and bricks the pane. The working path is `--allowedTools` + scratch-home `settings.json` `additionalDirectories`. `CLAUDE_SKIP_PERMISSIONS` for the `-p` path is unchanged (still used in `server.mjs`).

### Docs

- **Client-tools boundary** (README `§ How It Works`): OCP is a text-prompt bridge only — it does not pass OpenAI `tools`/`functions` or Anthropic `tool_use` blocks to the client. Clients receive assistant TEXT only; client-local tool execution is not supported by design (bypassing `cli.js` = out of scope per `ALIGNMENT.md`).
- **ToS honesty** (README `§ Deployment model & security`): pooling one Claude subscription across multiple distinct people may violate Anthropic's Consumer ToS and risk account suspension by the abuse classifier. The defensible framing is "one person, your own devices" — friends/team sharing is not. The prior language ("account terms are your call") was accurate but understated the risk.
- **"Why OCP" posture** (README `§ Why OCP?`): new bullet making explicit that OCP drives the official `claude` CLI as-is — no OAuth token extraction, no binary patching, no protocol invention — so traffic looks like genuine Claude Code (`cc_entrypoint=cli`).
- **Promotion plan** (`docs/PROMOTION.md`): "stable & visible" strategy covering goal (polish + low-key OSS visibility, NOT growth-hacking given the live ToS/billing risk), pre-requisites (stability first), honest ToS disclosure requirement, items explicitly skipped (multi-backend routing → OLP; gateway model-discovery; raw API passthrough → ALIGNMENT.md scope), TUI toggle as billing-split insurance, and low-key visibility actions. Framed as a recommendation for the maintainer to review, not a committed plan.

### Previously shipped (v3.20.x) — documented here for completeness

- **Default `-p` spawn-home isolation** (v3.20.0 / PR-A): per-request `claude` spawns run in a credential-free minimal scratch HOME (`$HOME/.ocp/spawn-home`, no `.credentials.json`/`settings.json`/plugins) with a neutral cwd and the env token, cutting per-request latency (measured ~10–28s → ~3–7s). Kill-switch: `OCP_SPAWN_REAL_HOME=1`. Active mode shown at startup and on `/health.spawn`.
- **Bounded concurrency wait-queue** (v3.20.0 / PR-B): excess `-p` requests queue (up to `CLAUDE_MAX_QUEUE`, default 16) instead of being rejected; a full queue returns `HTTP 429` + `Retry-After` (not an opaque 500). New env vars: `CLAUDE_MAX_QUEUE`, `CLAUDE_QUEUE_RETRY_AFTER`. Surfaced on `/health.concurrency` + `/health.stats.queueRejections`.
- **`ocp restart`** macOS `bootout`+`bootstrap` (v3.20.0 / PR-B): safe restart command that forces launchd to re-read the plist (unlike `kickstart -k` which reuses the cached env).
- **`/ocp` plugin OpenClaw-2026.5.27 compat** (v3.20.0 / PR-C): gateway plugin updated for the current OpenClaw API version.

## v3.20.1 — 2026-06-13

TUI-mode auth hardening: fixes the recurring `Please run /login · API Error: 401` (the PI231 incident) and reaps leaked defunct `claude` sessions. ([#141](https://github.com/dtzp555-max/ocp/pull/141))

### Fixed

- **TUI 401 / credential corruption (#141)** — interactive `claude` prefers `~/.claude/.credentials.json` over the `CLAUDE_CODE_OAUTH_TOKEN` env var (unlike `-p` mode, where the env token wins). OCP TUI's per-request spawn + `kill-session` cycle raced claude's single-use refresh-token rotation, corrupting the refresh token to an empty string → permanent 401 that `claude /login` couldn't fix (each new spawn re-corrupted it). This bit Linux/file-based hosts specifically (macOS reads credentials from the Keychain, so Mac mini was immune). **Fix:** when `CLAUDE_CODE_OAUTH_TOKEN` is set, the TUI claude now runs in a credential-free scratch HOME (`<HOME>/.ocp-tui/home`, overridable by `OCP_TUI_HOME`) seeded with onboarding + cwd-trust but **no `.credentials.json`**, so the env token is the only credential and claude never runs the refresh path. Recurrence-proof — a later `claude login` can no longer break TUI. Also: `buildTuiCmd` passes `CLAUDE_CODE_OAUTH_TOKEN` to the spawn, and `reapStaleTuiSessions` reaps defunct `claude` sessions (tmux-server-owned zombies) via `kill-server` when no foreign session remains, plus a 15-min idle-gated periodic reap. When the env token is unset, behaviour is byte-for-byte unchanged (real-home + credentials.json). Two independent fresh-context reviewers (Iron Rule 10) + a live PI231 portability test (works with a corrupt credentials.json present). Authorized by the ADR 0007 PR-D amendment (Class B).

### Environment variables

- `CLAUDE_CODE_OAUTH_TOKEN` — when set on a TUI host, TUI authenticates via this long-lived token in a credential-isolated home (recommended; immune to credentials.json corruption).
- `OCP_TUI_HOME` — overrides the TUI scratch home; if you previously pointed it at your real home, unset it to get the credential-isolated default.

## v3.20.0 — 2026-06-10

TUI-mode billing-safety hardening for the 2026-06-15 Anthropic billing split. A 5-dimension multi-agent audit (adversarial verification + live tests on all three hosts — PI231 / Oracle / Mac mini, claude 2.1.104 / 2.1.114 / 2.1.170) found the TUI subscription-pool path could silently bill the metered Agent SDK pool or poison the cache under realistic failure modes. Three PRs, each with a fresh-context reviewer (Iron Rule 10) and CI; the default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI — honesty & cache correctness (#137)

- **C-1** — `callClaudeTui` now throws on a claude-CLI auth-failure banner (e.g. `Please run /login · API Error: 401 …`, `Failed to authenticate. API Error: 401 …`) instead of returning it as a real answer, so it is never cached, singleflight-shared, or counted as a model success. Conservative detector (whole trimmed text ≤100 chars + `API Error: 4xx` + auth keyword + no code/quote char); overridable via `CLAUDE_TUI_ERROR_PATTERNS`. Live-reproduced on PI231.
- **C-2** — `readTuiTranscript` distinguishes a complete turn from a wallclock-truncated partial (`truncated` flag); `callClaudeTui` throws `tui_wallclock_truncated` so a partial is never cached or counted as success.
- **C-3** — `verifyEntrypoint` reads the `entrypoint` field from any transcript line, not just `{system, turn_duration}` — some claude builds emit zero turn_duration lines (live-confirmed on Oracle's claude 2.1.114), which previously left the billing-drift assertion blind on those builds.
- **C-4 (paste)** — short prompts (e.g. `hi`) could never pass paste-landing detection; threshold lowered. Live-reproduced on PI231.

### TUI — concurrency & observability (#139)

- **Concurrency** — `OCP_TUI_MAX_CONCURRENT` (default 2) bounds concurrent interactive `claude` boots via a queuing semaphore (`lib/tui/semaphore.mjs`); the slot is released on throw so honesty-gate / spawn failures never leak it; bounded wait-queue → `tui_queue_full` (503). Independent of the global `MAX_CONCURRENT` (8) — a TUI turn is a heavy per-request cold-boot of tmux+claude + up to 120s wallclock.
- **Observability** — additive `/health` `tui` block (`enabled` / `entrypointMode` / `lastEntrypoint` / `entrypointMismatches` / `inflight` / `maxConcurrent`) so an operator can poll for a silent `sdk-cli` metered-pool drift (the audit's top risk) instead of grepping journald. Authorized by the ADR 0007 PR-B amendment under the ALIGNMENT grandfather provision (additive, behaviour-preserving — every pre-existing `/health` field unchanged).

### Operations (#138)

- `docs/runbooks/615-canary.md` — the 2026-06-15 credit-balance canary: quiesce, read the Agent SDK credit balance (manual — no programmatic API exists for that pool; OCP's `/usage` headers are subscription rate-limit data, not the credit pool), one TUI canary turn, confirm `entrypoint:cli` in the transcript, green/red decision tree, periodic auto-mode self-classification mini-canary.
- `docs/runbooks/tui-flip-rollback.md` — flip/rollback per deployment (systemd `daemon-reload`; launchd `bootout`/`bootstrap`, not `kickstart -k`).
- `setup.mjs` auth quick-test gated behind `OCP_SKIP_AUTH_TEST=1` (the `claude -p` probe draws from the metered Agent SDK pool after 6/15).

### New environment variables

- `OCP_TUI_MAX_CONCURRENT` — max concurrent interactive TUI turns (default 2) (#139).
- `OCP_SKIP_AUTH_TEST` — skip the `claude -p` auth probe in `setup.mjs` (default off) (#138).

## v3.19.0 — 2026-06-02

TUI-mode reliability + proxy-purity release. Two fixes diagnosed and verified live on both test hosts (PI231 / Oracle, claude 2.1.104 / 2.1.114), each its own PR with a fresh-context reviewer (Iron Rule 10), then an adversarial multi-host test battery (0 hangs / 0 crashes / 0 injection / 0 leaks). The default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI

- **#130** — Fixed the "stuck typing" hang on large multi-line prompts. Three root causes: (1) terminal-turn detection only recognized `{system, turn_duration}`, which older claude builds (e.g. 2.1.114) don't emit → the reader ran to the wallclock and returned partial text; now also accepts an `assistant` line with a final `stop_reason` (`end_turn`/`stop_sequence`/`max_tokens`), while `tool_use` stays non-terminal. (2) Large prompts pasted via `send-keys -l` delivered embedded newlines as separate Enter events → the prompt never landed; now uses `tmux load-buffer` + `paste-buffer -p` (bracketed paste, atomic). (3) The paste-landed check false-positived on claude's empty curly-quote placeholder → Enter fired into an empty box; now positive-signal-only (`[Pasted text]` / prompt text) with a readiness/paste-verify poll + fast-fail (deterministic ~5s error instead of a 120s wallclock hang).
- **#4** — TUI-mode never injects the host's `CLAUDE.md` / auto-memory into proxied turns. OCP is a proxy: the proxied client (OpenClaw / an IDE) owns its own context and memory. `buildTuiCmd` now always sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (unconditional — proxy purity is not an opt-in). Verified live with a marker `CLAUDE.md`: obeyed by the proxied turn before the fix, blocked after, on both hosts. Residual host-context vectors (managed-policy / `settings.json` / output-styles) tracked in #133. The env is delivered via an `env`-prefix on the tmux pane command (tmux does not forward the spawning process's environment, and `new-session -e` requires tmux ≥3.2 while the cloud host runs 2.7).

## v3.18.0 — 2026-06-01

Hardening release from a multi-agent code audit (1 P0 + 14 P2 + 2 P3 findings, each adversarially verified and independently reviewed) plus three follow-ups (#123–#125). Every change shipped as its own PR with a fresh-context reviewer (Iron Rule 10). The single-user default path (`AUTH_MODE=none`, no TUI) is behavior-identical **except** the `/health` change in #109.

### Security

- **#109 (P0)** — `/health` no longer advertises `PROXY_ANONYMOUS_KEY` to remote callers by default. The `anonymousKey` field is gated behind a new `PROXY_ADVERTISE_ANON_KEY=1` opt-in env var; localhost callers are always exempt. Prevents any LAN-reachable device from harvesting a working, quota-spending bearer credential from the unauthenticated `/health` endpoint. **Behavior change:** `ocp-connect` zero-config Path A now requires the server to set `PROXY_ADVERTISE_ANON_KEY=1`; otherwise pass `--key` or use anonymous access.
- **#114** — Dashboard escapes all DB-sourced strings (key names, usage rows) before `innerHTML`; the revoke button uses a `data-` attribute + listener instead of an inline `onclick` a quote could break out of; `POST /api/keys` validates key names server-side (`[A-Za-z0-9 ._-]{1,64}`).
- **#124** — Dashboard status/plan summary cards escaped too (uniform defense-in-depth over all `innerHTML` sinks).
- **#111** — Streaming error paths strip filesystem paths from claude error text / stderr before sending them to clients (`sanitizeError`), matching the non-streaming path.

### Reliability / correctness

- **#110** — Non-array `messages` is rejected with a 400 (was silently hanging the connection until socket timeout); OpenAI array `content` is flattened into the prompt instead of dumped as raw JSON; a streamed upstream error now emits an SSE `error` frame instead of a success-looking `finish_reason:"stop"`.
- **#111** — `res.on("close")` escalates SIGTERM→SIGKILL on client disconnect (closes a narrow re-occurrence of the #37 concurrency-slot leak on the hottest exit path); `overallTimer` is cleared on semantic completion so a slow-exiting child can't record a spurious post-success timeout; per-key quota is documented as best-effort (bounded overshoot ≤ `MAX_CONCURRENT`, cache hits uncounted).
- **#113** — CLI/installer hardening: `ocp-plugin` restart uses the live uid + `dev.ocp.proxy`/`ocp-proxy` labels and drops the unsafe `pkill` fallback; `ocp-connect` quotes + `chmod 600`s the persisted key; `setup.mjs` XML-escapes and newline-validates injected service-unit secrets.

### Alignment / governance

- **#112** — OAuth token-refresh host (`platform.claude.com/v1/oauth/token`) re-verified against the compiled cli.js v2.1.154 (`strings`, no live probe) and recorded in `ALIGNMENT.md`; usage-probe and default request model now derive from `models.json` (ADR 0003 SPOT) instead of hardcoded IDs.
- **#123** — The legacy `console.anthropic.com/v1/oauth/token` host is pinned in the `alignment.yml` blacklist so a future OAuth-host drift hard-fails CI; the blacklist now documents its dual purpose (known hallucinations + pinned wrong-host variants of a verified Class A endpoint).

### TUI

- **#115** — The TUI LAN gate refuses any non-loopback bind (not just literal `0.0.0.0`); the achieved `cc_entrypoint` is asserted each turn and a `tui_entrypoint_mismatch` warning is logged on a silent degrade to the metered sdk-cli pool.

### Refactor

- **#125** — `isLoopbackBind` extracted to `lib/net.mjs`, shared by `server.mjs` and the test suite (was duplicated via a copy-paste mirror).

### New environment variables

- `PROXY_ADVERTISE_ANON_KEY` — opt-in (default off); advertise `PROXY_ANONYMOUS_KEY` on the public `/health` body for remote zero-config discovery (#109).

## v3.17.1 — 2026-05-31

### Fix — code-audit P1/P2 hardening

Fixes from a multi-agent code audit (3 P1 + 5 P2, adversarially verified). The single-user default path (`AUTH_MODE=none`, no TUI) is behavior-identical.

**Availability / correctness (P1):**
- Guard `proc.stdin` against EPIPE — a fast-failing spawned `claude` (auth error, bad model, large prompt) no longer crashes the single-process daemon.
- Add `unhandledRejection`/`uncaughtException`/`clientError` safety nets + wrap all request-body read loops — a client aborting mid-upload no longer crashes the daemon.
- TUI transcript reader: only `turn_duration` is terminal (was also `tool_use`), which silently truncated any TUI turn that used a built-in tool.

**Security gates / cache integrity (P2):**
- `AUTH_MODE=multi`: the default spawn now passes `--disallowedTools` (Bash/Read/Write/Edit/…) so a guest prompt cannot drive operator-filesystem tools. Single-user path unchanged.
- `/sessions` (DELETE), `/settings` (PATCH), `/logs`, `/usage`, `/status` are now admin-gated (were dispatched before the admin check).
- Streaming path no longer caches an `is_error` response as success (cache-poisoning fix).
- TUI fail-loud guard extended to `none`+`0.0.0.0` (unless `OCP_TUI_ALLOW_LAN=1`) and `+ PROXY_ANONYMOUS_KEY`.
- TUI `send-keys` paste uses `-l` (literal) so a prompt equal to a tmux key token (e.g. `C-c`) is typed, not interpreted.

---

## v3.17.0 — 2026-05-31

### Provider — default claude invocation ported to stream-json + `--system-prompt` (Phase 6c)

OCP's default (non-TUI) claude spawn moves from `claude -p --output-format text` to `claude --output-format stream-json --verbose --no-session-persistence --system-prompt <wrapper>` (no `-p`). The NDJSON event stream is parsed into the assembled response. Benefits: ~64% per-request cost reduction and anti-hallucination via `--system-prompt` tool-use suppression. Clients see no API change — the OpenAI-compatible request/response shapes are identical. Faithful port of OLP's production-verified implementation; covered by 17 new stream-json parser tests.

⚠️ **Billing note:** from 2026-06-15 this default path carries `cc_entrypoint=sdk-cli` and bills against the Agent SDK credit pool. Use the new opt-in `CLAUDE_TUI_MODE` (below) to keep traffic on the Pro/Max subscription pool.

---

### feat(tui): opt-in CLAUDE_TUI_MODE — serve via interactive claude (cc_entrypoint=cli / subscription pool), single-user only; default stream-json path unchanged

From 2026-06-15 Anthropic routes `claude -p` / `--output-format` invocations to the Agent SDK credit pool (`cc_entrypoint=sdk-cli`). This feature adds an opt-in bridge: when `CLAUDE_TUI_MODE=true`, OCP serves each request via a real interactive `claude` session (no `-p`, no `--output-format`) so it carries `cc_entrypoint=cli` and bills against the Pro/Max subscription.

The complete string response is read from claude's native JSONL session transcript and replayed to callers as a normal OpenAI completion or chunked SSE. Clients see no API change. The default stream-json path is byte-for-byte unchanged when `CLAUDE_TUI_MODE` is unset.

**Security:** single-user / single-operator only. Never enable on a multi-user OCP. See ADR 0007 and README § "Subscription-pool (TUI) mode".

New env vars: `CLAUDE_TUI_MODE`, `CLAUDE_TUI_WALLCLOCK_MS`, `OCP_TUI_CWD`, `OCP_TUI_HOME`.
New ADR: `docs/adr/0007-tui-interactive-mode.md`.
New modules: `lib/tui/transcript.mjs`, `lib/tui/session.mjs` (shipped in preceding commits on this branch).

---

### Model — add claude-opus-4-8

Add `claude-opus-4-8` as the newest Opus to `models.json` (index 0, newest first). Repoint `aliases.opus` from `claude-opus-4-7` to `claude-opus-4-8`. `claude-opus-4-7` remains in the list callable by literal id. `legacyAliases.claude-opus-4` left pointing at `claude-opus-4-7` (no change — legacy alias tracks the prior generation). README Available Models table and model-count references updated accordingly.

---

## v3.16.4 — 2026-05-13

### Refactor — port-literal SPOT + CI guardrail

Closes the structural side of the port-drift cascade addressed by v3.16.2
and v3.16.3. Those two releases reverted plist / plugin / scripts back to
3456 line-by-line, but the underlying invitation to drift — a hardcoded
port literal scattered across six source files — was still intact.

Changes:

- **New `lib/constants.mjs`** — single source of truth for shared literals.
  Exports `DEFAULT_PORT = 3456`, `LOCAL_HOST = "127.0.0.1"`,
  `OPENAI_API_BASE = "/v1"`, `LOCAL_PROXY_URL`.
- **`server.mjs:127`, `setup.mjs:36`, `scripts/upgrade.mjs:137`,
  `scripts/doctor.mjs:84` + `:205`, `scripts/sync-openclaw.mjs:73`** —
  all replaced with imports from `lib/constants.mjs`. Behavior is
  identical; the literal `3456` now exists in exactly one place per
  language (`lib/constants.mjs` for `.mjs`, `ocp` + `ocp-connect` for
  bash, `test-features.mjs` for pinned historical-port tests).
- **`.github/workflows/alignment.yml`** — extended the path filter to
  `setup.mjs`, `scripts/**`, `lib/**`, `ocp`, `ocp-connect`. Added a new
  `port-spot` hard-fail job that greps for any hardcoded `3478` or `3456`
  literal in `.mjs/.js/.ts/.json` outside the EXEMPT_REGEX (which lists
  `lib/constants.mjs`, `test-features.mjs`, the bash CLIs, docs, and the
  workflow itself). Any future PR re-introducing a hardcoded port
  literal will be blocked at CI before it can cascade.
- Doc comments in `server.mjs` env-var summary and `setup.mjs` usage
  banner reworded so the literal `3456` no longer appears as
  documentation text (CI grep is intentionally aggressive — it does not
  parse comments — so doc strings reference `DEFAULT_PORT from
  lib/constants.mjs` instead).

No behavior change for any user. `CLAUDE_PROXY_PORT` env var remains
the runtime override; the only difference is the unset-env fallback
now flows through one shared constant.

ALIGNMENT.md hard-requirements: this PR modifies `server.mjs` (one-line
import + one literal swap, mechanical). No cli.js operation changed;
the citation requirement does not apply. SPOT principle (Rule 2 spirit)
is the entire motivation.

## v3.16.3 — 2026-05-13

### Fixes — completes v3.16.2 port-drift revert

v3.16.2 reverted the plugin / `openclaw.plugin.json` / README / Mac mini
plist back to `3456` (the historical source default since `593d0dc`), but
missed three places in `scripts/` that still defaulted to `3478`. Those
three lines were the residual cascade source: every time `ocp doctor` or
`ocp upgrade` ran without `CLAUDE_PROXY_PORT` in the env, they probed
`3478`, reported "OCP not responding" against a healthy 3456 instance,
and (in the case of OpenClaw sync follow-ups on the maintainer's host)
re-introduced 3478 into downstream config.

Changes:

- `scripts/upgrade.mjs:137` — default port `3478` → `3456`.
- `scripts/doctor.mjs:84` — default port `3478` → `3456`.
- `scripts/doctor.mjs:205` — default port `3478` → `3456`.

No behavior change for users who set `CLAUDE_PROXY_PORT` explicitly; env
still takes precedence. The fix only affects the unset-env fallback,
which now matches `server.mjs:126` and the rest of the codebase.

Test plan: existing `test-features.mjs` cases that pin
`CLAUDE_PROXY_PORT=3478` continue to pass — they use the env path, not
the default.

## v3.16.2 — 2026-05-12

### Fixes — corrects v3.16.1

The v3.16.1 fix was directionally correct (plugin now reads env first, falls back to a hardcoded default) but **the narrative and the hardcoded default were both wrong**.

What v3.16.1 said: "OCP server moved to 3478 default in v3.14+; plugin lagged at 3456."
What is actually true:
- **OCP server source default has been `3456` since `593d0dc` (initial release) and has never changed.** Every line in `server.mjs`, `setup.mjs`, and the `ocp` CLI still uses `3456` as the documented and code-level default.
- The single OCP installation observed on `3478` is the maintainer's Mac mini, whose plist was rewritten with `--port 3478` during a PR #71 dogfood smoke-test accident on 2026-05-08 (see `~/.cc-rules/memory/learnings/subagent_setup_mjs_prod_host_collision.md`). The plist drift was never reconciled back to source default, and v3.16.1 incorrectly canonised the post-accident value as if it had been a release decision.

This release:
- Restores the plugin fallback to `http://127.0.0.1:3456` to match server source default.
- Updates `openclaw.plugin.json` `configSchema.proxyUrl.default` back to `3456`.
- Restores README §"Environment Variables" `CLAUDE_PROXY_PORT` default to `3456`.
- Plugin reads `OCP_PROXY_URL` env (full URL) first, then `CLAUDE_PROXY_PORT` env (port only), then falls back to `3456`. Hosts whose OCP plist injects a non-default port must also inject the same `CLAUDE_PROXY_PORT` into the OpenClaw plist for the plugin to follow.
- Maintainer's Mac mini plist was reverted from `3478` to `3456` as part of this release deploy (no source change reflects this; it was a one-host correction).

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.

## v3.16.1 — 2026-05-12 (superseded — narrative incorrect; see v3.16.2 erratum)

### Fixes (as shipped — note erratum above)

- **OCP plugin port lag** — `ocp-plugin/index.js` hard-coded `http://127.0.0.1:3456`. ~~While OCP server moved to 3478 in v3.14+,~~ **(corrected v3.16.2: no such move ever happened.)** The Mac mini's plist was on `3478` only as residue from a dogfood accident. Result: `/ocp` slash commands from the home Telegram bot returned "OCP error: fetch failed". v3.16.1 changed the plugin default to `3478` (wrong direction; v3.16.2 reverts to `3456`).

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.

## v3.16.0 — 2026-05-10

### Features

- **`ocp doctor --check oauth`** (PR #93) — fast path that runs only the OAuth check, skipping
  version detection / from-version / git operations / models endpoint. ~50ms vs. full doctor's
  ~200-500ms. Use cases: AI agent repair loops, post-`claude auth login` verify, quick health
  gates. Help text in `cmd_doctor_help` now reflects working behaviour.
- **`ocp update --rollback --gc`** — manually garbage-collect old upgrade snapshots.
  Retention policy: keep last 5 snapshots OR snapshots newer than 30 days OR the single most
  recent (always-keep safety net). `--dry-run` previews. Successful `ocp update` runs auto-GC
  at the end of the full path; light path does not (no snapshot created there).

### Behavior changes

- After a successful cross-minor `ocp update`, the auto-GC emits `[gc] removed N old snapshots`
  to stderr if any were collected. Safe to ignore; manual gc is `ocp update --rollback --gc`.

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.
- PR #93 (--check oauth) merged separately; this release bundles it with the GC feature.

## v3.15.1 — 2026-05-10

### Fixes

- **doctor: dynamic `latest_version` from `origin/main:package.json`** — v3.15.0 doctor used a hard-coded `latest = "v3.14.0"` fallback, which made any v3.15.0+ install report `kind = upgrade` (against a stale value). `ocp update` would then attempt `git checkout v3.14.0` — a downgrade. Doctor now fetches `git -C ~/ocp show origin/main:package.json` to determine the actual latest version; on failure (offline, fresh clone with no remote), falls back to `currentVersion` so `kind = noop` instead of recommending a downgrade.

## v3.15.0 — 2026-05-10

### Features

- **`ocp doctor`** — health & upgrade-readiness check; primary entry for AI-driven debugging.
  `--json` mode emits a `next_action` with `ai_executable[]` for agents to run verbatim
  and `human_required[]` for steps requiring the user (typically only OAuth).
- **`ocp update` cross-version path** — for cross-minor jumps (e.g. v3.10 → v3.14),
  `ocp update` now runs doctor → snapshot → `setup.mjs` (with the plist env-merge from
  PR #90) → service restart → post-flight `/health` + `/v1/models` verification.
  Same-patch updates retain the existing light path; users see no change for routine
  patch bumps.
- **`ocp update --rollback`** — restore the most recent (or specified) upgrade snapshot.
  Snapshots are saved to `~/.ocp/upgrade-snapshot-<ISO-ts>/` and never auto-deleted.
- **Fresh-install routing** — `ocp update` on installations < v3.4.0 routes to a fresh-install
  flow (with `--yes` to skip confirmation; AI agents pass this). OAuth survives via Claude
  Code's credential store; users do not re-OAuth unless their token was independently broken.
- **AI prompt blocks in README** — §Installation, §Upgrading, and §Troubleshooting each
  start with a copy-paste prompt for Claude Code / Cursor / Copilot, so users can drive
  install / setup / upgrade through their existing AI assistant.

### Behavior changes

- `ocp update` may take 10–30s longer when a cross-minor jump triggers the full path
  (snapshot + post-flight). Patch bumps are unchanged.
- Pre-v3.4.0 installs are routed to fresh-install rather than failing silently or
  half-migrating.

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.
- Depends on PR #90 (plist env merge bug fix; merged before this release).

## v3.14.0 — 2026-05-10

### Features (security hardening)

- **Per-key session isolation** (PR #86, S1) — the `sessions` Map in `server.mjs` is now keyed by `${keyName}|${conversationId}` instead of bare `conversationId`. Before this fix, two clients using distinct API keys but the same `session_id` value (e.g. both defaulting to `"default"`) would share the same `cli.js` subprocess and conversation history, creating a cross-tenant leak path. Post-fix each (key, session) pair is isolated end-to-end, extending the per-key cache isolation shipped in v3.13.0 D1 to the session layer.
- **On-disk credential file modes 0700/0600** (PR #87, S2) — `setup.mjs` now creates `~/.ocp` at mode 0700 and both `admin-key` and `ocp.db` at mode 0600. An idempotent `reconcileFileModes()` call in `server.mjs` startup tightens any existing installation to these modes automatically on every launch, so existing prod boxes fix themselves without manual `chmod`. Before this fix, all three files were created at the process's default umask (typically world-readable 0644 / 0755), leaving plaintext credentials readable by other local users.
- **`/api/usage` default scope = self; admin all-keys requires `?all=true`** (PR #88, S3) — the usage endpoint now applies a least-privilege default: anonymous callers receive only their own rows, non-admin authenticated callers receive only their own rows, and admin callers receive only their own rows unless they explicitly pass `?all=true`. When `?all=true` is used, an audit log line is emitted. Before this fix, any admin-token holder could silently enumerate usage data for every key on the server.

### Behavior changes

- **Breaking change for admin tooling**: `/api/usage` no longer returns all-keys data by default. Existing cron jobs, dashboards, or scripts that rely on the admin token seeing all-keys output must add `?all=true` to their request URL after upgrading to v3.14.0.
- **File mode reconcile at server startup** logs a one-line notice per path when mode is tightened (e.g. `[security] tightened ~/.ocp/ocp.db → 0600`). No action is required from the operator; the reconcile is idempotent and silent when modes are already correct.
- **`sessions` Map key is now `${keyName}|${conversationId}` internally.** No client-visible wire change — the `session_id` field in request/response is unchanged.

### Verification

- Stress-test pass: 11/11 phases including S1/S2/S3 security regression checks (Phase E, I, J). 35-minute sustained run, 60 calls, 0 errors, 0 timeouts. RSS dropped 51→47 MB across the window. Per-key cache isolation, singleflight, cache_control bypass, quota enforcement, file-mode reconcile, and scope guard against escalation all verified against running code.

### Governance

- All three PRs (#86, #87, #88) include the explicit `cli.js`-citation-not-applicable disclaimer (per PR #75 pattern) since they are OCP-internal access-control, session-state, and file-permission changes with no corresponding `cli.js` operation to cite.

### No new env vars / no public API surface change beyond the documented breaking change

This release adds no new env vars or endpoints. The only externally visible change is the `/api/usage` scope guard (breaking for admin all-keys consumers; see Behavior changes above).

## v3.13.0 — 2026-05-07

### Features (cache layer hardening)

- **Per-key cache isolation** (D1) — the cache key now includes the API key id, so distinct keys never share cache entries. Anonymous/unauthenticated callers share one `anon` pool. Hash format upgraded to `v2`; legacy v1-format rows orphan and are reaped by the existing TTL cleanup interval (no migration script).
- **`cache_control` bypass** (D2) — when a request carries an Anthropic `cache_control` annotation (top-level or nested in a content array), OCP skips its own cache entirely. The caller is using Anthropic-side prompt caching deliberately, and OCP must not interfere. A `cache_skipped{reason: cache_control_present}` log line is emitted on bypass.
- **Chunked stream replay** (D3) — when a streaming request hits the cache, the cached content is now emitted as multiple SSE chunks (80 codepoints/chunk, codepoint-safe via `Array.from()`) instead of a single large delta. Multibyte characters (CJK / emoji) stay intact.
- **Singleflight stampede protection** (D4) — concurrent identical cache-miss requests now share one upstream `cli.js` spawn instead of spawning N processes. Followers receive byte-identical responses to what the leader returns. All-or-nothing failure semantics: if the leader errors, all followers receive the same error. Streaming-path singleflight is explicitly out of scope (TODO left for follow-up).

### Behavior changes

- `/cache/stats` response now includes additive fields `inflight` and `requesters` (current in-flight singleflight entries and total waiting callers). Existing fields `entries`, `totalHits`, `sizeBytes` are preserved unchanged.

### Governance

- New ADR [`docs/adr/0005-no-multi-provider.md`](docs/adr/0005-no-multi-provider.md): OCP stays single-provider (Anthropic via `cli.js` spawn). Multi-provider gateway refactor explicitly out of scope; cache improvements are explicitly in scope.
- Design spec for this release: [`docs/superpowers/specs/2026-05-07-cache-upgrade-design.md`](docs/superpowers/specs/2026-05-07-cache-upgrade-design.md).

### No new env vars / no public API surface change

This release adds no new env vars or endpoints. All four improvements are internal correctness/concurrency upgrades to the existing `CLAUDE_CACHE_TTL`-gated cache layer. No client-observable wire shape change.

## v3.12.0 — 2026-04-25

### Features

- **Streaming heartbeat** — opt-in SSE comment frame (`: keepalive\n\n`) emitted during silent windows on the streaming response. Controlled by `CLAUDE_HEARTBEAT_INTERVAL` env var (ms; `0` = disabled, default). Covers both pre-first-byte and mid-stream tool-use pauses. Addresses #47. See [design doc](docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md).
- **`X-Accel-Buffering: no`** response header added to SSE responses so heartbeats survive nginx/Cloudflare default buffering.

### Behavior changes

- SSE headers are now sent immediately after the claude CLI spawns successfully, not on first stdout byte. The rare "spawn succeeded but subprocess died before any byte" path now closes the SSE stream cleanly rather than returning a JSON error.

### Config additions

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` (disabled) | Interval in ms for SSE keepalive comment frames on streaming path. Resets on every real frame. |

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
