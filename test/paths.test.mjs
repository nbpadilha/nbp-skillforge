// paths.mjs — canonicalization + containment. Small, load-bearing (every remove/gc/rename
// safety check ultimately traces back to isInside()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sep, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isInside, canon, canonFold } from "../src/paths.mjs";

// The platform's filesystem/drive root ("C:\" on win32, "/" on POSIX) already ends with `sep`.
const ROOT = sep === "\\" ? "C:\\" : "/";

// ── C3 regression: isInside must not false-negative when `parent` IS a drive/fs root ──────────
test("isInside: a direct child of the filesystem/drive root is inside it (C3)", () => {
  // Before C3: `parent + sep` on a root parent produced "C:\\" / "//" — a string no real child
  // path starts with — so every child of a root parent was wrongly rejected.
  assert.equal(isInside(ROOT + "sub", ROOT), true);
  assert.equal(isInside(ROOT + "sub" + sep + "deeper", ROOT), true);
});
test("isInside: the root itself equals the root (exact-dir-match)", () => {
  assert.equal(isInside(ROOT, ROOT), true);
});
test("isInside: a sibling that merely shares the root prefix is still rejected", () => {
  // Sanity: fixing the root case must not accidentally admit an unrelated top-level entry.
  assert.equal(isInside(ROOT + "sub", ROOT + "other"), false);
});

// ── Non-root parent: unaffected pre-existing behavior (the bug this module was designed to avoid
// in the FIRST place — a sibling dir whose name is a PREFIX of another must not be "inside" it) ──
test("isInside: a non-root parent's direct/nested child is inside it", () => {
  const parent = ROOT + "Users" + sep + "x";
  assert.equal(isInside(parent + sep + "y", parent), true);
  assert.equal(isInside(parent + sep + "y" + sep + "z", parent), true);
});
test("isInside: a sibling dir whose name merely starts with the parent's name is NOT inside it", () => {
  const parent = ROOT + "Users" + sep + "x";
  const sibling = ROOT + "Users" + sep + "xy"; // shares the "x" prefix, but is not a child
  assert.equal(isInside(sibling, parent), false);
});
test("isInside: an unrelated path is not inside", () => {
  assert.equal(isInside(ROOT + "elsewhere", ROOT + "Users" + sep + "x"), false);
});

// ── C7 mechanism: canonFold must case-fold even a path where NEITHER side (nor any case-variant
// sibling) exists on disk yet — this is the exact primitive lifecycle.mjs's init() distinctRoles
// check now uses instead of canon(), to catch a case-only role collision (e.g. `bricks: "foo"` vs
// `out: "FOO"`) pre-first-build. canon() alone (no JS-side fold) only gets case-folded "for free"
// via the OS when realpath can actually resolve an EXISTING on-disk entry — for a path with no
// existing case-variant at all, realpath throws for BOTH variants, canon() falls back to a purely
// lexical resolve() that preserves whatever case was passed in, and two differently-cased but
// semantically-identical nonexistent paths come out as two DIFFERENT strings.
// NOTE on why this lives here, not as an init()-level red→green test: `init()` unconditionally
// mkdir's bricks+recipes BEFORE computing distinctRoles, so by the time the check runs, any
// case-variant of bricks/recipes already resolves via the OS's OWN case-insensitive directory
// lookup (confirmed empirically) — canon() and canonFold() are then OBSERVABLY EQUIVALENT for
// every path init() can actually present on this sandbox's case-insensitive NTFS temp dir. The
// lifecycle.mjs source fix (canon → canonFold) is still correct/defensive (matches the identical
// pattern compose.mjs's role-overlap check already uses, for the identical structural reason —
// see that check's own comment), but this environment cannot force it into a failing state via
// the init() public API. This test instead red→green-proves the underlying primitive directly.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
test("canonFold: folds a path neither side of which exists yet (C7 mechanism) — canon() alone does not", { skip: !CASE_INSENSITIVE_FS }, () => {
  const root = mkdtempSync(join(tmpdir(), "paths-c7-"));
  const a = join(root, "Nope", "Sub");
  const b = join(root, "NOPE", "SUB"); // same path, different case, neither exists
  assert.notEqual(canon(a), canon(b), "sanity: canon() alone does NOT fold two nonexistent case-variants");
  assert.equal(canonFold(a), canonFold(b), "canonFold() must fold them to the same identity");
});
