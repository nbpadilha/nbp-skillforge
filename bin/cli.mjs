#!/usr/bin/env node
// nbp-forge CLI. Run `nbp-forge help` for usage.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../src/compose.mjs";
import { create, remove, restore, gc, rename, init, list, importFile } from "../src/lifecycle.mjs";
import { installHooks } from "../src/hooks.mjs";

const HELP = {
  build:   "build [--dry-run] [--root <dir>]     generate every skill (--dry-run: preview, write nothing)",
  check:   "check [--root <dir>]                 drift-gate: exit 1 if any output diverged/orphaned",
  init:    "init [--no-hooks] [--root <dir>]     scaffold config + dirs + a sample skill, and install the pre-commit hook",
  list:    "list [--root <dir>]                  show skills → bricks and per-brick ref-count (blast radius)",
  new:     "new <skill> [--root <dir>]           scaffold a new recipe, then build",
  import:  "import <file> [--name <n>] [--force] [--root <dir>]  onboard an existing SKILL.md/command as a recipe",
  rename:  "rename <old> <new> [--root <dir>]    rename a skill (regenerate, drop the stale output)",
  remove:  "remove <skill> [--hard] [--root <dir>]   soft-delete (→ _archive) the recipe + exclusive bricks",
  restore: "restore <skill> [--root <dir>]       bring a removed skill (and its bricks) back",
  gc:      "gc [--apply] [--hard] [--root <dir>]  find/archive orphan bricks (ref-count 0)",
  "install-hooks": "install-hooks [--force] [--root <dir>]  install the pre-commit hook (drift-gate + secret scan)",
  help:    "help [<command>]                     show this help, or detail for one command",
};
function usage(cmd) {
  if (cmd && HELP[cmd]) { console.log("nbp-forge " + HELP[cmd]); return; }
  console.log("nbp-forge — compose portable agent skills from reusable bricks, with a drift-gate.\n");
  console.log("usage: nbp-forge <command> [options]   (docs/tables abbreviate this as `forge`)\n");
  for (const k of ["build", "check", "init", "list", "new", "import", "rename", "remove", "restore", "gc", "install-hooks", "help"]) console.log("  " + HELP[k]);
  console.log("\nPaths/options come from forge.config.json at the root (see SPEC.md).");
}

const argv = process.argv.slice(2);
const die = (msg) => { console.error("✗ " + msg); process.exit(2); };
const value = (a, i) => { const v = argv[i]; if (v === undefined || v.startsWith("-")) die(`${a} requires a value`); return v; };
let root = process.cwd(), hard = false, apply = false, force = false, name, wantHelp = false, wantVersion = false, dryRun = false, noHooks = false;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--root") root = resolve(value(a, ++i));
  else if (a === "--name") name = value(a, ++i);
  else if (a === "--hard") hard = true;
  else if (a === "--apply") apply = true;
  else if (a === "--force") force = true;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--no-hooks") noHooks = true;
  else if (a === "--help" || a === "-h") wantHelp = true;
  else if (a === "--version" || a === "-v") wantVersion = true;
  else if (a.startsWith("-")) die(`unknown option: ${a}`);
  else pos.push(a);
}
const cmd = pos[0] || "build";

if (wantVersion) {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`nbp-forge ${pkg.version}`);
    process.exit(0);
  } catch {
    console.error("nbp-forge (version unavailable)");
    process.exit(1);
  }
}
if (wantHelp) { usage(pos[0]); process.exit(0); }

function finish(r) {
  if (r.msg) console[r.ok ? "log" : "error"]((r.ok ? "✔ " : "✗ ") + r.msg);
  if (r.errors?.length) for (const e of r.errors) console.error("  • " + e);
  process.exit(r.ok ? 0 : 1);
}

switch (cmd) {
  case "build": {
    const r = run({ root, mode: "build", dryRun });
    if (dryRun) {
      if (r.ok) {
        const sym = { create: "+", change: "~", same: "=" };
        for (const { name, status } of r.plan) console.log(`  ${sym[status]} ${name}${status === "same" ? "  (unchanged)" : ""}`);
        const create = r.plan.filter((p) => p.status === "create").length;
        const change = r.plan.filter((p) => p.status === "change").length;
        console.log(`dry-run: ${create} to create, ${change} to change, ${r.unchanged} unchanged (nothing written).`);
      }
      finish({ ...r, msg: r.ok ? undefined : "build aborted (errors above)." });
    }
    finish({ ...r, msg: r.ok ? `build: ${r.written} written, ${r.unchanged} unchanged.` : "build aborted (errors above)." });
    break;
  }
  case "check": {
    const r = run({ root, mode: "check" });
    finish({ ...r, msg: r.ok ? `check: ${r.count} in sync.` : `check failed (${r.drift || 0} drift, ${r.orphans || 0} orphans).` });
    break;
  }
  case "init":    finish(init(root, { hooks: !noHooks })); break;
  case "list": {
    const r = list(root);
    if (!r.ok) finish(r);
    for (const { skill, bricks } of r.skills) console.log(`• ${skill}${bricks.length ? "  ⇐ " + bricks.join(", ") : "  (no bricks)"}`);
    if (r.bricks.length) {
      console.log("\nbricks (ref-count — blast radius):");
      for (const { brick, refCount, usedBy } of r.bricks) console.log(`  ${refCount}× ${brick}  [${usedBy.join(", ")}]`);
    }
    finish(r);
    break;
  }
  case "new":     if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.new}` }); finish(create(pos[1], { root })); break;
  case "import":  if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.import}` }); finish(importFile(pos[1], { root, name, force })); break;
  case "remove":  if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.remove}` }); finish(remove(pos[1], { root, hard })); break;
  case "restore": if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.restore}` }); finish(restore(pos[1], { root })); break;
  case "gc":      finish(gc(root, { apply, hard })); break;
  case "install-hooks": finish(installHooks({ root, force })); break;
  case "rename":  if (!pos[1] || !pos[2]) finish({ ok: false, msg: `usage: ${HELP.rename}` }); finish(rename(pos[1], pos[2], { root })); break;
  case "help":    usage(pos[1]); process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`); usage(); process.exit(2);
}
