// CLI smoke tests — spawn bin/cli.mjs for the cross-cutting flags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRoot, write, cleanup } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const node = process.execPath;
// T1: execFileSync only returns stdout on success (stderr is piped-but-discarded unless the
// call throws) — spawnSync always returns BOTH streams regardless of exit code, needed to assert
// the --json path never leaks a decorated line onto stderr even when the command succeeds.
const runCli = (args) => spawnSync(node, [cli, ...args], { encoding: "utf8" });

test("--version prints `nbp-forge <version>` and exits 0", () => {
  const out = execFileSync(node, [cli, "--version"], { encoding: "utf8" });
  assert.equal(out.trim(), `nbp-forge ${pkg.version}`);
  // -v alias
  assert.equal(execFileSync(node, [cli, "-v"], { encoding: "utf8" }).trim(), `nbp-forge ${pkg.version}`);
});

test("help exits 0 and lists commands", () => {
  const out = execFileSync(node, [cli, "help"], { encoding: "utf8" });
  assert.match(out, /usage: nbp-forge <command>/);
  assert.match(out, /install-hooks/);
});

test("unknown command exits 2", () => {
  try {
    execFileSync(node, [cli, "bogus-cmd"], { encoding: "utf8", stdio: "pipe" });
    assert.fail("should have exited non-zero");
  } catch (e) {
    assert.equal(e.status, 2);
  }
});

test("unknown option exits 2", () => {
  try {
    execFileSync(node, [cli, "build", "--bogus"], { encoding: "utf8", stdio: "pipe" });
    assert.fail("should have exited non-zero");
  } catch (e) {
    assert.equal(e.status, 2);
  }
});

test("missing required positional args exit non-zero (no undefined.md)", () => {
  for (const args of [["new"], ["rename", "only-one"]]) {
    try {
      execFileSync(node, [cli, ...args], { encoding: "utf8", stdio: "pipe" });
      assert.fail(`'${args.join(" ")}' should have exited non-zero`);
    } catch (e) {
      assert.ok(e.status >= 1, `'${args.join(" ")}' exit ${e.status}`);
    }
  }
});

test("--help wins over an unknown flag (exit 0, shows help)", () => {
  const out = execFileSync(node, [cli, "--help", "--bogus"], { encoding: "utf8" });
  assert.match(out, /usage: nbp-forge <command>/);
  // --version too
  assert.equal(execFileSync(node, [cli, "--version", "--bogus"], { encoding: "utf8" }).trim(), `nbp-forge ${pkg.version}`);
});

test("an option missing its value exits 2", () => {
  try {
    execFileSync(node, [cli, "build", "--root"], { encoding: "utf8", stdio: "pipe" });
    assert.fail("should have exited non-zero");
  } catch (e) {
    assert.equal(e.status, 2);
    assert.match(e.stderr, /--root requires a value/);
  }
});

test("build failure: summary says 'see errors below' and a bullet actually follows (both build and --dry-run)", () => {
  const root = makeRoot({ recipes: { x: "---\nname: x\n---\n# x\n\n<!-- include: does-not-exist -->\n" } });
  try {
    for (const args of [["build", "--root", root], ["build", "--dry-run", "--root", root]]) {
      try {
        execFileSync(node, [cli, ...args], { encoding: "utf8", stdio: "pipe" });
        assert.fail(`'${args.join(" ")}' should have exited non-zero`);
      } catch (e) {
        assert.equal(e.status, 1);
        assert.match(e.stderr, /build aborted \(see errors below\)\./);
        assert.doesNotMatch(e.stderr, /errors above/);
        assert.match(e.stderr, /  • build error:.*does-not-exist/);
      }
    }
  } finally { cleanup(root); }
});

test("new: an unrelated broken recipe's build failure is surfaced, not a mute ✗ (F-07)", () => {
  const root = makeRoot({ recipes: { broken: "---\nname: broken\n---\n# broken\n\n<!-- include: nao-existe -->\n" } });
  try {
    execFileSync(node, [cli, "new", "valid-skill", "--root", root], { encoding: "utf8", stdio: "pipe" });
    assert.fail("should have exited non-zero");
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /recipe created: valid-skill/, "the action's own success text must still print");
    assert.match(e.stderr, /include of missing brick: nao-existe/, "the real build error must print");
  } finally { cleanup(root); }
});

// ── C8 regression: `new` (and remove/restore/rename) must PRINT the follow-up build's warnings,
// not silently drop them (finish() already prints r.warnings — the bug was these commands never
// put the build's warnings on the result object finish() receives) ─────────────────────────────
test("new: an unrelated unused-param warning from the follow-up build is printed (C8)", () => {
  const root = makeRoot({
    bricks: { "run-dir": "Run: static text, no placeholders" },
    recipes: { existing: "---\nname: existing\n---\n# existing\n\n<!-- include: run-dir | naousado=abc -->\n" },
  });
  try {
    const out = execFileSync(node, [cli, "new", "hello", "--root", root], { encoding: "utf8" });
    assert.match(out, /recipe created: hello/);
    assert.match(out, /warning: \[existing\] include run-dir: unused param\(s\): naousado/,
      "the follow-up build's warning must be printed, not silently dropped");
  } finally { cleanup(root); }
});

test("rename: a non-conformant new name is refused, old output stays in place (F-08)", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { bom: "---\nname: bom\n---\n# bom\n\n<!-- include: b -->\n" },
  });
  try {
    execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" });
    try {
      execFileSync(node, [cli, "rename", "bom", "Ruim", "--root", root], { encoding: "utf8", stdio: "pipe" });
      assert.fail("should have exited non-zero");
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr, /rename blocked/);
      assert.match(e.stderr, /not a conformant skill name/);
    }
    assert.equal(readFileSync(join(root, "recipes", "bom.md"), "utf8").includes("name: bom"), true, "old recipe untouched");
    assert.equal(existsSync(join(root, "out", "bom.md")), true, "old output must survive — nothing deleted");
  } finally { cleanup(root); }
});

test("new --description writes the description into the recipe (and is not an unknown option)", () => {
  const root = makeRoot({});
  try {
    execFileSync(node, [cli, "new", "mytest", "--description", "Faz y.", "--root", root], { encoding: "utf8" });
    const rec = readFileSync(join(root, "recipes", "mytest.md"), "utf8");
    assert.match(rec, /^description: Faz y\.$/m);
  } finally { cleanup(root); }
});

test("build: an unused include param prints a non-blocking warning (exit 0, file written)", () => {
  const root = makeRoot({
    bricks: { "run-dir": "Run: static text, no placeholders" },
    recipes: { demo: "---\nname: demo\n---\n# demo\n\n<!-- include: run-dir | skil=typo; naousado=abc -->\n" },
  });
  try {
    const out = execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" });
    assert.match(out, /✔ build: 1 written, 0 unchanged\./);
    assert.match(out, /  • warning: \[demo\] include run-dir: unused param\(s\): skil, naousado/);
    assert.equal(readFileSync(join(root, "out", "demo.md"), "utf8").includes("static text"), true);
  } finally { cleanup(root); }
});

test("README's 'See it in 60 seconds' demo quotes the CLI's real output templates (doc drift-gate)", () => {
  // Extract the literal ✔/✗/bullet lines quoted in the README demo (README.md:44-64) and check
  // each one matches the CLI's actual message shape — catches exactly the F-22 drift (a stale
  // "N file(s) generated." wording after the skip-if-unchanged rename to "N written, M unchanged.").
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const demo = readme.slice(readme.indexOf("## See it in 60 seconds"), readme.indexOf("## Quick start"));
  assert.match(demo, /✔ build: \d+ written, \d+ unchanged\./, "README build line must use the real 'N written, M unchanged' template");
  assert.doesNotMatch(demo, /file\(s\) generated/, "README must not quote the retired 'N file(s) generated' wording");
  assert.match(demo, /✗ check failed \(\d+ drift, \d+ orphans\)\./, "README check-failed line must match the real template");
  // F-18: the drift bullet now also carries a "(first difference at line N: expected ..., found
  // ...)" suffix — match the prefix, then assert the suffix shape separately.
  assert.match(demo, /  • drift: .+ is out of sync with its recipe/, "README drift bullet must match the real template");
  assert.match(demo, /is out of sync with its recipe \(first difference at line \d+: expected "[^"]*", found "[^"]*"\)/, "README drift bullet must carry the real first-difference suffix (F-18)");

  // Cross-check those templates against a REAL build+check run, not just a regex guess.
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    const buildOut = execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" }).trim();
    assert.match(buildOut, /^✔ build: \d+ written, \d+ unchanged\.$/);
    write(join(root, "out", "fix.md"), "rogue tweak\n");
    try {
      execFileSync(node, [cli, "check", "--root", root], { encoding: "utf8", stdio: "pipe" });
      assert.fail("check should have exited non-zero on drift");
    } catch (e) {
      assert.match(e.stderr, /^✗ check failed \(\d+ drift, \d+ orphans\)\.$/m);
      assert.match(e.stderr, /^  • drift: .+ is out of sync with its recipe \(first difference at line \d+: expected ".*", found ".*"\)$/m);
    }
  } finally { cleanup(root); }
});

// F-19: --json (build/check/list/gc) prints ONLY the machine-readable result — no decorated
// "✔ "/"  • " lines — and leaves the exit code exactly as the non-json path would.
test("--json: check on an in-sync project prints parseable JSON, no decorated lines", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" });
    const { stdout: out, stderr } = runCli(["check", "--json", "--root", root]);
    assert.doesNotMatch(out, /✔|✗|  • /);
    // T1: the JSON path must be silent on stderr too — no decorated "✔/✗"/bullet lines snuck out
    // on the OTHER stream, which a plain stdout-only assertion would never catch.
    assert.equal(stderr, "", "stderr must carry no decorated output on the --json path");
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.equal(r.drift, 0);
  } finally { cleanup(root); }
});

test("--json: check on a drifted project prints parseable JSON with ok:false, drift:1, exit 1", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" });
    write(join(root, "out", "fix.md"), "rogue tweak\n");
    const { stdout, stderr, status } = runCli(["check", "--json", "--root", root]);
    assert.equal(status, 1, "check --json should still exit non-zero on drift");
    assert.doesNotMatch(stdout, /✔|✗|  • /);
    // T1: even on the FAILING path, the JSON goes to stdout only — stderr stays empty of the
    // decorated "✗ .../  • ..." lines the non-json path would print.
    assert.equal(stderr, "", "stderr must carry no decorated output on the --json path, even on failure");
    const r = JSON.parse(stdout);
    assert.equal(r.ok, false);
    assert.equal(r.drift, 1);
    assert.match(r.errors[0].msg, /is out of sync with its recipe/);
  } finally { cleanup(root); }
});

test("--json: list prints parseable JSON with skills/bricks arrays, no decorated lines", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    const { stdout: out, stderr } = runCli(["list", "--json", "--root", root]);
    assert.doesNotMatch(out, /•/);
    assert.equal(stderr, "", "stderr must carry no decorated output on the --json path");
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.deepEqual(r.skills.map((s) => s.skill), ["fix"]);
    assert.deepEqual(r.bricks.map((b) => b.brick), ["b"]);
  } finally { cleanup(root); }
});

test("--json: build (and build --dry-run) print parseable JSON with a `plan` array", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    for (const args of [["build", "--json", "--root", root], ["build", "--dry-run", "--json", "--root", root]]) {
      const { stdout: out, stderr } = runCli(args);
      assert.doesNotMatch(out, /✔|  \+|  ~|  =/);
      assert.equal(stderr, "", `stderr must carry no decorated output on the --json path (${args.join(" ")})`);
      const r = JSON.parse(out);
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.plan));
      assert.deepEqual(r.plan.map((p) => p.name), ["fix"]);
    }
  } finally { cleanup(root); }
});

test("--json: gc prints parseable JSON with orphans/applied", () => {
  const root = makeRoot({
    bricks: { orphan: "unused", b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    const { stdout: out, stderr } = runCli(["gc", "--json", "--root", root]);
    assert.doesNotMatch(out, /✔|✗|orphan bricks/);
    assert.equal(stderr, "", "stderr must carry no decorated output on the --json path");
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.deepEqual(r.orphans, ["orphan"]);
    assert.equal(r.applied, false);
  } finally { cleanup(root); }
});

test("without --json, build/check/list/gc output is unchanged (regression guard)", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    const buildOut = execFileSync(node, [cli, "build", "--root", root], { encoding: "utf8" });
    assert.match(buildOut, /^✔ build: \d+ written, \d+ unchanged\.\n$/);
    const checkOut = execFileSync(node, [cli, "check", "--root", root], { encoding: "utf8" });
    assert.match(checkOut, /^✔ check: \d+ in sync\.\n$/);
    const listOut = execFileSync(node, [cli, "list", "--root", root], { encoding: "utf8" });
    assert.match(listOut, /^• fix  ⇐ b/m);
    const gcOut = execFileSync(node, [cli, "gc", "--root", root], { encoding: "utf8" });
    assert.match(gcOut, /no orphan bricks/);
  } finally { cleanup(root); }
});

test("invalid forge.config.json exits 1 with a clean message (no raw stack trace)", () => {
  const root = makeRoot({ recipes: { a: "---\nname: a\n---\n# a\nbody\n" } });
  try {
    write(join(root, "forge.config.json"), "{ not valid json");
    try {
      execFileSync(node, [cli, "check", "--root", root], { encoding: "utf8", stdio: "pipe" });
      assert.fail("should have exited non-zero");
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr, /forge\.config\.json: invalid JSON/);
      assert.doesNotMatch(e.stderr, /at .*compose\.mjs/, "no raw stack trace leaks");
    }
  } finally { cleanup(root); }
});

// F-19 (robustness): with --json, even error paths (invalid config, unknown flag) must emit
// parseable JSON on stdout and nothing decorated on stderr — a machine consumer can always parse.
test("--json: an invalid forge.config.json still yields parseable JSON (ok:false), stderr empty", () => {
  const root = makeRoot({ recipes: { a: "---\nname: a\n---\n# a\nbody\n" } });
  try {
    write(join(root, "forge.config.json"), "{ not valid json");
    const { stdout, stderr, status } = runCli(["build", "--json", "--root", root]);
    assert.equal(status, 1);
    const r = JSON.parse(stdout);
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid JSON/);
    assert.equal(stderr, "", "no decorated stderr on the --json path, even on a thrown config error");
  } finally { cleanup(root); }
});

test("--json: an unknown flag on a json command yields parseable JSON (ok:false), exit 2", () => {
  const root = makeRoot({ recipes: { a: "---\nname: a\ndescription: d.\n---\n# a\nbody\n" } });
  try {
    const { stdout, stderr, status } = runCli(["build", "--json", "--bogus", "--root", root]);
    assert.equal(status, 2);
    const r = JSON.parse(stdout);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown option: --bogus/);
    assert.equal(stderr, "", "no decorated stderr on the --json path for an unknown flag");
  } finally { cleanup(root); }
});
