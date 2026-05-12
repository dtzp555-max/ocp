/**
 * OCP Plugin — registers /ocp as a native slash command in OpenClaw gateway.
 * Calls the local claude-proxy and formats the response.
 *
 * Port resolution (in priority order):
 *   1. OCP_PROXY_URL env (full URL, e.g. http://10.0.0.5:3456)
 *   2. CLAUDE_PROXY_PORT env (port only; localhost assumed)
 *   3. Fallback: http://127.0.0.1:3456 (OCP server source default since v1.0)
 *
 * If a particular host's OCP plist injects a non-default CLAUDE_PROXY_PORT,
 * the OpenClaw launchd plist for that host must also inject the same
 * CLAUDE_PROXY_PORT into the plugin's env, or the plugin will fall back to
 * 3456 and miss the server.
 */
const PROXY = process.env.OCP_PROXY_URL
  || (process.env.CLAUDE_PROXY_PORT ? `http://127.0.0.1:${process.env.CLAUDE_PROXY_PORT}` : "http://127.0.0.1:3456");

// Wrap output in monospace code block for Telegram/Discord alignment
function mono(text) { return "```\n" + text + "\n```"; }

async function fetchJSON(path) {
  const resp = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`proxy ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

function bar(pct, width = 16) {
  const filled = Math.round(pct * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
}

function fmtChars(c) {
  return c >= 1000 ? `${(c / 1000).toFixed(0)}K` : `${c}`;
}

// ── Subcommand handlers ─────────────────────────────────────────────────

async function cmdUsage() {
  const d = await fetchJSON("/usage");
  const plan = d.plan || {};
  const s = plan.currentSession || {};
  const w = plan.weeklyLimits?.allModels || {};
  const e = plan.extraUsage || {};
  const px = d.proxy;
  const models = d.models || {};

  let out = "";

  // Show subscription info if available
  if (plan.subscription) {
    out += `Plan: ${plan.subscription} (${plan.rateLimitTier || "default"})\n`;
  }

  if (s.utilization !== null && s.utilization !== undefined) {
    // Full plan usage data available (API key mode)
    out += "Plan Usage Limits\n";
    out += "─────────────────────────────\n";
    out += `Current session   ${bar(s.utilization)} ${s.percent}\n`;
    out += `                  Resets in ${s.resetsIn}  (${s.resetsAtHuman})\n\n`;
    out += `Weekly (all)      ${bar(w.utilization)} ${w.percent}\n`;
    out += `                  Resets in ${w.resetsIn}  (${w.resetsAtHuman})\n\n`;
    out += `Extra usage       ${e.status === "allowed" ? "on" : "off"}\n\n`;
  } else {
    // No API key — show note
    out += "Session/weekly %: claude.ai/settings\n";
    out += "(Anthropic OAuth API doesn't expose limits yet)\n\n";
  }

  const modelNames = Object.keys(models).sort();
  if (modelNames.length > 0) {
    out += "Model Stats\n";
    const hdr = `${"Model".padEnd(14)} ${"Req".padStart(4)} ${"OK".padStart(3)} ${"Er".padStart(3)} ${"AvgT".padStart(5)} ${"MaxT".padStart(5)} ${"AvgP".padStart(5)} ${"MaxP".padStart(5)}`;
    out += hdr + "\n";
    out += "─".repeat(hdr.length) + "\n";
    let total = 0;
    for (const name of modelNames) {
      const m = models[name];
      total += m.requests;
      const short = name.replace("claude-", "").replace("-4-5-20251001", "").replace("-4-6", "");
      out += `${short.padEnd(14)} ${String(m.requests).padStart(4)} ${String(m.successes).padStart(3)} ${String(m.errors).padStart(3)} ${fmtMs(m.avgElapsed).padStart(5)} ${fmtMs(m.maxElapsed).padStart(5)} ${fmtChars(m.avgPromptChars).padStart(5)} ${fmtChars(m.maxPromptChars).padStart(5)}\n`;
    }
    out += `${"Total".padEnd(14)} ${String(total).padStart(4)}\n`;
  }

  out += `\nProxy: up ${px.uptime} | ${px.totalRequests} reqs | ${px.errors} err | ${px.timeouts} timeout`;
  return out;
}

async function cmdHealth() {
  const d = await fetchJSON("/health");
  let out = `Status: ${d.status} | v${d.version}\n`;
  out += `Uptime: ${d.uptimeHuman}\n`;
  out += `Auth: ${d.auth?.ok ? "ok" : d.auth?.message || "unknown"}\n`;
  out += `Binary: ${d.claudeBinaryOk ? "ok" : "missing"}\n`;
  out += `Sessions: ${d.sessions?.length || 0} active\n`;
  out += `Requests: ${d.stats?.totalRequests || 0} total, ${d.stats?.activeRequests || 0} active\n`;
  out += `Errors: ${d.stats?.errors || 0} | Timeouts: ${d.stats?.timeouts || 0}\n`;
  if (d.recentErrors?.length) {
    out += "\nRecent errors:\n";
    for (const e of d.recentErrors.slice(-3)) {
      out += `  ${e.time?.slice(11, 19) || "?"} ${e.message}\n`;
    }
  }
  return out;
}

async function cmdStatus() {
  const d = await fetchJSON("/status");
  const icon = d.proxy?.status === "ok" ? "🟢" : d.proxy?.status === "degraded" ? "🟡" : "🔴";
  let out = `${icon} ${d.proxy?.status} | v${d.proxy?.version} | up ${d.proxy?.uptime} | auth ${d.proxy?.auth}\n`;
  out += `Sessions: ${d.proxy?.activeSessions || 0}\n`;
  out += `Requests: ${d.requests?.total || 0} | active ${d.requests?.active || 0} | err ${d.requests?.errors || 0} | timeout ${d.requests?.timeouts || 0}\n`;
  if (d.plan?.currentSession) {
    out += `\nSession: ${d.plan.currentSession.percent} (resets ${d.plan.currentSession.resetsIn})\n`;
    out += `Weekly:  ${d.plan.weeklyLimits?.allModels?.percent} (resets ${d.plan.weeklyLimits?.allModels?.resetsIn})`;
  }
  return out;
}

async function cmdSettings(args) {
  if (!args) {
    const d = await fetchJSON("/settings");
    let out = "OCP Settings\n─────────────────────────────\n";
    for (const k of ["timeout", "firstByteTimeout", "maxConcurrent", "sessionTTL", "maxPromptChars"]) {
      const v = d[k];
      if (v) out += `${k.padEnd(20)} ${String(v.value).padStart(8)} ${(v.unit || "").padEnd(6)} ${v.desc}\n`;
    }
    if (d.tiers) {
      out += "\nTimeout tiers:\n";
      for (const t of ["opus", "sonnet", "haiku"]) {
        const info = d.tiers[t];
        if (info) out += `  ${t.padEnd(8)} base=${info.base}ms  perChar=${info.perPromptChar}\n`;
      }
    }
    return out;
  }

  // Parse "key value"
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === "--help" || parts[0] === "-h") {
    return "Usage: /ocp settings <key> <value>\nKeys: timeout, firstByteTimeout, maxConcurrent, sessionTTL, maxPromptChars, tiers.opus.base, tiers.sonnet.base, tiers.haiku.base, tiers.*.perChar";
  }
  const [key, val] = parts;
  const numVal = Number(val);
  if (isNaN(numVal)) return `Error: value must be a number, got "${val}"`;

  const resp = await fetch(`${PROXY}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: numVal }),
    signal: AbortSignal.timeout(5000),
  });
  const d = await resp.json();
  if (d.errors?.length) return `✗ ${d.errors.join("; ")}`;
  return `✓ ${key} = ${numVal}`;
}

async function cmdModels() {
  const d = await fetchJSON("/v1/models");
  return (d.data || []).map((m) => `  ${m.id}`).join("\n") || "No models.";
}

async function cmdSessions() {
  const d = await fetchJSON("/sessions");
  if (!d.sessions?.length) return "No active sessions.";
  return d.sessions.map((s) => `  ${s.id.slice(0, 16)}… model=${s.model} msgs=${s.messages}`).join("\n");
}

async function cmdClear() {
  const resp = await fetch(`${PROXY}/sessions`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
  const d = await resp.json();
  return `Cleared ${d.cleared} sessions.`;
}

async function cmdVersion() {
  const d = await fetchJSON("/health");
  return `OCP v${d.version || "?"}\nUptime: ${d.uptimeHuman || "?"}\nNode: ${process.version}\nPlatform: ${process.platform} ${process.arch}`;
}

async function cmdTest() {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "say ok" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await resp.json();
    const elapsed = Date.now() - t0;
    if (d.choices?.[0]?.message?.content) {
      return `✓ Proxy OK (${elapsed}ms)\n  Model: haiku\n  Response: "${d.choices[0].message.content.slice(0, 50)}"`;
    }
    return `✗ Unexpected response: ${JSON.stringify(d).slice(0, 100)}`;
  } catch (e) {
    return `✗ Test failed (${Date.now() - t0}ms): ${e.message}`;
  }
}

async function cmdRestart(args) {
  const target = (args || "").trim().toLowerCase();
  const { execSync } = await import("node:child_process");
  try {
    if (target === "gateway") {
      execSync("launchctl kickstart -k gui/501/ai.openclaw.gateway", { timeout: 15000 });
      return "✓ Gateway restarted";
    } else if (target === "all") {
      execSync("launchctl kickstart -k gui/501/ai.openclaw.proxy", { timeout: 15000 });
      // Gateway restart will kill this plugin too, so do it last
      execSync("launchctl kickstart -k gui/501/ai.openclaw.gateway", { timeout: 15000 });
      return "✓ Proxy + Gateway restarted";
    } else {
      execSync("launchctl kickstart -k gui/501/ai.openclaw.proxy", { timeout: 15000 });
      return "✓ Proxy restarted";
    }
  } catch (e) {
    // Try systemd for Linux
    try {
      if (target === "gateway") {
        execSync("systemctl --user restart openclaw-gateway", { timeout: 15000 });
        return "✓ Gateway restarted";
      } else {
        execSync("systemctl --user restart openclaw-proxy 2>/dev/null || pkill -f 'node.*server.mjs' && sleep 2 && cd ~/.openclaw/projects/*/; node server.mjs &", { timeout: 15000, shell: true });
        return "✓ Proxy restarted";
      }
    } catch (e2) {
      return `✗ Restart failed: ${e2.message?.slice(0, 100)}`;
    }
  }
}

async function cmdLogs(args) {
  const parts = (args || "").trim().split(/\s+/);
  const n = parseInt(parts[0]) || 20;
  const level = parts[1] || "error";
  const d = await fetchJSON(`/logs?n=${n}&level=${level}`);
  if (!d.entries?.length) return `No ${level} log entries.`;
  return d.entries.map((e) => {
    if (e.raw) return e.raw.slice(0, 120);
    return `${(e.ts || "").slice(11, 19)} ${(e.level || "").toUpperCase()} ${e.event || "?"} ${e.model || ""}`;
  }).join("\n");
}

function cmdHelp() {
  return `OCP Commands
─────────────────────────────
/ocp usage              Plan usage & model stats
/ocp status             Quick overview
/ocp health             Proxy diagnostics
/ocp settings           View tunable settings
/ocp settings <k> <v>   Update a setting
/ocp logs [N] [level]   Recent logs (default: 20, error)
/ocp models             Available models
/ocp sessions           Active sessions
/ocp clear              Clear all sessions
/ocp restart            Restart proxy
/ocp restart gateway    Restart gateway
/ocp restart all        Restart both
/ocp version            Version & platform info
/ocp test               End-to-end proxy test`;
}

// ── Plugin entry point ──────────────────────────────────────────────────

export default function (api) {
  console.log("[ocp] OCP plugin loading, registering /ocp command...");
  api.registerCommand({
    name: "ocp",
    description: "OpenClaw Proxy commands — usage, health, settings, logs, etc.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const raw = (ctx.args || "").trim();
      const spaceIdx = raw.indexOf(" ");
      const subcmd = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
      const subargs = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();

      try {
        let text;
        switch (subcmd) {
          case "usage":    text = await cmdUsage(); break;
          case "health":   text = await cmdHealth(); break;
          case "status":   text = await cmdStatus(); break;
          case "settings": text = await cmdSettings(subargs || null); break;
          case "models":   text = await cmdModels(); break;
          case "sessions": text = await cmdSessions(); break;
          case "clear":    text = await cmdClear(); break;
          case "restart":  text = await cmdRestart(subargs); break;
          case "version":  text = await cmdVersion(); break;
          case "test":     text = await cmdTest(); break;
          case "logs":     text = await cmdLogs(subargs); break;
          case "help": case "--help": case "-h": case "":
            text = cmdHelp(); break;
          default:
            text = `Unknown subcommand: ${subcmd}\n\n${cmdHelp()}`;
        }
        return { text: mono(text) };
      } catch (err) {
        return { text: `OCP error: ${err.message}` };
      }
    },
  });
}
