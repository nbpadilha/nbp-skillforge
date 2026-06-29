#!/usr/bin/env node
// nbp-forge CLI.
//   forge build|check [--root <dir>]
//   forge new <skill> [--root <dir>]
//   forge remove <skill> [--hard] [--root <dir>]     (default: soft → _archive)
//   forge restore <skill> [--root <dir>]
//   forge gc [--apply] [--hard] [--root <dir>]        (orphan bricks)
//   forge rename <old> <new> [--root <dir>]
// Paths/options: forge.config.json at the root (see src/compose.mjs DEFAULTS).

import { resolve } from "node:path";
import { run } from "../src/compose.mjs";
import { create, remove, restore, gc, rename } from "../src/lifecycle.mjs";

const argv = process.argv.slice(2);
let root = process.cwd(), hard = false, apply = false;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--root") root = resolve(argv[++i] || ".");
  else if (a === "--hard") hard = true;
  else if (a === "--apply") apply = true;
  else pos.push(a);
}
const cmd = pos[0] || "build";

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
  case "new":     finish(create(pos[1], { root })); break;
  case "remove":  finish(remove(pos[1], { root, hard })); break;
  case "restore": finish(restore(pos[1], { root })); break;
  case "gc":      finish(gc(root, { apply, hard })); break;
  case "rename":  finish(rename(pos[1], pos[2], { root })); break;
  default:
    console.error(`unknown command: ${cmd}\nusage: build | check | new | remove | restore | gc | rename`);
    process.exit(2);
}
