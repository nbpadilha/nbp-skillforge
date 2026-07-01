// install-hooks: writes a shim delegating to the bundled versioned hook (works clone or npm dep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { installHooks } from "../src/hooks.mjs";
import { bareRoot, cleanup } from "./helpers.mjs";

const gitInit = (dir) => execSync("git init -q", { cwd: dir });
const preCommit = (root) => join(root, ".git", "hooks", "pre-commit");

test("install-hooks: writes a shim delegating to the bundled hook", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    const r = installHooks({ root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(existsSync(preCommit(root)), true);
    const shim = readFileSync(preCommit(root), "utf8");
    assert.match(shim, /nbp-forge hook shim/);
    assert.match(shim, /scripts\/hooks\/pre-commit/, "shim points at the bundled versioned hook");
    assert.match(shim, /^exec /m);
  } finally { cleanup(root); }
});

test("install-hooks: is idempotent (re-running overwrites our own shim, no backup)", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    assert.equal(installHooks({ root }).ok, true);
    const r2 = installHooks({ root });
    assert.equal(r2.ok, true);
    assert.equal(r2.already, true, "an identical shim is detected as already installed (no rewrite)");
    assert.equal(r2.backedUp, false, "our own shim is replaced in place, not backed up");
    assert.equal(existsSync(preCommit(root) + ".local.bak"), false);
  } finally { cleanup(root); }
});

test("install-hooks: refuses a foreign pre-commit unless --force (which backs it up)", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\necho someone elses hook\n");
    const blocked = installHooks({ root });
    assert.equal(blocked.ok, false);
    assert.match(blocked.msg, /already exists/);
    assert.match(readFileSync(preCommit(root), "utf8"), /someone elses hook/, "foreign hook untouched without --force");

    const forced = installHooks({ root, force: true });
    assert.equal(forced.ok, true, forced.msg);
    assert.equal(forced.backedUp, true);
    assert.match(readFileSync(preCommit(root) + ".local.bak", "utf8"), /someone elses hook/, "foreign hook preserved in backup");
    assert.match(readFileSync(preCommit(root), "utf8"), /nbp-forge hook shim/);
  } finally { cleanup(root); }
});

test("install-hooks: fails cleanly outside a git repository", () => {
  const root = bareRoot(); // no `git init`
  try {
    const r = installHooks({ root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /not a git repository/);
  } finally { cleanup(root); }
});

test("install-hooks: from a subdir still targets the enclosing repo (walk-up preserved)", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const r = installHooks({ root: sub }); // explicit command: onlyRoot off → walk up to the repo
    assert.equal(r.ok, true, r.msg);
    assert.equal(existsSync(preCommit(root)), true, "installs into the repo root from a subdir");
  } finally { cleanup(root); }
});

test("install-hooks: onlyRoot refuses to install into a parent repo from a subdir", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const r = installHooks({ root: sub, onlyRoot: true });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(existsSync(preCommit(root)), false, "parent repo untouched under onlyRoot");
  } finally { cleanup(root); }
});
