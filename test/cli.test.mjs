// CLI smoke tests — spawn bin/cli.mjs for the cross-cutting flags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const node = process.execPath;

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
