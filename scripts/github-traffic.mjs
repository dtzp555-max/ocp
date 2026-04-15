#!/usr/bin/env node
// github-traffic.mjs — fetch GitHub Traffic Insights for this repo.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx node scripts/github-traffic.mjs           # pretty report
//   GITHUB_TOKEN=ghp_xxx node scripts/github-traffic.mjs --json    # raw JSON
//   GITHUB_TOKEN=ghp_xxx node scripts/github-traffic.mjs --save    # write snapshot file
//
// Options:
//   --owner=<user>   Override repo owner   (default: dtzp555-max)
//   --repo=<name>    Override repo name    (default: ocp)
//   --json           Print raw JSON instead of a formatted report
//   --save[=path]    Append snapshot as JSONL to path (default: ./traffic-history.jsonl)
//
// Requires a token with push access to the repository. Traffic endpoints
// return the last 14 days of data — run daily to build a longer history.

const API = "https://api.github.com";

function parseArgs(argv) {
  const args = { owner: "dtzp555-max", repo: "ocp", json: false, save: null };
  for (const a of argv.slice(2)) {
    if (a === "--json") args.json = true;
    else if (a === "--save") args.save = "traffic-history.jsonl";
    else if (a.startsWith("--save=")) args.save = a.slice(7);
    else if (a.startsWith("--owner=")) args.owner = a.slice(8);
    else if (a.startsWith("--repo=")) args.repo = a.slice(7);
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`github-traffic.mjs — fetch GitHub Traffic Insights

Usage:
  GITHUB_TOKEN=<token> node scripts/github-traffic.mjs [options]

Options:
  --owner=<user>   Repo owner (default: dtzp555-max)
  --repo=<name>    Repo name  (default: ocp)
  --json           Print raw JSON (for piping to jq)
  --save[=path]    Append snapshot as JSONL (default: ./traffic-history.jsonl)
  -h, --help       Show this help

Requires GITHUB_TOKEN with push access to the repository.`);
}

async function gh(path, token) {
  const res = await fetch(API + path, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ocp-traffic-script",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAll(owner, repo, token) {
  const base = `/repos/${owner}/${repo}`;
  const [repoInfo, views, clones, referrers, paths] = await Promise.all([
    gh(base, token),
    gh(`${base}/traffic/views`, token),
    gh(`${base}/traffic/clones`, token),
    gh(`${base}/traffic/popular/referrers`, token),
    gh(`${base}/traffic/popular/paths`, token),
  ]);
  return {
    fetched_at: new Date().toISOString(),
    repo: {
      full_name: repoInfo.full_name,
      stars: repoInfo.stargazers_count,
      watchers: repoInfo.subscribers_count,
      forks: repoInfo.forks_count,
      open_issues: repoInfo.open_issues_count,
      pushed_at: repoInfo.pushed_at,
    },
    views, clones, referrers, paths,
  };
}

function bar(value, max, width = 20) {
  if (!max) return "";
  const n = Math.round((value / max) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

function formatReport(data) {
  const { repo, views, clones, referrers, paths } = data;
  const lines = [];
  lines.push(`\n📊 GitHub Traffic — ${repo.full_name}`);
  lines.push(`   ⭐ ${repo.stars}  👁 ${repo.watchers ?? "?"}  🍴 ${repo.forks}  🐛 ${repo.open_issues} open issues`);
  lines.push(`   Last push: ${repo.pushed_at}`);
  lines.push(`   Fetched:   ${data.fetched_at}\n`);

  lines.push(`── Views (last 14 days) ────────────────────────────────────`);
  lines.push(`   Total: ${views.count}   Unique: ${views.uniques}`);
  const maxV = Math.max(1, ...views.views.map(v => v.count));
  for (const v of views.views) {
    const day = v.timestamp.slice(0, 10);
    lines.push(`   ${day}  ${String(v.count).padStart(4)} (${String(v.uniques).padStart(3)} uniq)  ${bar(v.count, maxV)}`);
  }

  lines.push(`\n── Clones (last 14 days) ───────────────────────────────────`);
  lines.push(`   Total: ${clones.count}   Unique: ${clones.uniques}`);
  if (clones.clones.length) {
    const maxC = Math.max(1, ...clones.clones.map(c => c.count));
    for (const c of clones.clones) {
      const day = c.timestamp.slice(0, 10);
      lines.push(`   ${day}  ${String(c.count).padStart(4)} (${String(c.uniques).padStart(3)} uniq)  ${bar(c.count, maxC)}`);
    }
  } else {
    lines.push(`   (no clones recorded)`);
  }

  lines.push(`\n── Top Referrers ───────────────────────────────────────────`);
  if (referrers.length) {
    const maxR = Math.max(1, ...referrers.map(r => r.count));
    for (const r of referrers) {
      lines.push(`   ${r.referrer.padEnd(28)} ${String(r.count).padStart(5)} views  (${r.uniques} uniq)  ${bar(r.count, maxR, 15)}`);
    }
  } else {
    lines.push(`   (no referrer data)`);
  }

  lines.push(`\n── Popular Content ─────────────────────────────────────────`);
  if (paths.length) {
    const maxP = Math.max(1, ...paths.map(p => p.count));
    for (const p of paths) {
      lines.push(`   ${String(p.count).padStart(5)} views  ${String(p.uniques).padStart(4)} uniq  ${p.path}`);
      lines.push(`      ${bar(p.count, maxP, 40)}  ${p.title.slice(0, 60)}`);
    }
  } else {
    lines.push(`   (no popular content data)`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is required.");
    console.error("Create a token with 'repo' scope: https://github.com/settings/tokens");
    process.exit(1);
  }

  let data;
  try {
    data = await fetchAll(args.owner, args.repo, token);
  } catch (err) {
    console.error(`Failed to fetch traffic: ${err.message}`);
    if (err.message.includes("403")) {
      console.error("Note: traffic endpoints require push access to the repository.");
    }
    process.exit(1);
  }

  if (args.save) {
    const { writeFileSync, appendFileSync, existsSync } = await import("node:fs");
    const line = JSON.stringify(data) + "\n";
    if (existsSync(args.save)) appendFileSync(args.save, line);
    else writeFileSync(args.save, line);
    console.error(`Snapshot appended to ${args.save}`);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatReport(data));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
