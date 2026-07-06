#!/usr/bin/env node
// nbp-skillforge CLI. Run `nbp-skillforge help` for usage.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../src/compose.mjs";
import { create, remove, restore, gc, rename, init, list, importFile } from "../src/lifecycle.mjs";
import { installHooks } from "../src/hooks.mjs";

const HELP = {
  build:   "build [--dry-run] [--json] [--root <dir>]     generate every skill (--dry-run: preview, write nothing)",
  check:   "check [--json] [--root <dir>]                 drift-gate: exit 1 if any output diverged/orphaned",
  init:    "init [--no-hooks] [--root <dir>]     scaffold config + dirs + a sample skill, and install the pre-commit hook",
  list:    "list [--json] [--root <dir>]                  show skills → bricks and per-brick ref-count (blast radius)",
  new:     "new <skill> [--description <text>] [--root <dir>]  scaffold a new recipe, then build",
  import:  "import <file> [--name <n>] [--force] [--root <dir>]  onboard an existing SKILL.md/command as a recipe",
  rename:  "rename <old> <new> [--root <dir>]    rename a skill (regenerate, drop the stale output)",
  remove:  "remove <skill> [--hard] [--root <dir>]   soft-delete (→ _archive) the recipe + exclusive bricks",
  restore: "restore <skill> [--root <dir>]       bring a removed skill (and its bricks) back",
  gc:      "gc [--apply] [--hard] [--json] [--root <dir>]  find/archive orphan bricks (ref-count 0)",
  "install-hooks": "install-hooks [--force] [--root <dir>]  install the pre-commit hook (drift-gate + secret scan)",
  help:    "help [<command>]                     show this help, or detail for one command",
};
function usage(cmd) {
  if (cmd && HELP[cmd]) { console.log("nbp-skillforge " + HELP[cmd]); return; }
  console.log("nbp-skillforge — compose portable agent skills from reusable bricks, with a drift-gate.\n");
  console.log("usage: nbp-skillforge <command> [options]   (docs/tables abbreviate this as `forge`)\n");
  for (const k of ["build", "check", "init", "list", "new", "import", "rename", "remove", "restore", "gc", "install-hooks", "help"]) console.log("  " + HELP[k]);
  console.log("\nPaths/options come from forge.config.json at the root (see SPEC.md).");
  console.log("--json (build/check/list/gc only): print ONLY the machine-readable result (JSON.stringify(result, null, 2)) — no decorated lines. Exit code unchanged. See README's \"JSON output\" section for the shape.");
}

const argv = process.argv.slice(2);
const die = (msg) => { console.error("✗ " + msg); process.exit(2); };
// Accepted limitation: a MISSING option value (e.g. `--root` with nothing after it) dies to stderr
// even under --json — it happens mid-parse, before `wantJson`/`cmd` are known. Unlike an unknown
// flag or a bad config (both --json-aware, see jsonErr), this is a malformed-invocation typo, so
// failing fast to stderr like any CLI is acceptable; not worth a two-pass arg parser to JSON-ify.
const value = (a, i) => { const v = argv[i]; if (v === undefined || v.startsWith("-")) die(`${a} requires a value`); return v; };
let root = process.cwd(), hard = false, apply = false, force = false, name, description, wantHelp = false, wantVersion = false, dryRun = false, noHooks = false, wantJson = false, unknownFlag = null;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--root") root = resolve(value(a, ++i));
  else if (a === "--name") name = value(a, ++i);
  else if (a === "--description") description = value(a, ++i);
  else if (a === "--hard") hard = true;
  else if (a === "--apply") apply = true;
  else if (a === "--force") force = true;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--no-hooks") noHooks = true;
  else if (a === "--json") wantJson = true;
  else if (a === "--help" || a === "-h") wantHelp = true;
  else if (a === "--version" || a === "-v") wantVersion = true;
  else if (a.startsWith("-")) unknownFlag ??= a; // defer: let --help/--version win over a bad flag
  else pos.push(a);
}
const cmd = pos[0] || "build";

if (wantVersion) {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`nbp-skillforge ${pkg.version}`);
    process.exit(0);
  } catch {
    console.error("nbp-skillforge (version unavailable)");
    process.exit(1);
  }
}
if (wantHelp) { usage(pos[0]); process.exit(0); }
if (unknownFlag) { // only now — --help/--version already won
  if (wantJson && ["build", "check", "list", "gc"].includes(cmd)) jsonErr(`unknown option: ${unknownFlag}`, 2);
  die(`unknown option: ${unknownFlag}`);
}

function finish(r) {
  if (r.msg) console[r.ok ? "log" : "error"]((r.ok ? "✔ " : "✗ ") + r.msg);
  // r.errors entries are { kind, skill, msg } objects (F-12) — `msg` is already the full,
  // byte-identical display line this project has always printed.
  if (r.errors?.length) for (const e of r.errors) console.error("  • " + e.msg);
  // Non-blocking: printed regardless of ok/exit code (e.g. an unused include param).
  if (r.warnings?.length) for (const w of r.warnings) console.log("  • " + w);
  process.exit(r.ok ? 0 : 1);
}
// F-19: --json short-circuits build/check/list/gc's decorated output — prints ONLY
// `JSON.stringify(r, null, 2)` to stdout (no "✔ "/"  • " lines), exit code unchanged. Called
// instead of (never alongside) finish()/decorated console.log for these four read/build
// commands. Mutating lifecycle commands (new/import/remove/restore/rename) are out of scope —
// their result shape already differs (a `command` + `build` sub-result) and isn't covered here.
function finishJson(r) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
// F-19 (robustness): when --json is requested for a machine-readable command, even the error paths
// (invalid forge.config.json, unknown flag) must emit JSON on stdout — never only a decorated `✗`
// stderr line — so a tooling/CI consumer can always parse a result. Exit code matches the
// non-JSON path (config/thrown error → 1, unknown flag → 2). Hoisted (used by the unknownFlag
// guard above).
function jsonErr(msg, code) { console.log(JSON.stringify({ ok: false, error: msg }, null, 2)); process.exit(code); }

// A user-facing thrown error (e.g. loadConfig on invalid forge.config.json) becomes a clean
// `✗ <msg>` exit 1. An UNEXPECTED error (a real bug) is re-thrown so it keeps its full stack trace
// and crashes loudly — the catch must not mask programming errors. Successful cases call
// finish()/process.exit() before reaching the catch.
try {
switch (cmd) {
  case "build": {
    const r = run({ root, mode: "build", dryRun });
    if (wantJson) finishJson(r);
    if (dryRun) {
      if (r.ok) {
        const sym = { create: "+", change: "~", same: "=" };
        // F-26: with N > 1 destinations each (name × out) pair is its own plan line, labeled with
        // its destination; N === 1 keeps the historical line byte-identical (no label).
        for (const { name, out, status } of r.plan) console.log(`  ${sym[status]} ${name}${r.destinations > 1 ? ` → ${out}` : ""}${status === "same" ? "  (unchanged)" : ""}`);
        const create = r.plan.filter((p) => p.status === "create").length;
        const change = r.plan.filter((p) => p.status === "change").length;
        const multi = r.destinations > 1 ? ` across ${r.destinations} destination(s)` : "";
        console.log(`dry-run: ${create} to create, ${change} to change, ${r.unchanged} unchanged${multi} (nothing written).`);
      }
      finish({ ...r, msg: r.ok ? undefined : "build aborted (see errors below)." });
    }
    // F-26 (DECISION 6): aggregate-only summary; when N > 1 an "across N destination(s)" suffix
    // is appended. N === 1 stays byte-identical to the historical line (retrocompat contract).
    const multi = r.destinations > 1 ? ` across ${r.destinations} destination(s)` : "";
    finish({ ...r, msg: r.ok ? `build: ${r.written} written, ${r.unchanged} unchanged${multi}.` : "build aborted (see errors below)." });
    break;
  }
  case "check": {
    const r = run({ root, mode: "check" });
    if (wantJson) finishJson(r);
    finish({ ...r, msg: r.ok ? `check: ${r.count} in sync.` : `check failed (${r.drift || 0} drift, ${r.orphans || 0} orphans).` });
    break;
  }
  case "init":    finish(init(root, { hooks: !noHooks })); break;
  case "list": {
    const r = list(root);
    if (wantJson) finishJson(r);
    if (!r.ok) finish(r);
    for (const { skill, bricks } of r.skills) console.log(`• ${skill}${bricks.length ? "  ⇐ " + bricks.join(", ") : "  (no bricks)"}`);
    if (r.bricks.length) {
      console.log("\nbricks (ref-count — blast radius):");
      for (const { brick, refCount, usedBy } of r.bricks) console.log(`  ${refCount}× ${brick}  [${usedBy.join(", ")}]`);
    }
    finish(r);
    break;
  }
  case "new":     if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.new}` }); finish(create(pos[1], { root, description })); break;
  case "import":  if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.import}` }); finish(importFile(pos[1], { root, name, force })); break;
  case "remove":  if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.remove}` }); finish(remove(pos[1], { root, hard })); break;
  case "restore": if (!pos[1]) finish({ ok: false, msg: `usage: ${HELP.restore}` }); finish(restore(pos[1], { root })); break;
  case "gc": {
    const r = gc(root, { apply, hard });
    if (wantJson) finishJson(r);
    finish(r);
    break;
  }
  case "install-hooks": finish(installHooks({ root, force })); break;
  case "rename":  if (!pos[1] || !pos[2]) finish({ ok: false, msg: `usage: ${HELP.rename}` }); finish(rename(pos[1], pos[2], { root })); break;
  case "help":    usage(pos[1]); process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`); usage(); process.exit(2);
}
} catch (e) {
  if (!e?.userFacing) throw e; // unexpected/programming error → preserve the stack trace, crash loudly
  if (wantJson && ["build", "check", "list", "gc"].includes(cmd)) jsonErr(e.message, 1); // parseable error for --json consumers
  console.error("✗ " + e.message);
  process.exit(1);
}
