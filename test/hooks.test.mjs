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
    assert.match(shim, /nbp-skillforge hook shim/);
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
    assert.match(readFileSync(preCommit(root), "utf8"), /nbp-skillforge hook shim/);
  } finally { cleanup(root); }
});

// npx hint: a consumer-authored hook that invokes the forge via npx is a broken pattern
// (npm >= 9 ignores --no-install, so npx can hit the registry and hang offline). The refusal
// path must APPEND a pointer to the documented LOCAL-ONLY pattern — still non-fatal,
// still non-clobbering, same { ok:false } shape.
test("install-hooks: refusal over a foreign hook calling npx nbp-skillforge adds the LOCAL-ONLY hint", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\nnpx --no-install nbp-skillforge check\n");
    const r = installHooks({ root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /already exists/, "refusal message itself is unchanged");
    assert.match(r.msg, /LOCAL-ONLY/, "hint points at the documented local-only resolution");
    assert.match(readFileSync(preCommit(root), "utf8"), /npx --no-install/, "foreign hook untouched");
  } finally { cleanup(root); }
});

test("install-hooks: the npx hint also fires for the PRE-RENAME package name (npx nbp-forge)", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\nnpx nbp-forge check\n");
    const r = installHooks({ root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /LOCAL-ONLY/, "old package name still gets the hint");
  } finally { cleanup(root); }
});

test("install-hooks: a foreign hook WITHOUT npx is refused with NO hint (regression)", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\necho someone elses hook\n");
    const r = installHooks({ root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /already exists/);
    assert.ok(!/LOCAL-ONLY/.test(r.msg), "hint only appears when the hook actually uses npx + the forge");
  } finally { cleanup(root); }
});

test("install-hooks: --force over an npx-calling hook replaces it normally, no hint", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\nnpx --no-install nbp-skillforge check\n");
    const r = installHooks({ root, force: true });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.backedUp, true);
    assert.ok(!/LOCAL-ONLY/.test(r.msg), "the replacing shim already resolves locally — no hint needed");
    assert.match(readFileSync(preCommit(root), "utf8"), /nbp-skillforge hook shim/);
    assert.match(readFileSync(preCommit(root) + ".local.bak", "utf8"), /npx --no-install/, "npx hook preserved in backup");
  } finally { cleanup(root); }
});

// Retrocompat (package rename): a shim installed BEFORE the nbp-forge → nbp-skillforge rename
// carries the OLD marker line — it must be recognized as OURS and replaced in place (no --force
// needed, no .local.bak), not treated as a foreign hook. Mirrors the tolerant marker regex.
test("install-hooks: a PRE-RENAME shim (nbp-forge marker) is recognized as ours and replaced", () => {
  const root = bareRoot();
  try {
    gitInit(root);
    writeFileSync(preCommit(root), "#!/bin/sh\n# nbp-forge hook shim — delegates to nbp-forge's versioned hook; do not edit here.\nexec sh '/old/path/scripts/hooks/pre-commit' \"$@\"\n");
    const r = installHooks({ root }); // NO --force: the old shim must not read as foreign
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.backedUp, false, "our own (old-named) shim is replaced in place, not backed up");
    assert.equal(existsSync(preCommit(root) + ".local.bak"), false, "no backup file created");
    const shim = readFileSync(preCommit(root), "utf8");
    assert.match(shim, /nbp-skillforge hook shim/, "rewritten under the new marker");
    assert.ok(!/# nbp-forge hook shim/m.test(shim), "old marker replaced");
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
