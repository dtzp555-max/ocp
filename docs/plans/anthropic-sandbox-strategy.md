# OCP Anthropic-Only Sandbox Strategy — Handoff Document

**Status:** Forward-looking planning doc (not yet a decision)
**Date:** 2026-05-29
**Audience:** future OCP maintainer / session picking up multi-tenant security work
**Provenance:** authored during OLP Phase 7 PR-B re-evaluation; OLP's parallel analysis (multi-provider) lives at `dtzp555-max/olp` `docs/adr/0014-sandbox-runtime-integration.md` Amendment 1 (pending). This OCP-side doc strips the multi-LLM generalization and keeps only what applies to OCP's single-provider (anthropic) deployment.

---

## 1. Why this doc exists

OCP is in maintenance mode (per OLP ADR 0001 supersession of OCP ADR 0005). It is not under active development for new features. However, two things may eventually drive sandbox work in OCP:

1. **Multi-key OCP deployments.** `OCP_OWNER_TOKEN` + per-key cache namespace already shipped (OCP `lib/keys.mjs`). If multiple human users share an OCP instance, the same multi-tenant filesystem-isolation gap that motivated OLP Phase 7 also exists here.
2. **Cloud or shared-host OCP deployments.** Any deployment beyond "single user on their own machine" inherits the threat surface.

If/when that work starts, this doc is the prior-art capture so the maintainer doesn't repeat OLP's PR-B path (which has a documented dead-end — see § 3.2 below).

This doc is anthropic-only by design — codex/mistral/etc. multi-LLM concerns are out of scope per OCP ADR 0005.

---

## 2. The multi-tenant gap (OCP-specific)

OCP spawns `claude -p` as the OCP-process user. Every spawned claude instance runs with the OCP user's filesystem permissions. Consequences for a multi-key OCP deployment:

1. **Cross-key lateral read.** A prompt-injected `cat ~/.ocp/keys/<other-key>.json` reads any other key's manifest (token hash, owner_tier, providers_enabled — not catastrophic since it's only the *hash*, but still identity-attribution surface).
2. **OAuth credential exposure.** `~/.claude/.credentials.json` is the Anthropic OAuth refresh token. A prompt-injected read of this file = stealing the subscription that OCP exists to pool.
3. **SSH identity exposure.** `~/.ssh/id_*` reachable for lateral movement to other hosts the OCP user can reach.
4. **Other host secrets.** Anything else under the OCP user's home is reachable.

OCP's `ALIGNMENT.md` Class A/B endpoint discipline does not address this — that discipline is wire-level honesty (`cli.js` mirror), not host-level isolation.

The threat model assumes prompt-injection capability — any caller with a valid OCP key + ability to craft a prompt that elicits a tool call. Default `claude -p` mode includes Read/Bash/etc. tool descriptions in the system prompt; the model is **eager** to use them.

---

## 3. Why OLP Phase 7 PR-B is the wrong path to copy

OLP attempted to wrap `claude -p` spawn in `@anthropic-ai/sandbox-runtime` (outer bubblewrap on Linux, sandbox-exec on macOS). This produced four binding problems documented during OLP's re-evaluation:

### 3.1 Anthropic's design doesn't expect external sandboxing

Per Anthropic's [engineering blog on Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), `sandbox-runtime` is designed to be invoked **by claude code itself** to sandbox **its own** Bash tool / MCP servers / spawn children. It is **not** designed to sandbox claude code as an externally-wrapped process.

Concretely: claude CLI assumes it can freely read+write its own `$HOME`-derived paths (`~/.claude.json`, `~/.claude/.credentials.json`, `~/.config/claude/`, future state files). When wrapped in `bwrap --ro-bind / /`, those writes hit `EROFS` and claude silently exits with no stdout.

### 3.2 `~/.claude.json` upstream status is "closed not planned"

claude CLI writes `~/.claude.json` non-atomically at startup. Upstream issues #28842, #29162, #29217, #28837, #29051, #29250, #7243 all document this. **#29250 is closed as "not planned / duplicate"** — Anthropic is not going to make this file atomic-write because their mental model is that claude runs in an environment that can write its `$HOME`.

For OCP, this means: any outer-sandbox approach that uses `--ro-bind` on `$HOME` will be a **permanent maintenance treadmill** — every new claude CLI version that adds a state file outside the patched mount paths breaks OCP. OLP's PR-B fold-in tried to patch this by promoting `~/.claude/` to rw, which was insufficient (the actual file is `~/.claude.json` at $HOME root, not inside `~/.claude/`).

### 3.3 The threat model doesn't justify the cost

OCP is, per ADR 0005, a personal-and-family-scale tool. The realistic threat surface is misbehaving prompts from family members or self-injected via dependent agents, not adversarial external attackers. The blast radius of a successful cross-key read is bounded (token *hash*, OAuth that's pooled-by-design across all OCP keys).

A maintenance-mode project investing weeks into outer-sandboxing for a hypothetical threat is a poor cost/benefit. There are cheaper architectures (§ 4 below) that get most of the protection.

### 3.4 OLP-specific reason that does NOT apply to OCP

OLP also hit a multi-provider conflict: codex CLI has its own inner bubblewrap that breaks when wrapped in an outer bwrap (openai/codex#16018). **This is not an OCP concern** — OCP only spawns claude. So the multi-provider forcing function for OLP doesn't apply here. The other three reasons (§ 3.1–3.3) are sufficient on their own.

---

## 4. Three viable approaches for OCP

Ranked by "engineering cost vs isolation strength" — pick by deployment context.

### 4.1 Approach A — Ephemeral `$HOME` via env var (recommended starting point)

Per-spawn setup:

```
ephemeralRoot=/tmp/ocp-spawn/<keyId>/<reqId>/home
mkdir -p $ephemeralRoot/.claude
ln -s ~/.claude/.credentials.json $ephemeralRoot/.claude/.credentials.json
HOME=$ephemeralRoot claude -p --output-format stream-json ...
```

Mechanics:
- claude CLI uses Node's `os.homedir()` which reads `$HOME` env first.
- `~/.claude.json` written by claude on startup → lands in `/tmp/ocp-spawn/<keyId>/<reqId>/home/.claude.json` (tmpfs, discarded after spawn).
- `~/.claude/.credentials.json` is the OAuth file claude needs — symlinked in read-only from the real one.
- Any new state file claude CLI introduces in a future version → also lands in the ephemeral home, no patch needed.

Threat coverage:
- ✅ Solves EROFS upgrade tax permanently — any claude state-file location works because they all land in tmpfs.
- ✅ Cross-key OAuth credential isolation — keyA's ephemeral home has only keyA's symlink, but here the symlink target is the SAME real file because OCP shares OAuth (this is fine: shared OAuth is OCP's design, the symlink just keeps the file inaccessible via `cat ~/.claude/.credentials.json` from a different keyId's ephemeral root).
- ❌ Does NOT solve cross-key lateral filesystem read via absolute paths. A prompt-injected `cat /home/<ocp-user>/.ocp/keys/<otherKey>.json` still works — `os.homedir()` override doesn't affect absolute-path reads.

5-minute spike before adopting:

```bash
HOME=/tmp/fake-home-spike claude --print "echo PONG" --no-session-persistence 2>&1
ls -la /tmp/fake-home-spike  # expect: .claude.json + .claude/ created here
find ~/.claude ~/.claude.json -newer /tmp/spike-marker 2>/dev/null  # expect: empty
```

If claude falls back to `os.userInfo().homedir` (uses getpwuid_r, ignores HOME env), this approach degrades — fall back to Approach B.

**Engineering cost:** ~50 LOC in OCP's spawn pipeline (mkdir + symlink + env merge + cleanup-on-exit). No new dependencies.

### 4.2 Approach B — Outer bubblewrap with `--tmpfs $HOME` + `--ro-bind` credentials

```
bwrap \
  --ro-bind / / \
  --tmpfs /home/<ocp-user> \
  --ro-bind /home/<ocp-user>/.claude/.credentials.json /home/<ocp-user>/.claude/.credentials.json \
  --ro-bind /home/<ocp-user>/.ocp/keys/<thisKeyId>.json /home/<ocp-user>/.ocp/keys/<thisKeyId>.json \
  --dev /dev --proc /proc --tmpfs /tmp \
  claude -p ...
```

This is the canonical bwrap pattern (Flatpak uses exactly this for every sandboxed app — see [Bubblewrap ArchWiki Examples](https://wiki.archlinux.org/title/Bubblewrap/Examples)).

Threat coverage:
- ✅ Solves EROFS upgrade tax (tmpfs accepts any write path).
- ✅ Cross-key lateral read prevention — only the current key's manifest is bind-mounted in, others are simply absent from the sandbox view.
- ✅ `~/.ssh` and similar identity material absent from sandbox.

Trade-offs:
- bwrap dependency: install `bubblewrap` apt package on host.
- Bypasses `@anthropic-ai/sandbox-runtime` library — direct bwrap arg composition. Worth it because sandbox-runtime's outer-wrap design is for short-lived claude-internal subprocesses, not long-running claude CLI itself (per § 3.1).
- macOS: not supported by bwrap (macOS would need separate `sandbox-exec` profile, ~50-100 LOC additional work). OCP cross-machine maintainer deploys mostly on Mac mini + Oracle ARM VM — both Linux on the cloud side, Mac mini side may remain unsandboxed if family-trust-zone.

**Engineering cost:** ~150 LOC for the spawn wrapper + deployment doc updates to require `apt install bubblewrap`. macOS support is a separate ~100 LOC if/when needed.

### 4.3 Approach C — OverlayFS lowerdir (read-only) + tmpfs upperdir (writable)

```
mount -t overlay overlay \
  -o lowerdir=/home/<ocp-user>/.claude,upperdir=/tmp/ocp-spawn/<reqId>/upper,workdir=/tmp/ocp-spawn/<reqId>/work \
  /tmp/ocp-spawn/<reqId>/merged-claude
HOME=/tmp/ocp-spawn/<reqId>/home claude -p ...
# After spawn: umount + rm -rf
```

Most elegant — claude sees a view identical to its real `~/.claude/`, all writes go to tmpfs upperdir, real `~/.claude/` is never touched.

Trade-offs:
- Requires `CAP_SYS_ADMIN` or rootless-overlayfs (kernel ≥5.11 + user-ns enabled). OCP currently runs as the maintainer's user — no SYS_ADMIN — so this would require either running OCP as root (bad) or rootless-overlayfs setup.
- More moving parts (mount/umount per spawn, work-dir lifetime, cleanup-on-crash).

Better fit if OCP ever moves to a dedicated `ocp` system user with `CAP_SYS_ADMIN` capability via systemd.

**Engineering cost:** ~120 LOC + kernel/permission preflight check.

---

## 5. Cross-key isolation orthogonal layer

The three approaches above all solve `~/.claude.json` EROFS + state-write isolation. None of them alone solve **cross-key lateral filesystem read via absolute paths** (e.g. prompt-injected `cat /home/<user>/.ocp/keys/<otherKey>.json`).

For that, two options compose with any of A/B/C:

### 5.1 Per-spawn `sandbox-runtime` customConfig with `denyRead`

`@anthropic-ai/sandbox-runtime`'s `wrapWithSandbox(command, binShell?, customConfig?, abortSignal?)` accepts per-call override:

```
const otherKeysWorkspaces = listAllKeyManifestsExcept(thisKeyId)
const wrapped = await SandboxManager.wrapWithSandbox(claudeCommand, undefined, {
  filesystem: {
    denyRead: [
      ...otherKeysWorkspaces,          // all keys except current
      '/home/<ocp-user>/.ssh',
      '/home/<ocp-user>/.gnupg',
      '/home/<ocp-user>/.aws',
    ],
    allowWrite: [ephemeralRoot, '/tmp'],
  },
})
```

This adds bwrap deny-paths per-spawn (after sandbox-runtime singleton init). Works in combination with Approach A (the `HOME` env-var override is independent of sandbox-runtime's restrictions).

Caveat: this re-introduces the outer-bwrap concern from § 3.1 — claude CLI is now wrapped after all. Mitigation: use this only for **cross-key isolation**, not for `$HOME` restriction. The `denyRead` paths are all outside `$HOME`, so claude's `~/.claude.json` write is unaffected.

### 5.2 Per-OS-user OCP spawning

Each OCP key gets a dedicated Linux user (`ocp-<keyId>`). Spawn claude as that user via `runuser` or `sudo -u`. OAuth credential shared via Linux group permissions or bind-mount.

True kernel-level uid isolation. Most robust answer for OCP-as-shared-host scenarios.

Trade-offs:
- Setup script complexity (one-time per key).
- Linux-only.
- Doesn't fit Mac mini deployment.

Best fit for a cloud OCP deployment where per-tenant trust isolation matters.

---

## 6. Trust model framing

OCP's authentication layer (`lib/keys.mjs`) provides **attribution** (per-key audit, per-key cache namespace). It does NOT, by itself, provide **isolation** (per-key trust boundary against prompt-injection lateral reads).

This distinction is worth making explicit in OCP's README "Security" section (it currently isn't). The three tiers:

| Tier | Trust Model | Sandbox requirement |
|---|---|---|
| **Single-user** | maintainer's own machine, single OCP token | None — system-user permissions are sufficient |
| **Family-trust-zone** | maintainer + family members on shared OCP instance, all parties trusted not to attack each other | Optional — Approach A (ephemeral $HOME) gives cleanup hygiene without changing trust assumptions |
| **Shared-host / cloud / external callers** | OCP keys handed to potentially-adversarial callers (CI runners, third-party agents, public demo) | Required — Approach B or C + § 5 cross-key isolation |

The current OCP deployment fits tier 1 or 2. The work in this doc applies only when promoting to tier 3.

---

## 7. Recommendation if/when this work starts

**Phase 1 — Approach A (ephemeral `$HOME`) only.**
- ~50 LOC, no apt deps, works on Mac mini + Linux
- Solves the EROFS upgrade tax structurally
- Closes cross-key OAuth-credential-file lateral read
- Cost-effective hygiene improvement

**Phase 2 — Approach B (outer bwrap) gated by deployment config.**
- Add `~/.ocp/config.json` field `security.sandbox: 'off' | 'tmpfs-home'`
- Default off (preserves Mac mini family deployment)
- Operator opts in on Linux cloud deployments
- Apt prereq documented in deployment guide

**Phase 3 — § 5 cross-key isolation (only if tier 3 deployment is planned).**
- Layer per-spawn customConfig denyRead OR per-OS-user spawning
- Treat as separate ADR amendment with its own threat-model evidence

**Skip Approach C** unless a future requirement forces overlay (low likelihood for OCP scope).

---

## 8. Authority citations

This doc claims findings about claude CLI / `@anthropic-ai/sandbox-runtime` behavior. Sources for verification:

- [Anthropic engineering — Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) (sandbox-runtime design intent)
- [Anthropic sandbox-runtime GitHub](https://github.com/anthropic-experimental/sandbox-runtime) (wrapWithSandbox API + customConfig per-call signature)
- [claude-code#29250 — `.claude.json` non-atomic-write closed-not-planned](https://github.com/anthropics/claude-code/issues/29250)
- [claude-code#29162 — read-only `~/.claude.json` startup hang](https://github.com/anthropics/claude-code/issues/29162)
- [claude-code#29217 — concurrent-write corruption](https://github.com/anthropics/claude-code/issues/29217)
- [claude-code#28842 — Windows startup race](https://github.com/anthropics/claude-code/issues/28842)
- [claude-code#7243 — "the .claude.json elephant in the room"](https://github.com/anthropics/claude-code/issues/7243)
- [Bubblewrap README](https://github.com/containers/bubblewrap)
- [Bubblewrap ArchWiki — Examples section, --tmpfs HOME pattern](https://wiki.archlinux.org/title/Bubblewrap/Examples)
- [Sandboxing CLI tools with Bubblewrap — botmonster](https://botmonster.com/self-hosting/sandbox-linux-apps-cli-tools-bubblewrap/)
- [OverlayFS kernel documentation](https://docs.kernel.org/filesystems/overlayfs.html)
- [OverlayFS ArchWiki](https://wiki.archlinux.org/title/Overlay_filesystem)

OLP's parallel work (multi-provider generalization of this strategy, including the codex inner-bwrap conflict that does not apply to OCP):

- `dtzp555-max/olp` `docs/adr/0014-sandbox-runtime-integration.md` (PR-B as-shipped) + Amendment 1 (pending — Solution 1 architecture)
- `dtzp555-max/olp` `docs/plans/cloud-deployment-family.md` § 5 (deployment-side trust tier mapping)
- archive branch `dtzp555-max/olp:phase-7-pr-b-outer-bwrap-snapshot` captures the outer-bwrap approach as snapshot if anyone wants to revisit it

---

## 9. What this doc is NOT

- Not an ADR. ADRs are decisions; this is a forward-facing strategy doc that becomes an ADR only when work starts and a decision is made.
- Not a binding spec. The three approaches are alternatives; the recommendation in § 7 is the maintainer's lean from prior-art analysis, not a constitution.
- Not authority for any code change. OCP `ALIGNMENT.md` still requires citation per Class A/B; no sandbox code lands without proper authority pinning when the work eventually starts.
- Not a security audit. The threat model is informal — based on prior-art search + incident memory from OLP's parallel session. A real cloud deployment should commission an independent threat model.

---

**Authors:** project maintainer (handoff prepared with AI drafting assistance during OLP Phase 7 PR-B re-evaluation, 2026-05-29).
