// lifecycle: new / remove / restore / gc / rename — plus ref-counted soft-delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { create, remove, restore, gc, rename, init, list, importFile } from "../src/lifecycle.mjs";
import { run } from "../src/compose.mjs";
import { makeRoot, bareRoot, write, read, has, recipe, brick, outFile, archived, cleanup } from "./helpers.mjs";

test("new: scaffolds a recipe and builds without error", () => {
  const root = makeRoot({});
  try {
    const r = create("hello", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "hello")), true);
    // The stub recipe has no includes, so build succeeds and emits the command.
    assert.equal(r.build.ok, true);
    assert.equal(has(outFile(root, "hello")), true);
  } finally { cleanup(root); }
});

test("new --description: fills the scaffold's description; default stays TODO", () => {
  const root = makeRoot({});
  try {
    const r = create("x", { root, description: "Faz y." });
    assert.equal(r.ok, true, r.msg);
    assert.match(read(recipe(root, "x")), /^description: Faz y\.$/m);

    const r2 = create("y", { root });
    assert.equal(r2.ok, true, r2.msg);
    assert.match(read(recipe(root, "y")), /^description: TODO$/m);
  } finally { cleanup(root); }
});

test("new --description: an embedded newline is rejected (would corrupt the frontmatter)", () => {
  const root = makeRoot({});
  try {
    const r = create("z", { root, description: "line one\nline two" });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not contain a newline/);
    assert.equal(has(recipe(root, "z")), false, "nothing written on rejection");
  } finally { cleanup(root); }
});

test("new: refuses to overwrite an existing recipe", () => {
  const root = makeRoot({ recipes: { dup: "---\nname: dup\n---\n# dup\n" } });
  try {
    const r = create("dup", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /already exists/);
  } finally { cleanup(root); }
});

// ── F-07: an action that succeeds but whose follow-up build fails must say WHY (not a mute ✗) ──
test("new: an unrelated broken recipe's build failure is surfaced in errors/msg (not swallowed)", () => {
  const root = makeRoot({ recipes: { broken: "---\nname: broken\n---\n# broken\n\n<!-- include: nao-existe -->\n" } });
  try {
    const r = create("valid-skill", { root });
    assert.equal(r.ok, false, "the follow-up build failed, so ok must be false");
    assert.equal(has(recipe(root, "valid-skill")), true, "the recipe itself WAS created");
    assert.ok(r.errors?.some((e) => e.msg.includes("include of missing brick: nao-existe")), "the build's own error must be surfaced");
    assert.match(r.msg, /recipe created: valid-skill/, "the action's own success text must still be present");
    assert.match(r.msg, /BUT the follow-up build failed/, "the message must distinguish action-ok from build-failed");
    // F-14: `command` (the action) and `build` (the follow-up) must be separately inspectable.
    assert.equal(r.command.ok, true, "the create action itself succeeded");
    assert.match(r.command.msg, /recipe created: valid-skill/);
    assert.equal(r.build.ok, false, "the build result is exposed as its own object");
    assert.ok(r.build.errors.some((e) => e.msg.includes("include of missing brick: nao-existe")));
  } finally { cleanup(root); }
});

// ── C8 regression: create/remove/restore/rename must propagate the follow-up build's warnings,
// not silently drop them ─────────────────────────────────────────────────────────────────────
test("new: an unrelated recipe's unused-param warning from the follow-up build is surfaced on the result (C8)", () => {
  const root = makeRoot({
    bricks: { "run-dir": "Run: static text, no placeholders" },
    recipes: { existing: "---\nname: existing\n---\n# existing\n\n<!-- include: run-dir | naousado=abc -->\n" },
  });
  try {
    const r = create("hello", { root });
    assert.equal(r.ok, true, r.msg);
    assert.ok(r.warnings?.some((w) => w.includes("unused param(s): naousado")),
      "the follow-up build's warning must be on the create() result, not swallowed");
  } finally { cleanup(root); }
});

test("remove (soft): archives recipe + EXCLUSIVE brick, removes command", () => {
  const root = makeRoot({
    bricks: { solo: "exclusive brick body" },
    recipes: { only: "---\nname: only\n---\n# only\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(has(outFile(root, "only")), true);

    const r = remove("only", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.exclusive, ["solo"]);
    // Recipe + exclusive brick gone from live tree…
    assert.equal(has(recipe(root, "only")), false);
    assert.equal(has(brick(root, "solo")), false);
    // …command removed…
    assert.equal(has(outFile(root, "only")), false);
    // …and everything recoverable in the archive.
    assert.equal(has(archived(root, "only", "recipe.md")), true);
    assert.equal(has(archived(root, "only", "bricks", "solo.md")), true);
  } finally { cleanup(root); }
});

test("ref-count: a brick used by 2 skills is KEPT when removing one; the 1-user brick is archived", () => {
  const root = makeRoot({
    bricks: { shared: "shared body", priv: "private body" },
    recipes: {
      a: "---\nname: a\n---\n# a\n\n<!-- include: shared -->\n<!-- include: priv -->\n",
      b: "---\nname: b\n---\n# b\n\n<!-- include: shared -->\n",
    },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("a", { root });
    assert.equal(r.ok, true, r.msg);
    // priv was exclusive to a → archived; shared also used by b → kept.
    assert.deepEqual(r.exclusive, ["priv"]);
    assert.equal(has(brick(root, "priv")), false);
    assert.equal(has(brick(root, "shared")), true, "shared brick must survive");
    assert.ok(r.shared.some((s) => s.brick === "shared" && s.alsoUsedBy.includes("b")));
  } finally { cleanup(root); }
});

test("remove --hard: deletes the recipe + exclusive brick (no archive)", () => {
  const root = makeRoot({
    bricks: { solo: "body" },
    recipes: { gone: "---\nname: gone\n---\n# gone\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("gone", { root, hard: true });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.policy, "hard");
    assert.equal(has(recipe(root, "gone")), false);
    assert.equal(has(brick(root, "solo")), false);
    assert.equal(has(archived(root, "gone", "recipe.md")), false, "hard delete leaves no archive");
  } finally { cleanup(root); }
});

test("remove: an unrelated broken recipe's build failure is surfaced (action still happens)", () => {
  const root = makeRoot({
    bricks: { solo: "body" },
    recipes: {
      only: "---\nname: only\n---\n# only\n\n<!-- include: solo -->\n",
      broken: "---\nname: broken\n---\n# broken\n\n<!-- include: nao-existe -->\n",
    },
  });
  try {
    const r = remove("only", { root });
    assert.equal(r.ok, false);
    assert.equal(has(recipe(root, "only")), false, "the remove action itself happened");
    assert.ok(r.errors?.some((e) => e.msg.includes("include of missing brick: nao-existe")));
    assert.match(r.msg, /skill "only" removed \(soft\)/);
    assert.match(r.msg, /BUT the follow-up build failed/);
    // F-14: `command` (the action) and `build` (the follow-up) must be separately inspectable.
    assert.equal(r.command.ok, true, "the remove action itself succeeded");
    assert.equal(r.build.ok, false);
  } finally { cleanup(root); }
});

test("remove: unknown skill fails cleanly", () => {
  const root = makeRoot({});
  try {
    const r = remove("ghost", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /not found/);
  } finally { cleanup(root); }
});

test("restore: brings back recipe + exclusive brick and rebuilds", () => {
  const root = makeRoot({
    bricks: { solo: "body" },
    recipes: { back: "---\nname: back\n---\n# back\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("back", { root });
    assert.equal(has(recipe(root, "back")), false);

    const r = restore("back", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.restored, ["solo"]);
    assert.equal(has(recipe(root, "back")), true);
    assert.equal(has(brick(root, "solo")), true);
    assert.equal(has(outFile(root, "back")), true, "restore rebuilds the command");
    assert.equal(has(archived(root, "back")), false, "archive entry consumed on restore");
  } finally { cleanup(root); }
});

test("restore: an unrelated broken recipe's build failure is surfaced (action still happens)", () => {
  const root = makeRoot({
    bricks: { solo: "body" },
    recipes: { back: "---\nname: back\n---\n# back\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("back", { root });
    write(recipe(root, "broken"), "---\nname: broken\n---\n# broken\n\n<!-- include: nao-existe -->\n");
    const r = restore("back", { root });
    assert.equal(r.ok, false);
    assert.equal(has(recipe(root, "back")), true, "the restore action itself happened");
    assert.ok(r.errors?.some((e) => e.msg.includes("include of missing brick: nao-existe")));
    assert.match(r.msg, /skill "back" restored/);
    assert.match(r.msg, /BUT the follow-up build failed/);
    // F-14: `command` (the action) and `build` (the follow-up) must be separately inspectable.
    assert.equal(r.command.ok, true, "the restore action itself succeeded");
    assert.equal(r.build.ok, false);
  } finally { cleanup(root); }
});

test("restore: conflict when the recipe already exists", () => {
  const root = makeRoot({
    bricks: { solo: "body" },
    recipes: { c: "---\nname: c\n---\n# c\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("c", { root });
    // Recreate a live recipe with the same name → restore must refuse.
    create("c", { root });
    const r = restore("c", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /conflict/);
  } finally { cleanup(root); }
});

test("gc: detects an orphan brick, and archives it with --apply", () => {
  const root = makeRoot({
    bricks: { used: "used", orphan: "nobody includes me" },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const dry = gc(root, { apply: false });
    assert.deepEqual(dry.orphans, ["orphan"]);
    assert.equal(has(brick(root, "orphan")), true, "dry run must not move anything");

    const applied = gc(root, { apply: true });
    assert.deepEqual(applied.orphans, ["orphan"]);
    assert.equal(has(brick(root, "orphan")), false);
    assert.equal(has(archived(root, "_orphans", "orphan.md")), true);
  } finally { cleanup(root); }
});

test("gc: README in bricks/ is documentation, never flagged as an orphan", () => {
  const root = makeRoot({
    bricks: { README: "# bricks docs", used: "used" },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const dry = gc(root, { apply: false });
    assert.deepEqual(dry.orphans, [], "README must not be an orphan");
    assert.equal(has(brick(root, "README")), true, "README must stay put");

    gc(root, { apply: true });
    assert.equal(has(brick(root, "README")), true, "--apply must never archive README");
  } finally { cleanup(root); }
});

test("gc: reserves repo meta docs (nested/lowercase/LICENSE) but still flags content-named orphans", () => {
  const root = makeRoot({
    bricks: {
      "sub/README": "# nested docs",   // nested + reserved
      "changelog": "# lower reserved", // lowercase reserved basename
      LICENSE: "MIT",                  // another reserved basename
      security: "orphan content brick",// NOT reserved — plausible content name
      "readme-notes": "orphan content",// anchored: not a bare `readme`, so not reserved
      used: "used",
    },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const dry = gc(root, { apply: false });
    // Reserved docs never appear as orphans, at any depth or case…
    for (const doc of ["sub/README", "changelog", "LICENSE"])
      assert.equal(dry.orphans.includes(doc), false, `${doc} must not be an orphan`);
    // …but genuinely-unused content bricks still are (no over-reservation).
    assert.deepEqual([...dry.orphans].sort(), ["readme-notes", "security"], "content orphans still detected");

    gc(root, { apply: true });
    assert.equal(has(brick(root, "sub/README")), true, "--apply must never archive a reserved doc");
    assert.equal(has(brick(root, "LICENSE")), true, "--apply must never archive LICENSE");
    assert.equal(has(brick(root, "security")), false, "--apply must archive a real orphan");
  } finally { cleanup(root); }
});

// ── F-01: once a would-be-nested include is FLATTENED, gc no longer produces a false orphan ──
// T4: this test used to be titled "...after removing a brick-in-brick nested include" but its
// fixture only ever included `inner` DIRECTLY from the recipe — no brick-in-brick ever existed in
// it, so it proved nothing about the nested→flattened transition its own title claimed to cover.
// Since brick-in-brick is now UNCONDITIONALLY a build error (F-01/C2 — there is no longer any way
// to "have" a nested include that builds, fixed or not), the historically meaningful scenario is:
// a user who used to lean on nesting (outer wraps inner) is now forced to FLATTEN — include BOTH
// bricks directly from the recipe body — and gc must not falsely orphan either one once flattened.
test("gc: after flattening a would-be-nested include (recipe includes both bricks directly), neither is a false orphan", () => {
  const root = makeRoot({
    bricks: { outer: "Outer content.", inner: "Inner content." },
    recipes: { demo: "---\nname: demo\n---\n# demo\n\n<!-- include: outer -->\n<!-- include: inner -->\n" },
  });
  try {
    const r = run({ root, mode: "build" });
    assert.equal(r.ok, true, r.errors?.map((e) => e.msg).join("; "));
    assert.deepEqual(gc(root, { apply: false }).orphans, [], "both bricks are referenced directly (flattened, not nested) from the recipe body");
  } finally { cleanup(root); }
});

// ── F-05: an include directive that only appears in a recipe's OWN frontmatter ──
// must not ref-count the brick — compose() never expands frontmatter, so `gc`/`remove`/`list`
// must agree with what actually got built (matches the scan surface compose() uses).
test("gc: a brick referenced only in the recipe's frontmatter is a real orphan (not protected)", () => {
  const root = makeRoot({
    bricks: { b: "brick body, never expanded (fm-only reference)", used: "used" },
    recipes: {
      r: "---\nname: r\ndescription: d\n<!-- include: b -->\n---\n# r\n\n<!-- include: used -->\n",
    },
  });
  try {
    const build = run({ root, mode: "build" });
    assert.equal(build.ok, true, build.errors?.map(e => e.msg).join("; "));
    assert.deepEqual(gc(root, { apply: false }).orphans, ["b"], "an fm-only include must not protect the brick");
  } finally { cleanup(root); }
});

test("remove: a brick referenced only in the recipe's frontmatter is not treated as exclusive", () => {
  const root = makeRoot({
    bricks: { b: "brick body" },
    recipes: { r: "---\nname: r\ndescription: d\n<!-- include: b -->\n---\n# r\n\nNo include in the body.\n" },
  });
  try {
    run({ root, mode: "build" });
    const res = remove("r", { root });
    assert.deepEqual(res.exclusive, [], "an fm-only include must not count as exclusive");
    assert.equal(has(brick(root, "b")), true, "the brick file must be left untouched");
  } finally { cleanup(root); }
});

test("list: a brick referenced only in the recipe's frontmatter is not shown as used by it", () => {
  const root = makeRoot({
    bricks: { b: "brick body" },
    recipes: { r: "---\nname: r\ndescription: d\n<!-- include: b -->\n---\n# r\n\nNo include in the body.\n" },
  });
  try {
    run({ root, mode: "build" });
    const res = list(root);
    assert.equal(res.ok, true, res.msg);
    assert.deepEqual(res.skills.find((s) => s.skill === "r").bricks, [], "fm-only reference must not appear in blast radius");
  } finally { cleanup(root); }
});

// ── F-04: importFile round-trips a source with EMPTY frontmatter, no injected blank line ──
test("import: a source file with EMPTY frontmatter (---/---) round-trips without an injected blank line", () => {
  const root = makeRoot({});
  const src = join(root, "external", "emptyfm.md");
  write(src, "---\n---\n# emptyfm\n\nbody line\n");
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(read(recipe(root, "emptyfm")), "---\n---\n# emptyfm\n\nbody line\n", "no blank line injected between the fences");
    assert.equal(run({ root, mode: "build" }).ok, true);
    assert.equal(run({ root, mode: "check" }).ok, true, "the round-tripped recipe must not drift on build");
  } finally { cleanup(root); }
});

// ── F-10: remove/gc prune now-empty parent dir(s) left behind by a nested brick ──
test("remove (soft): a nested exclusive brick's now-empty parent dirs are pruned", () => {
  const root = makeRoot({
    bricks: { "core/sub/deep": "deep body" },
    recipes: { nested: "---\nname: nested\n---\n# nested\n\n<!-- include: core/sub/deep -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("nested", { root });
    assert.equal(has(join(root, "bricks", "core")), false, "the now-empty core/ (and core/sub) dirs must be pruned");
    assert.equal(has(join(root, "bricks")), true, "the bricks/ root itself must survive, even empty");
  } finally { cleanup(root); }
});

test("remove (soft): pruning stops at a sibling brick that still exists", () => {
  const root = makeRoot({
    bricks: { "core/sub/deep": "deep body", "core/other": "sibling body" },
    recipes: { nested: "---\nname: nested\n---\n# nested\n\n<!-- include: core/sub/deep -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("nested", { root });
    assert.equal(has(join(root, "bricks", "core", "sub")), false, "core/sub is now empty and must be pruned");
    assert.equal(has(brick(root, "core/other")), true, "the sibling brick must survive");
    assert.equal(has(join(root, "bricks", "core")), true, "core/ survives — a sibling brick still lives there");
  } finally { cleanup(root); }
});

test("remove --hard: a nested exclusive brick's now-empty parent dirs are pruned", () => {
  const root = makeRoot({
    bricks: { "core/sub/deep": "deep body" },
    recipes: { nested: "---\nname: nested\n---\n# nested\n\n<!-- include: core/sub/deep -->\n" },
  });
  try {
    run({ root, mode: "build" });
    remove("nested", { root, hard: true });
    assert.equal(has(join(root, "bricks", "core")), false, "the now-empty core/ dir must be pruned (hard delete too)");
  } finally { cleanup(root); }
});

test("gc --apply (soft): a nested orphan brick's now-empty parent dirs are pruned", () => {
  const root = makeRoot({
    bricks: { "orph/sub/orphan": "nobody includes me", used: "used" },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    gc(root, { apply: true });
    assert.equal(has(join(root, "bricks", "orph")), false, "the now-empty orph/ dir must be pruned");
  } finally { cleanup(root); }
});

test("gc --apply --hard: a nested orphan brick's now-empty parent dirs are pruned", () => {
  const root = makeRoot({
    bricks: { "hard/sub/orphan": "nobody includes me", used: "used" },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    gc(root, { apply: true, hard: true });
    assert.equal(has(join(root, "bricks", "hard")), false, "the now-empty hard/ dir must be pruned (hard delete too)");
  } finally { cleanup(root); }
});

// ── F-08: rename pre-validates the new name against conformance BEFORE touching disk ──
test("rename: refuses a non-conformant new name — nothing touched, old output survives", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { bom: "---\nname: bom\n---\n# bom\n\n<!-- include: b -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(has(outFile(root, "bom")), true);
    const r = rename("bom", "Ruim", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /rename blocked/);
    assert.match(r.msg, /not a conformant skill name/);
    assert.equal(has(recipe(root, "bom")), true, "old recipe must survive");
    assert.equal(has(recipe(root, "Ruim")), false, "no new recipe created");
    assert.equal(has(outFile(root, "bom")), true, "old output must survive — nothing deleted");
  } finally { cleanup(root); }
});

test("rename: with conformance:false, a non-conformant new name is allowed (existing behavior)", () => {
  const root = makeRoot({
    config: { conformance: false },
    bricks: { b: "body" },
    recipes: { bom: "---\nname: bom\n---\n# bom\n\n<!-- include: b -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = rename("bom", "Ruim", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "Ruim")), true);
  } finally { cleanup(root); }
});

test("rename: a recipe with no frontmatter is not gated by conformance", () => {
  const root = makeRoot({ recipes: { plain: "# plain\n\nno frontmatter here.\n" } });
  try {
    const r = rename("plain", "Also-Not-Conformant", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "Also-Not-Conformant")), true);
  } finally { cleanup(root); }
});

// ── F-07: rename that succeeds but whose follow-up build fails must say WHY ──
test("rename: an unrelated broken recipe's build failure is surfaced (rename still happens)", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: {
      oldn: "---\nname: oldn\n---\n# oldn\n\n<!-- include: b -->\n",
      broken: "---\nname: broken\n---\n# broken\n\n<!-- include: nao-existe -->\n",
    },
  });
  try {
    const r = rename("oldn", "newn", { root });
    assert.equal(r.ok, false);
    assert.equal(has(recipe(root, "newn")), true, "the rename action itself happened");
    assert.ok(r.errors?.some((e) => e.msg.includes("include of missing brick: nao-existe")));
    assert.match(r.msg, /skill "oldn" → "newn"/);
    assert.match(r.msg, /BUT the follow-up build failed/);
    // F-14: `command` (the action) and `build` (the follow-up) must be separately inspectable.
    assert.equal(r.command.ok, true, "the rename action itself succeeded");
    assert.equal(r.build.ok, false);
  } finally { cleanup(root); }
});

// ── C6 regression: rename must scope the name rewrite to the FRONTMATTER BLOCK, using the
// recipe's ACTUAL fm name — never the whole raw file/filename ──────────────────────────────────
test("rename: fm `name:` diverges from the filename — after rename, fm name is the NEW name (not stale)", () => {
  const root = makeRoot({
    recipes: { old: "---\nname: actual\ndescription: d.\n---\n# old\nbody\n" },
  });
  try {
    const r = rename("old", "new", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "new")), true);
    const txt = read(recipe(root, "new"));
    assert.match(txt, /^name:\s*new\s*$/m, "fm name must become the NEW name, even though it never matched the old filename");
    assert.doesNotMatch(txt, /name:\s*actual/, "the stale fm name must not survive");
  } finally { cleanup(root); }
});
test("rename: a recipe with NO frontmatter but a body line `name: <old>` is left byte-for-byte UNCHANGED (only moved)", () => {
  const bodyText = "# old\n\nExample config:\n```yaml\nname: old\n```\n";
  const root = makeRoot({ recipes: { old: bodyText } });
  try {
    const r = rename("old", "new", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "new")), true);
    assert.equal(read(recipe(root, "new")), bodyText, "no-frontmatter body must never be touched by the name rewrite — only moved");
  } finally { cleanup(root); }
});

test("rename: generates the new command and removes the old one", () => {
  const root = makeRoot({
    bricks: { b: "body" },
    recipes: { oldn: "---\nname: oldn\n---\n# oldn\n\n<!-- include: b -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(has(outFile(root, "oldn")), true);

    const r = rename("oldn", "newn", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "oldn")), false);
    assert.equal(has(recipe(root, "newn")), true);
    assert.equal(has(outFile(root, "oldn")), false, "old command must be removed");
    assert.equal(has(outFile(root, "newn")), true);
    // The `name:` field inside the recipe is rewritten too.
    assert.match(read(recipe(root, "newn")), /^name:\s*newn\s*$/m);
  } finally { cleanup(root); }
});

test("init: scaffolds config + sample skill from a bare dir and builds it", () => {
  const root = bareRoot(); // no forge.config.json → uses defaults (.claude/forge/...)
  try {
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(join(root, "forge.config.json")), true);
    assert.equal(has(join(root, ".claude/forge/recipes/hello.md")), true);
    assert.equal(has(join(root, ".claude/forge/bricks/footer.md")), true);
    assert.equal(has(join(root, ".claude/commands/hello.md")), true, "sample is built");
    assert.ok(r.created.includes("forge.config.json"));
    // F-14: `command` (the scaffold) and `build` (the sample's follow-up build) are separate.
    assert.equal(r.command.ok, true);
    assert.equal(r.build.ok, true, "the sample built cleanly");
  } finally { cleanup(root); }
});

test("init: is idempotent and never clobbers an existing project", () => {
  const root = makeRoot({
    bricks: { real: "real body" },
    recipes: { mine: "---\nname: mine\n---\n# mine\n\n<!-- include: real -->\n" },
  });
  try {
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    // No sample seeded because recipes already exist; the real recipe is untouched.
    assert.equal(has(recipe(root, "hello")), false, "must not seed a sample over a real project");
    assert.equal(read(recipe(root, "mine")).includes("include: real"), true);
    assert.deepEqual(r.created, [], "config already present, recipes present → nothing created");
    // F-14: no sample was seeded, so no build ran — `build` is `null`, not a run() result.
    assert.equal(r.command.ok, true);
    assert.equal(r.build, null);
  } finally { cleanup(root); }
});

test("init: never overwrites an existing brick/output when it would seed the sample", () => {
  const root = bareRoot();
  try {
    // User has a footer brick already (mid-setup) but no recipes yet.
    write(join(root, ".claude/forge/bricks/footer.md"), "MY CUSTOM BRICK");
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    assert.equal(read(join(root, ".claude/forge/bricks/footer.md")), "MY CUSTOM BRICK", "must not clobber existing brick");
    assert.equal(has(join(root, ".claude/forge/recipes/hello.md")), false, "skips the sample to stay safe");
  } finally { cleanup(root); }
});

test("init: skips the sample when bricks/recipes/out are not three distinct dirs", () => {
  const root = makeRoot({ config: { out: "recipes" } }); // out aliased onto recipes
  try {
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(join(root, "recipes/hello.md")), false, "must not seed when roles collide");
    assert.equal(has(join(root, "bricks/footer.md")), false);
  } finally { cleanup(root); }
});

// ── C7: distinctRoles must case-fold on a case-insensitive FS ──────────────────────────────────
// Defensive/consistency coverage at the init() level (mirrors compose.mjs's role-overlap check,
// which needs the SAME canonFold for the SAME reason). NOTE: this does not by itself prove
// red→green — `init()` always mkdir's bricks+recipes BEFORE this check runs, and on this
// environment's default case-insensitive NTFS temp dir, realpathSync.native auto-resolves a
// case-variant of an ALREADY-EXISTING dir via the OS itself (verified: a case-variant of a dir
// that already exists on disk canon()-resolves correctly even WITHOUT the fold). The genuine
// red→green proof — canon() vs canonFold() on a path with NO existing case-variant sibling on
// disk at all — lives in paths.test.mjs ("canonFold: folds a path neither side of which exists
// yet"), which is the exact mechanism this line depends on.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
test("init: skips the sample when bricks/out collide ONLY by case (C7)", { skip: !CASE_INSENSITIVE_FS }, () => {
  const root = makeRoot({ config: { bricks: "foo", recipes: "bar", out: "FOO" } });
  try {
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(join(root, "bar/hello.md")), false, "must not seed when bricks/out collide by case only");
    assert.equal(has(join(root, "foo/footer.md")), false);
  } finally { cleanup(root); }
});

const preCommit = (root) => join(root, ".git", "hooks", "pre-commit");

test("init: installs the pre-commit drift-gate hook in a git repo", () => {
  const root = bareRoot();
  try {
    execSync("git init -q", { cwd: root });
    const r = init(root);
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.hook?.ok, true, "hook reported installed");
    assert.equal(has(preCommit(root)), true, "pre-commit written");
    assert.match(read(preCommit(root)), /nbp-skillforge hook shim/);
  } finally { cleanup(root); }
});

test("init: --no-hooks ({ hooks:false }) never touches .git/hooks", () => {
  const root = bareRoot();
  try {
    execSync("git init -q", { cwd: root });
    const r = init(root, { hooks: false });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.hook, null, "hook step skipped entirely");
    assert.equal(has(preCommit(root)), false, "no hook installed");
  } finally { cleanup(root); }
});

test("init: hook install is best-effort — a non-git dir still initializes cleanly", () => {
  const root = bareRoot(); // no git init
  try {
    const r = init(root);
    assert.equal(r.ok, true, "init must not fail just because the hook can't install");
    assert.equal(r.hook.ok, false);
    assert.match(r.hook.msg, /not a git repository/);
    assert.equal(has(join(root, "forge.config.json")), true, "scaffolding still happened");
  } finally { cleanup(root); }
});

test("init: re-run detects the hook as already installed (idempotent, no rewrite)", () => {
  const root = bareRoot();
  try {
    execSync("git init -q", { cwd: root });
    init(root);
    const r2 = init(root);
    assert.equal(r2.ok, true, r2.msg);
    assert.equal(r2.hook.already, true, "existing shim detected, left in place");
  } finally { cleanup(root); }
});

test("init: never clobbers a foreign pre-commit hook", () => {
  const root = bareRoot();
  try {
    execSync("git init -q", { cwd: root });
    write(preCommit(root), "#!/bin/sh\necho someone elses hook\n");
    const r = init(root);
    assert.equal(r.ok, true, "init still succeeds around a foreign hook");
    assert.equal(r.hook.ok, false, "foreign hook is not replaced");
    assert.match(read(preCommit(root)), /someone elses hook/, "foreign hook left untouched");
  } finally { cleanup(root); }
});

test("init: from a non-git subdir never installs into a PARENT git repo", () => {
  const parent = bareRoot();
  try {
    execSync("git init -q", { cwd: parent });
    const child = join(parent, "packages", "skills");
    mkdirSync(child, { recursive: true });
    const r = init(child); // child is NOT its own repo; a naive walk-up would hit parent/.git
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.hook.ok, false, "auto-install declines for a subdir of a parent repo");
    assert.match(r.hook.msg, /parent git repo/);
    assert.equal(has(preCommit(parent)), false, "the parent repo's hooks must stay untouched");
  } finally { cleanup(parent); }
});

test("list: reports skills→bricks and per-brick ref-count (blast radius)", () => {
  const root = makeRoot({
    bricks: { shared: "s", priv: "p" },
    recipes: {
      a: "---\nname: a\n---\n# a\n\n<!-- include: shared -->\n<!-- include: priv -->\n",
      b: "---\nname: b\n---\n# b\n\n<!-- include: shared -->\n",
    },
  });
  try {
    const r = list(root);
    assert.equal(r.ok, true);
    const a = r.skills.find((s) => s.skill === "a");
    assert.deepEqual([...a.bricks].sort(), ["priv", "shared"]);
    const shared = r.bricks.find((b) => b.brick === "shared");
    assert.equal(shared.refCount, 2);
    assert.deepEqual(shared.usedBy, ["a", "b"]);
    const priv = r.bricks.find((b) => b.brick === "priv");
    assert.equal(priv.refCount, 1);
    // sorted by ref-count desc → shared first
    assert.equal(r.bricks[0].brick, "shared");
  } finally { cleanup(root); }
});

test("list: a missing recipes directory suggests `forge init`, not a bare error", () => {
  const root = makeRoot({ config: { recipes: "nope" } }); // no recipes fixture → dir never created
  try {
    const r = list(root);
    assert.equal(r.ok, false);
    assert.match(r.msg, /no recipes directory: nope/);
    assert.match(r.msg, /run `npx nbp-skillforge init` to scaffold a forge project/);
  } finally { cleanup(root); }
});

test("import: a hand-written skill becomes a recipe that round-trips on build", () => {
  const root = makeRoot({});
  const src = join(root, "external", "imported-skill.md");
  write(src, "---\nname: imported-skill\ndescription: An external skill.\n---\n# Imported\n\nDo the thing.\n");
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.skill, "imported-skill");
    // Recipe created, no banner inside it.
    const rec = read(recipe(root, "imported-skill"));
    assert.ok(!/GENERATED by nbp-skillforge/.test(rec), "recipe is source, not a generated file");
    assert.match(rec, /Do the thing\./);
    // import does not auto-build; an explicit build round-trips to the output (banner + body).
    assert.equal(run({ root, mode: "build" }).ok, true);
    const out = read(outFile(root, "imported-skill"));
    assert.match(out, /^---\nname: imported-skill/);
    assert.match(out, /GENERATED by nbp-skillforge/);
    assert.match(out, /Do the thing\./);
  } finally { cleanup(root); }
});

test("import: an ALREADY-generated file does not double-banner on the next build", () => {
  const root = makeRoot({});
  const banner = "<!-- GENERATED by nbp-skillforge from .claude/forge/recipes/gen-skill.md — do not edit here; edit the recipe/brick and run `forge build`. -->";
  const src = join(root, "external", "gen-skill.md");
  write(src, `---\nname: gen-skill\ndescription: Previously generated.\n---\n${banner}\nreal body line\n`);
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    // The old banner must be stripped from the recipe…
    assert.ok(!/GENERATED by nbp-skillforge/.test(read(recipe(root, "gen-skill"))), "old banner stripped from recipe");
    // …so an explicit build carries exactly ONE banner.
    assert.equal(run({ root, mode: "build" }).ok, true);
    const out = read(outFile(root, "gen-skill"));
    assert.equal((out.match(/GENERATED by nbp-skillforge/g) || []).length, 1, "exactly one banner");
    assert.match(out, /real body line/);
  } finally { cleanup(root); }
});

// Retrocompat (package rename): a file generated BEFORE the nbp-forge → nbp-skillforge rename
// carries the OLD banner name — import must still recognize and strip it (GENERATED_BANNER_RE is
// deliberately tolerant), or every pre-rename generated file would double-banner on re-import.
test("import: a PRE-RENAME banner (nbp-forge) is still recognized and stripped", () => {
  const root = makeRoot({});
  const oldBanner = "<!-- GENERATED by nbp-forge from .claude/forge/recipes/old-skill.md — do not edit here; edit the recipe/brick and run `npx nbp-forge build`. -->";
  const src = join(root, "external", "old-skill.md");
  write(src, `---\nname: old-skill\ndescription: Generated before the rename.\n---\n${oldBanner}\nreal body line\n`);
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.ok(!/GENERATED by nbp-(?:skill)?forge/.test(read(recipe(root, "old-skill"))), "old-name banner stripped from recipe");
    assert.equal(run({ root, mode: "build" }).ok, true);
    const out = read(outFile(root, "old-skill"));
    // Exactly one banner in the rebuilt output — and it carries the NEW name (build rewrites it).
    assert.equal((out.match(/GENERATED by nbp-(?:skill)?forge/g) || []).length, 1, "exactly one banner");
    assert.match(out, /GENERATED by nbp-skillforge/, "rebuilt banner uses the new package name");
    assert.match(out, /real body line/);
  } finally { cleanup(root); }
});

test("import: refuses to overwrite an existing recipe unless --force", () => {
  const root = makeRoot({ recipes: { taken: "---\nname: taken\ndescription: existing.\n---\n# taken\noriginal\n" } });
  const src = join(root, "external", "taken.md");
  write(src, "---\nname: taken\ndescription: incoming.\n---\n# taken\nnew content\n");
  try {
    const blocked = importFile(src, { root });
    assert.equal(blocked.ok, false);
    assert.match(blocked.msg, /already exists/);
    assert.match(read(recipe(root, "taken")), /original/, "must not overwrite without --force");

    const forced = importFile(src, { root, force: true });
    assert.equal(forced.ok, true, forced.errors?.map(e => e.msg).join("; "));
    assert.match(read(recipe(root, "taken")), /new content/);
  } finally { cleanup(root); }
});

test("import: --name overrides basename and frontmatter name", () => {
  const root = makeRoot({});
  const src = join(root, "external", "whatever.md");
  write(src, "---\nname: ignored-name\ndescription: d.\n---\nbody\n");
  try {
    const r = importFile(src, { root, name: "chosen-name" });
    assert.equal(r.ok, true, r.errors?.map(e => e.msg).join("; "));
    assert.equal(r.skill, "chosen-name");
    assert.equal(has(recipe(root, "chosen-name")), true);
    assert.equal(has(recipe(root, "ignored-name")), false);
    // F-09: the recipe's OWN frontmatter must be rewritten to match — otherwise the published
    // output would declare a name ("ignored-name") that disagrees with its own file identity.
    assert.match(read(recipe(root, "chosen-name")), /^name:\s*chosen-name\s*$/m);
  } finally { cleanup(root); }
});

// ── F-09: import --name (or fm-vs-final-name divergence) rewrites the frontmatter name: ──
test("import: without --name, a frontmatter name matching the final name is left untouched", () => {
  const root = makeRoot({});
  const src = join(root, "external", "same.md");
  write(src, "---\nname: same\ndescription: d.\n---\nbody\n");
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.skill, "same");
    assert.match(read(recipe(root, "same")), /^name:\s*same\s*$/m);
  } finally { cleanup(root); }
});

test("import --name: a quoted frontmatter name is rewritten without broken quotes", () => {
  const root = makeRoot({});
  const src = join(root, "external", "quoted.md");
  write(src, `---\nname: "original-name"\ndescription: d.\n---\nbody\n`);
  try {
    const r = importFile(src, { root, name: "outro-nome" });
    assert.equal(r.ok, true, r.msg);
    assert.match(read(recipe(root, "outro-nome")), /^name:\s*outro-nome\s*$/m);
  } finally { cleanup(root); }
});

test("import: a source with no frontmatter at all is never rewritten (no-op)", () => {
  const root = makeRoot({});
  const src = join(root, "external", "nofmimport.md");
  write(src, "# no fm\n\nplain body.\n");
  try {
    const r = importFile(src, { root, name: "chosen" });
    assert.equal(r.ok, true, r.msg);
    assert.equal(read(recipe(root, "chosen")), "# no fm\n\nplain body.\n");
  } finally { cleanup(root); }
});

test("import: rejects a name that would escape the recipes dir (path traversal)", () => {
  const root = makeRoot({});
  const src = join(root, "external", "ok.md");
  write(src, "---\nname: ok\ndescription: d.\n---\nbody\n");
  try {
    for (const bad of ["../evil", "sub/evil", "..", "foo\\bar", "nul", "COM1", "aux.skill"]) {
      const r = importFile(src, { root, name: bad });
      assert.equal(r.ok, false, `name "${bad}" must be rejected`);
      assert.match(r.msg, /invalid skill name/);
    }
    assert.equal(has(join(root, "evil.md")), false);
  } finally { cleanup(root); }
});

test("import: a directory as source fails cleanly (no crash)", () => {
  const root = makeRoot({});
  try {
    const r = importFile(root, { root }); // root is an existing directory, not a file
    assert.equal(r.ok, false);
    assert.match(r.msg, /not a file/);
  } finally { cleanup(root); }
});

test("import: missing source file fails cleanly", () => {
  const root = makeRoot({});
  try {
    const r = importFile(join(root, "nope.md"), { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /not found/);
  } finally { cleanup(root); }
});

test("lifecycle: new/remove/restore/rename reject unsafe names (traversal/device/separators)", () => {
  const root = makeRoot({ recipes: { real: "---\nname: real\ndescription: d.\n---\n# real\nbody\n" } });
  try {
    for (const bad of ["../evil", "sub/evil", "..", "nul", "a\\b"]) {
      assert.equal(create(bad, { root }).ok, false, `new ${bad}`);
      assert.equal(remove(bad, { root }).ok, false, `remove ${bad}`);
      assert.equal(restore(bad, { root }).ok, false, `restore ${bad}`);
      assert.equal(rename(bad, "ok", { root }).ok, false, `rename old ${bad}`);
      assert.equal(rename("real", bad, { root }).ok, false, `rename new ${bad}`);
    }
    assert.equal(has(join(root, "evil.md")), false, "nothing escaped the recipes dir");
  } finally { cleanup(root); }
});

test("remove: unknown deletePolicy fails closed to soft (archived, not destroyed)", () => {
  const root = makeRoot({
    config: { deletePolicy: "archive-typo" },
    bricks: { solo: "b" },
    recipes: { x: "---\nname: x\ndescription: d.\n---\n# x\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("x", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.policy, "soft", "unknown policy must be treated as soft");
    assert.equal(has(archived(root, "x", "recipe.md")), true, "recipe archived, not destroyed");
  } finally { cleanup(root); }
});

test("gc: a NESTED brick that is used is not a false orphan (separator normalized)", () => {
  const root = makeRoot({
    bricks: { "core/run": "x" },
    recipes: { a: "---\nname: a\ndescription: d.\n---\n# a\n\n<!-- include: core/run -->\n" },
  });
  try {
    assert.deepEqual(gc(root, { apply: false }).orphans, [], "nested brick in use must not be flagged orphan");
  } finally { cleanup(root); }
});

test("include with internal `..` canonicalizes to the real brick (builds; no gc false-orphan)", () => {
  const root = makeRoot({
    bricks: { foo: "FOO BODY" },
    recipes: { r: "---\nname: r\ndescription: d.\n---\n# r\n\n<!-- include: sub/../foo -->\n" },
  });
  try {
    const b = run({ root, mode: "build" });
    assert.equal(b.ok, true, b.errors?.map(e => e.msg).join("; "));
    assert.match(read(outFile(root, "r")), /FOO BODY/);
    assert.deepEqual(gc(root, { apply: false }).orphans, [], "foo is used via the normalized include");
  } finally { cleanup(root); }
});

test("remove --hard never deletes a brick path that escapes bricks/ (malicious include)", () => {
  const root = makeRoot({
    bricks: { real: "b" },
    recipes: { x: "---\nname: x\ndescription: d.\n---\n# x\n\n<!-- include: ../escapee -->\n" },
  });
  write(join(root, "escapee.md"), "PRECIOUS"); // a file OUTSIDE bricks/ that must survive
  try {
    remove("x", { root, hard: true });
    assert.equal(has(join(root, "escapee.md")), true, "remove must not reach outside bricks/");
    assert.equal(read(join(root, "escapee.md")), "PRECIOUS");
  } finally { cleanup(root); }
});

test("gc: a backslash-written nested include is normalized (not a false orphan)", () => {
  const root = makeRoot({
    bricks: { "core/run": "x" },
    recipes: { a: "---\nname: a\ndescription: d.\n---\n# a\n\n<!-- include: core\\run -->\n" },
  });
  try {
    assert.deepEqual(gc(root, { apply: false }).orphans, [], "backslash include must key the same as the brick");
  } finally { cleanup(root); }
});

test("remove: refuses to clobber an existing archive entry", () => {
  const root = makeRoot({
    bricks: { solo: "b" },
    recipes: { x: "---\nname: x\ndescription: d.\n---\n# x\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(remove("x", { root }).ok, true);
    create("x", { root });
    const r2 = remove("x", { root });
    assert.equal(r2.ok, false);
    assert.match(r2.msg, /already archived/);
  } finally { cleanup(root); }
});

test("rename: handles a dotted name and a quoted frontmatter name", () => {
  const root = makeRoot({
    config: { conformance: false },
    recipes: { "a.b": `---\nname: "a.b"\ndescription: d.\n---\n# a.b\nbody\n` },
  });
  try {
    const r = rename("a.b", "c", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "c")), true);
    assert.match(read(recipe(root, "c")), /^name:\s*c\s*$/m, "name: rewritten despite quotes + regex-meta dot");
  } finally { cleanup(root); }
});

test("rename: refuses when the target already exists", () => {
  const root = makeRoot({
    recipes: {
      one: "---\nname: one\n---\n# one\n",
      two: "---\nname: two\n---\n# two\n",
    },
  });
  try {
    const r = rename("one", "two", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /already exists/);
  } finally { cleanup(root); }
});

// ── F-31 Fase 1: import warns (never blocks) on a forge-role-marked source ───────────────────
test("import: a source carrying the forge-role marker imports WITH a warning (not blocked)", () => {
  const root = makeRoot({});
  const src = join(root, "external", "forge-onboard.md");
  write(src, "---\nname: forge-onboard\ndescription: Package tooling.\nforge-role: nbp-skillforge/onboard\n---\n# forge-onboard\n\nbody\n");
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(recipe(root, "forge-onboard")), true, "import still happens (warn, not block)");
    assert.ok(r.warnings?.some((w) => /forge-role marker/.test(w)), "warning emitted");
  } finally { cleanup(root); }
});

test("import: a forge-role-shaped line in the BODY only (not fm) does NOT warn", () => {
  const root = makeRoot({});
  const src = join(root, "external", "doc-skill.md");
  write(src, "---\nname: doc-skill\ndescription: Documents the marker.\n---\n# doc-skill\n\nExample:\n\nforge-role: nbp-skillforge/onboard\n");
  try {
    const r = importFile(src, { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.warnings?.length ?? 0, 0, "no warning for a body-only mention");
  } finally { cleanup(root); }
});

// ═══ F-26: lifecycle under N destinations ═══════════════════════════════════════════════════
test("F-26 remove: the generated command is deleted from EVERY out dir that has it", () => {
  const root = makeRoot({
    config: { out: ["out", "second-out"] },
    bricks: { solo: "body" },
    recipes: { only: "---\nname: only\n---\n# only\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(has(join(root, "out", "only.md")), true);
    assert.equal(has(join(root, "second-out", "only.md")), true);
    const r = remove("only", { root });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(join(root, "out", "only.md")), false, "out[0] cleaned");
    assert.equal(has(join(root, "second-out", "only.md")), false, "out[1] cleaned");
  } finally { cleanup(root); }
});

test("F-26 rename: the stale old output is removed from every out dir; new one generated in all", () => {
  const root = makeRoot({
    config: { out: ["out", "second-out"] },
    recipes: { velho: "---\nname: velho\ndescription: d.\n---\n# velho\nbody\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = rename("velho", "novo", { root });
    assert.equal(r.ok, true, r.msg);
    for (const dir of ["out", "second-out"]) {
      assert.equal(has(join(root, dir, "velho.md")), false, `stale old output gone in ${dir}`);
      assert.equal(has(join(root, dir, "novo.md")), true, `new output generated in ${dir}`);
    }
  } finally { cleanup(root); }
});

test("F-26 init: a hello.md sitting in out[1] alone makes the sample unsafe (not seeded)", () => {
  const root = makeRoot({ config: { out: ["out", "second-out"] } });
  try {
    write(join(root, "second-out", "hello.md"), "hand-written, must survive\n");
    const r = init(root, { hooks: false });
    assert.equal(r.ok, true, r.msg);
    assert.equal(has(join(root, "recipes", "hello.md")), false, "sample recipe NOT seeded");
    assert.equal(read(join(root, "second-out", "hello.md")), "hand-written, must survive\n", "user file untouched");
  } finally { cleanup(root); }
});

test("F-26 init: scaffold write round-trips a fresh project's out as a plain STRING", () => {
  const root = bareRoot();
  try {
    const r = init(root, { hooks: false });
    assert.equal(r.ok, true, r.msg);
    const cfg = JSON.parse(read(join(root, "forge.config.json")));
    assert.equal(typeof cfg.out, "string", "a fresh init writes out as a string, never an array");
    assert.equal("outs" in cfg, false, "the derived outs field never leaks into the scaffold");
    // The scaffold spells out EVERY documented key, `conformance` included (it was missing) —
    // pinned as the exact key set so a future config key must consciously decide to be scaffolded.
    assert.deepEqual(Object.keys(cfg),
      ["bricks", "recipes", "out", "archive", "deletePolicy", "enforceGenerated", "conformance"],
      "scaffold carries the full documented key set, in SPEC order");
    assert.equal(cfg.conformance, true, "conformance defaults to true in the scaffold");
  } finally { cleanup(root); }
});

// ═══ F-26 review fix (destructive repro): remove/rename fail CLOSED on a role-overlapping out ═══
test("F-26 remove: a hostile out entry overlapping bricks/ is refused BEFORE any deletion", () => {
  const root = makeRoot({
    config: { out: ["out", "bricks"] }, // out[1] === the bricks role — hostile/misconfigured
    bricks: { vict: "USER SOURCE BRICK — must survive" },
    recipes: { vict: "---\nname: vict\n---\nbody\n" },
  });
  try {
    const r = remove("vict", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not be inside or equal to/);
    assert.equal(read(brick(root, "vict")), "USER SOURCE BRICK — must survive", "source brick untouched");
    assert.equal(has(recipe(root, "vict")), true, "recipe untouched (nothing archived)");
  } finally { cleanup(root); }
});

test("F-26 rename: same pre-flight — refused before any mutation on a role-overlapping config", () => {
  const root = makeRoot({
    config: { out: ["out", "recipes"] },
    recipes: { vict: "---\nname: vict\ndescription: d.\n---\nbody\n" },
  });
  try {
    const r = rename("vict", "novo", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not be inside or equal to/);
    assert.equal(has(recipe(root, "vict")), true, "recipe not moved");
    assert.equal(has(recipe(root, "novo")), false);
  } finally { cleanup(root); }
});

// ═══ Fable bug-hunt regression fixes (session 2026-07-06, post-0.7.0) ═══════════════════════
test("Fable B2: gc refuses a role-overlapping config BEFORE touching anything (recipes survive)", () => {
  const root = makeRoot({ config: { recipes: "bricks/recipes" } }); // recipes nested inside bricks
  write(join(root, "bricks", "recipes", "my-skill.md"), "---\nname: my-skill\ndescription: d.\n---\nbody\n");
  try {
    const r = gc(root, { apply: true, hard: true });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not be inside or equal to/);
    assert.equal(has(join(root, "bricks", "recipes", "my-skill.md")), true, "recipe NOT deleted");
  } finally { cleanup(root); }
});

test("Fable B2b: restore has the same pre-flight", () => {
  const root = makeRoot({ config: { recipes: "bricks/recipes" } });
  try {
    const r = restore("qualquer", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not be inside or equal to/);
  } finally { cleanup(root); }
});

// ═══ F-35: `keep: true` in a brick's frontmatter pins it against auto-archival ═══════════════
test("F-35 gc: a pinned orphan survives dry-run AND --apply (soft); a plain orphan is still archived", () => {
  const root = makeRoot({
    bricks: {
      staging: "---\nkeep: true\n---\nintentional orphan — staging content\n",
      plain: "unpinned orphan\n",
      used: "used",
    },
    recipes: { r: "---\nname: r\n---\n# r\n\n<!-- include: used -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const dry = gc(root, { apply: false });
    assert.deepEqual(dry.orphans, ["plain"], "the pinned brick must not be listed as an orphan");
    assert.deepEqual(dry.pinned, ["staging"], "the pin is reported, never silent");
    assert.match(dry.msg, /1 pinned brick\(s\) kept: staging/);

    const applied = gc(root, { apply: true });
    assert.deepEqual(applied.pinned, ["staging"]);
    assert.equal(has(brick(root, "staging")), true, "--apply must never archive a pinned brick");
    assert.equal(has(brick(root, "plain")), false, "the unpinned orphan is still archived (no regression)");
    assert.equal(has(archived(root, "_orphans", "plain.md")), true);
    assert.equal(has(archived(root, "_orphans", "staging.md")), false, "pinned brick never lands in the archive");
  } finally { cleanup(root); }
});

test("F-35 gc --apply --hard: a pinned orphan is never deleted, even permanently", () => {
  const root = makeRoot({
    bricks: {
      // SAME-quoted value is accepted (mirrors the forge-role matcher's quote rule).
      staging: `---\nkeep: "true"\n---\nintentional orphan\n`,
      plain: "unpinned orphan\n",
    },
  });
  try {
    const r = gc(root, { apply: true, hard: true });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.pinned, ["staging"]);
    assert.match(r.msg, /pinned brick\(s\) kept: staging/);
    assert.equal(has(brick(root, "staging")), true, "--hard must never delete a pinned brick");
    assert.equal(has(brick(root, "plain")), false, "the unpinned orphan is still hard-deleted");
  } finally { cleanup(root); }
});

test("F-35 gc: `keep: false` and `keep: \"maybe\"` do NOT pin (fail-closed) — both are archived", () => {
  const root = makeRoot({
    bricks: {
      offkeep: "---\nkeep: false\n---\nnot pinned\n",
      oddkeep: `---\nkeep: "maybe"\n---\nnot pinned either\n`,
    },
  });
  try {
    const r = gc(root, { apply: true });
    assert.deepEqual([...r.orphans].sort(), ["oddkeep", "offkeep"], "any value other than true must not pin");
    assert.deepEqual(r.pinned, [], "nothing pinned");
    assert.equal(has(brick(root, "offkeep")), false);
    assert.equal(has(brick(root, "oddkeep")), false);
  } finally { cleanup(root); }
});

test("F-35 remove (soft): a pinned EXCLUSIVE brick leaves the sweep — kept in place, reported", () => {
  const root = makeRoot({
    bricks: {
      pinned: "---\nkeep: true\n---\npinned exclusive body\n",
      solo: "plain exclusive body\n",
    },
    recipes: { only: "---\nname: only\n---\n# only\n\n<!-- include: pinned -->\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("only", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.exclusive, ["solo"], "only the unpinned exclusive brick is swept");
    assert.deepEqual(r.pinned, ["pinned"], "the pin is reported on the result");
    assert.match(r.msg, /Kept \(pinned\): pinned\./);
    assert.equal(has(brick(root, "pinned")), true, "pinned brick stays in the live tree");
    assert.equal(has(archived(root, "only", "bricks", "pinned.md")), false, "pinned brick never archived");
    assert.equal(has(brick(root, "solo")), false, "unpinned exclusive brick still archived (no regression)");
    assert.equal(has(archived(root, "only", "bricks", "solo.md")), true);
    // Coherence with gc: the surviving pinned brick is now a pinned ORPHAN — gc must keep it too.
    const g = gc(root, { apply: false });
    assert.deepEqual(g.orphans, []);
    assert.deepEqual(g.pinned, ["pinned"]);
  } finally { cleanup(root); }
});

test("F-35 remove --hard: a pinned exclusive brick is never deleted", () => {
  const root = makeRoot({
    bricks: { pinned: "---\nkeep: true\n---\npinned exclusive body\n" },
    recipes: { gone: "---\nname: gone\n---\n# gone\n\n<!-- include: pinned -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("gone", { root, hard: true });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.pinned, ["pinned"]);
    assert.match(r.msg, /Kept \(pinned\): pinned\./);
    assert.equal(has(brick(root, "pinned")), true, "--hard must never delete a pinned brick");
    assert.equal(has(recipe(root, "gone")), false, "the recipe itself is still hard-deleted");
  } finally { cleanup(root); }
});

test("F-35 remove: a pinned SHARED brick keeps the existing shared behavior (kept, listed as shared, not as pinned)", () => {
  const root = makeRoot({
    bricks: { both: "---\nkeep: true\n---\nshared AND pinned\n" },
    recipes: {
      a: "---\nname: a\n---\n# a\n\n<!-- include: both -->\n",
      b: "---\nname: b\n---\n# b\n\n<!-- include: both -->\n",
    },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("a", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.pinned, [], "the pin sweep only applies to EXCLUSIVE bricks — shared handling is untouched");
    assert.ok(r.shared.some((s) => s.brick === "both" && s.alsoUsedBy.includes("b")), "still reported as shared");
    assert.match(r.msg, /Kept \(shared\): both \[b\]/);
    assert.equal(has(brick(root, "both")), true);
  } finally { cleanup(root); }
});

// ═══ malformed keep (athena triage): fail-closed stays intact, but the sweep must WARN ════════
// Proven by execution: `keep: True` / `keep: yes` do NOT pin (correct per SPEC) and the brick was
// deleted permanently under --apply --hard with no hint that a keep field even existed — the one
// window where fail-closed silently crosses the user's INTENT. The sweep now warns; nothing pins.
test("malformed keep: gc warns on `keep: True`/`keep: yes` orphans — still swept, never silent", () => {
  const root = makeRoot({
    bricks: {
      "unpin-capital": "---\nkeep: True\n---\ntried to pin, YAML-style\n",
      "unpin-yes": "---\nkeep: yes\n---\ntried to pin, yes-style\n",
      "plain": "no keep field at all\n",
      "pin-ok": "---\nkeep: true\n---\nwell-formed pin\n",
    },
  });
  try {
    // Dry-run first: the warning must appear BEFORE anything is deleted, so the user can fix the
    // pin while the brick still exists.
    const dry = gc(root, { apply: false });
    assert.deepEqual([...dry.suspectKeep].sort(), ["unpin-capital", "unpin-yes"], "suspects are exposed on the --json shape (additive)");
    assert.match(dry.msg, /warning: keep field present but not well-formed \(NOT pinned\): unpin-capital, unpin-yes/);
    assert.match(dry.msg, /only `keep: true` pins/);
    assert.deepEqual(dry.pinned, ["pin-ok"], "the well-formed pin still pins — behavior unchanged");
    assert.ok(!dry.suspectKeep.includes("plain"), "a brick with NO keep field is never a suspect");

    // --apply --hard: fail-closed is INTACT (the malformed-keep bricks are still deleted) but the
    // deletion is announced together with the warning — never indistinguishable from a plain orphan.
    const r = gc(root, { apply: true, hard: true });
    assert.deepEqual([...r.suspectKeep].sort(), ["unpin-capital", "unpin-yes"]);
    assert.match(r.msg, /deleted \(permanent\)/);
    assert.match(r.msg, /warning: keep field present but not well-formed \(NOT pinned\): unpin-capital, unpin-yes/);
    assert.equal(has(brick(root, "unpin-capital")), false, "fail-closed intact: malformed keep never pins");
    assert.equal(has(brick(root, "unpin-yes")), false);
    assert.equal(has(brick(root, "pin-ok")), true, "the well-formed pin survives --hard");
  } finally { cleanup(root); }
});

test("malformed keep: gc msg/json are byte-stable when no keep field is malformed", () => {
  const root = makeRoot({ bricks: { orphan: "no keep here\n" } });
  try {
    const r = gc(root, { apply: false });
    assert.deepEqual(r.suspectKeep, [], "additive field present but empty");
    assert.ok(!r.msg.includes("warning"), "no warning text is appended when there is nothing to warn about");
    assert.equal(r.msg, "1 orphan brick(s): orphan (run with --apply to archive)", "pre-existing msg text unchanged");
  } finally { cleanup(root); }
});

test("malformed keep: remove --hard warns before permanently sweeping a `keep: True` exclusive brick", () => {
  const root = makeRoot({
    bricks: { "want-pin": "---\nkeep: True\n---\ntried to pin\n", solo: "plain exclusive\n" },
    recipes: { gone: "---\nname: gone\n---\n# gone\n\n<!-- include: want-pin -->\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("gone", { root, hard: true });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.suspectKeep, ["want-pin"], "the suspect rides the --json shape (additive)");
    assert.match(r.msg, /warning: keep field present but not well-formed \(NOT pinned\): want-pin — only `keep: true` pins/);
    assert.equal(has(brick(root, "want-pin")), false, "fail-closed intact: the malformed keep is still swept");
    assert.deepEqual(r.pinned, [], "nothing was actually pinned");
  } finally { cleanup(root); }
});

test("malformed keep: remove without any keep field appends nothing (msg stability)", () => {
  const root = makeRoot({
    bricks: { solo: "plain exclusive\n" },
    recipes: { gone: "---\nname: gone\n---\n# gone\n\n<!-- include: solo -->\n" },
  });
  try {
    run({ root, mode: "build" });
    const r = remove("gone", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.suspectKeep, []);
    assert.ok(!r.msg.includes("warning: keep field"), "no spurious warning on a clean sweep");
  } finally { cleanup(root); }
});

test("Fable B7: gc --apply --hard says 'deleted (permanent)', never 'archived'", () => {
  const root = makeRoot({ bricks: { orphan: "nobody uses me" } });
  try {
    const r = gc(root, { apply: true, hard: true });
    assert.equal(r.ok, true);
    assert.match(r.msg, /deleted \(permanent\)/);
    assert.ok(!/archived/.test(r.msg));
    const soft = makeRoot({ bricks: { orphan: "nobody uses me" } });
    assert.match(gc(soft, { apply: true }).msg, /archived/);
    cleanup(soft);
  } finally { cleanup(root); }
});

// ═══ Release-readiness fixes (session 2026-07-07): junction traversal + create pre-flight ═══════
// A junction (win32 — creatable WITHOUT admin, unlike a real dir symlink) or a dir symlink
// (POSIX) inside bricks/: mdFiles' readdirSync({recursive}) DESCENDS the reparse point, so
// unguarded sweeps saw the user's EXTERNAL files as governable bricks. Verified by execution both
// ways: the pre-fix gc --apply --hard deleted the real file THROUGH the link.
const linkDirInto = (parent, linkName, targetAbs) =>
  symlinkSync(targetAbs, join(parent, linkName), process.platform === "win32" ? "junction" : "dir");

test("gc: files behind a junction/dir-symlink in bricks/ are never listed as orphans nor touched (data-loss guard)", () => {
  const root = makeRoot({
    bricks: { b: "used brick", "true-orphan": "genuinely unused" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    // External target lives OUTSIDE every role dir (still inside the temp root so cleanup gets it).
    const external = join(root, "user-notes");
    const SENTINEL = "SENTINEL — the user's real file, reached only through the junction\n";
    write(join(external, "precious.md"), SENTINEL);
    linkDirInto(join(root, "bricks"), "linked", external);
    // Dry-run: the external file is NOT an orphan (not ours to govern) — the real orphan still is.
    const dry = gc(root);
    assert.deepEqual(dry.orphans, ["true-orphan"], "external file never listed; a real orphan still caught");
    // Apply --hard (the destructive repro): the external file must survive byte-for-byte.
    const r = gc(root, { apply: true, hard: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.orphans, ["true-orphan"]);
    assert.equal(read(join(external, "precious.md")), SENTINEL, "external content untouched through the junction");
    assert.equal(has(join(root, "bricks", "linked")), true, "the link itself is left in place");
    assert.equal(has(brick(root, "true-orphan")), false, "the genuine orphan was still swept");
  } finally { cleanup(root); }
});

test("restore: a junction planted in the archived bricks dir never drags external files into bricks/", () => {
  const root = makeRoot({
    bricks: { mine: "exclusive brick body" },
    recipes: { solo: "---\nname: solo\ndescription: d.\n---\n# solo\n\n<!-- include: mine -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(remove("solo", { root }).ok, true); // soft → _archive/solo/{recipe.md,bricks/mine.md}
    const external = join(root, "user-notes");
    const SENTINEL = "SENTINEL — must not be renamed out of the user's folder\n";
    write(join(external, "precious.md"), SENTINEL);
    linkDirInto(archived(root, "solo", "bricks"), "linked", external);
    const r = restore("solo", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.restored, ["mine"], "only the genuinely archived brick is restored");
    assert.equal(read(brick(root, "mine")), "exclusive brick body", "real brick back in place");
    assert.equal(has(join(root, "bricks", "linked")), false, "nothing junction-reached lands in bricks/");
    assert.equal(read(join(external, "precious.md")), SENTINEL, "external content untouched (no move through the link)");
    // The trailing recursive rmSync unlinks the junction WITHOUT traversing it (fs.rm never
    // follows reparse points) — asserted by the sentinel surviving while the archive dir is gone.
    assert.equal(has(archived(root, "solo")), false, "archive entry cleaned up");
  } finally { cleanup(root); }
});

test("new: a role-overlapping config is refused BEFORE the recipe is written (fail closed, zero files)", () => {
  // Variant 1 (the execution repro): out[1] === bricks → exit path taken, but the pre-fix create
  // had already written recipes/zzz.md.
  const root = makeRoot({ config: { out: ["out", "bricks"] } });
  try {
    const r = create("zzz", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /must not be inside or equal to/);
    assert.equal(has(recipe(root, "zzz")), false, "no recipe written");
    assert.equal(has(join(root, "recipes")), false, "not even the recipes dir is created");
  } finally { cleanup(root); }
  // Variant 2 (worse pre-fix damage): recipes nested INSIDE bricks — the write itself landed
  // inside the bricks tree.
  const root2 = makeRoot({ config: { recipes: "bricks/recipes" } });
  try {
    const r2 = create("zzz", { root: root2 });
    assert.equal(r2.ok, false);
    assert.match(r2.msg, /must not be inside or equal to/);
    assert.equal(has(join(root2, "bricks", "recipes", "zzz.md")), false, "nothing written inside bricks/");
    assert.equal(has(join(root2, "bricks")), false, "no dir scaffolded under the hostile config");
  } finally { cleanup(root2); }
});

// ═══ Cross-vendor review HIGHs (2026-07-07): a DIRECTORY named `*.md` is never a brick ═════════
// readdirSync({recursive}) lists dirs too, and the bare endsWith(".md") filter let a directory
// pose as a brick: gc --apply --hard crashed EISDIR (soft would MOVE the whole tree), and remove
// crashed AFTER deleting the recipe. mdFiles is now file-only (statSync per hit) and remove's
// exclusive sweep requires a regular file — all verified by execution below.
test("HIGH A: gc never treats a directory named *.md as an orphan (no EISDIR, dir + contents intact)", () => {
  const root = makeRoot({
    bricks: { b: "used brick", "true-orphan": "genuinely unused FILE orphan" },
    recipes: { fix: "---\nname: fix\ndescription: d.\n---\n# fix\n\n<!-- include: b -->\n" },
  });
  try {
    const SENT = "user payload inside the squatting dir — must survive the sweep\n";
    write(join(root, "bricks", "orphan.md", "keep.txt"), SENT); // dir named *.md, non-md payload
    const dry = gc(root);
    assert.deepEqual(dry.orphans, ["true-orphan"], "the dir is never listed; the real FILE orphan still is");
    const r = gc(root, { apply: true, hard: true }); // pre-fix: raw ERR_FS_EISDIR crash right here
    assert.equal(r.ok, true);
    assert.deepEqual(r.orphans, ["true-orphan"]);
    assert.equal(read(join(root, "bricks", "orphan.md", "keep.txt")), SENT, "dir contents untouched");
    assert.equal(has(brick(root, "true-orphan")), false, "the legitimate file orphan was still swept");
  } finally { cleanup(root); }
});

test("HIGH B: remove with an exclusive DIR-brick completes cleanly (recipe gone, dir intact, both policies)", () => {
  for (const hard of [true, false]) {
    const root = makeRoot({ recipes: { b: "---\nname: b\ndescription: d.\n---\n# b\n\n<!-- include: excl -->\n" } });
    try {
      const SENT = "payload inside the dir-brick — must survive remove\n";
      write(join(root, "bricks", "excl.md", "keep.txt"), SENT); // the exclusive "brick" is a DIR
      const r = remove("b", { root, hard }); // pre-fix: recipe deleted, THEN EISDIR (hard) / tree-move (soft)
      assert.equal(r.ok, true, `${hard ? "hard" : "soft"}: ${r.msg}`);
      assert.equal(r.build.ok, true, "the follow-up build actually ran and succeeded");
      assert.equal(has(recipe(root, "b")), false, "recipe removed");
      assert.deepEqual(r.exclusive, [], "a non-file target never enters the exclusive sweep");
      assert.equal(read(join(root, "bricks", "excl.md", "keep.txt")), SENT, "dir-brick left on disk untouched");
      assert.match(r.msg, /Kept \(shared\): excl/, "the keep is reported, never silent");
      if (!hard) assert.equal(has(archived(root, "b", "recipe.md")), true, "soft: recipe archived as usual");
    } finally { cleanup(root); }
  }
});

test("HIGH A/B follow-up: restore never moves a directory named *.md out of the archive into bricks/", () => {
  const root = makeRoot({
    bricks: { mine: "exclusive brick body" },
    recipes: { solo: "---\nname: solo\ndescription: d.\n---\n# solo\n\n<!-- include: mine -->\n" },
  });
  try {
    run({ root, mode: "build" });
    assert.equal(remove("solo", { root }).ok, true); // soft → _archive/solo/{recipe.md, bricks/mine.md}
    // Plant a dir named *.md in the skill's archived bricks — the pre-fix scan would have
    // renameSync'd the WHOLE dir into bricks/ as if it were one brick (and counted it as a
    // conflict against an existing bricks/fake.md).
    write(archived(root, "solo", "bricks", "fake.md", "keep.txt"), "planted dir payload\n");
    const r = restore("solo", { root });
    assert.equal(r.ok, true, r.msg);
    assert.deepEqual(r.restored, ["mine"], "only the real archived brick FILE is restored");
    assert.equal(read(brick(root, "mine")), "exclusive brick body");
    assert.equal(has(join(root, "bricks", "fake.md")), false, "the dir was never moved into bricks/");
    // The trailing recursive rmSync consumes the archive entry (planted dir included) — that
    // cleanup is restore's documented contract; the guard here is only about never MOVING a
    // non-file into bricks/ (or counting it as a conflict).
    assert.equal(has(archived(root, "solo")), false, "archive entry consumed as usual");
  } finally { cleanup(root); }
});
