#!/usr/bin/env node
// nbp-forge CLI. Run `forge help` for usage.

import { resolve } from "node:path";
import { run } from "../src/compose.mjs";
import { create, remove, restore, gc, rename, init, list, importFile } from "../src/lifecycle.mjs";

const HELP = {
  build:   "build [--root <dir>]                 generate every skill from its recipe + bricks",
  check:   "check [--root <dir>]                 drift-gate: exit 1 if any output diverged/orphaned",
  init:    "init [--root <dir>]                  scaffold forge.config.json + dirs + a sample skill",
  list:    "list [--root <dir>]                  show skills → bricks and per-brick ref-count (blast radius)",
  new:     "new <skill> [--root <dir>]           scaffold a new recipe, then build",
  import:  "import <file> [--name <n>] [--force]  onboard an existing SKILL.md/command as a recipe",
  rename:  "rename <old> <new> [--root <dir>]    rename a skill (regenerate, drop the stale output)",
  remove:  "remove <skill> [--hard] [--root <dir>]   soft-delete (→ _archive) the recipe + exclusive bricks",
  restore: "restore <skill> [--root <dir>]       bring a removed skill (and its bricks) back",
  gc:      "gc [--apply] [--hard] [--root <dir>]  find/archive orphan bricks (ref-count 0)",
  help:    "help [<command>]                     show this help, or detail for one command",
};
function usage(cmd) {
  if (cmd && HELP[cmd]) { console.log("forge " + HELP[cmd]); return; }
  console.log("nbp-forge — compose portable agent skills from reusable bricks, with a drift-gate.\n");
  console.log("usage: forge <command> [options]\n");
  for (const k of ["build", "check", "init", "list", "new", "import", "rename", "remove", "restore", "gc", "help"]) console.log("  " + HELP[k]);
  console.log("\nPaths/options come from forge.config.json at the root (see SPEC.md).");
}

const argv = process.argv.slice(2);
let root = process.cwd(), hard = false, apply = false, force = false, name, wantHelp = false;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--root") root = resolve(argv[++i] || ".");
  else if (a === "--name") name = argv[++i];
  else if (a === "--hard") hard = true;
  else if (a === "--apply") apply = true;
  else if (a === "--force") force = true;
  else if (a === "--help" || a === "-h") wantHelp = true;
  else pos.push(a);
}
const cmd = pos[0] || "build";

if (wantHelp) { usage(pos[0]); process.exit(0); }

function finish(r) {
  if (r.msg) console[r.ok ? "log" : "error"]((r.ok ? "✔ " : "✗ ") + r.msg);
  if (r.errors?.length) for (const e of r.errors) console.error("  • " + e);
  process.exit(r.ok ? 0 : 1);
}

switch (cmd) {
  case "build": {
    const r = run({ root, mode: "build" });
    finish({ ...r, msg: r.ok ? `build: ${r.written} file(s) generated.` : "build aborted (errors above)." });
    break;
  }
  case "check": {
    const r = run({ root, mode: "check" });
    finish({ ...r, msg: r.ok ? `check: ${r.count} in sync.` : `check failed (${r.drift || 0} drift, ${r.orphans || 0} orphans).` });
    break;
  }
  case "init":    finish(init(root)); break;
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
  case "new":     finish(create(pos[1], { root })); break;
  case "import":  finish(importFile(pos[1], { root, name, force })); break;
  case "remove":  finish(remove(pos[1], { root, hard })); break;
  case "restore": finish(restore(pos[1], { root })); break;
  case "gc":      finish(gc(root, { apply, hard })); break;
  case "rename":  finish(rename(pos[1], pos[2], { root })); break;
  case "help":    usage(pos[1]); process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`); usage(); process.exit(2);
}
