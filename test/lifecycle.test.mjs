// lifecycle: new / remove / restore / gc / rename — plus ref-counted soft-delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { create, remove, restore, gc, rename } from "../src/lifecycle.mjs";
import { run } from "../src/compose.mjs";
import { makeRoot, read, has, recipe, brick, outFile, archived, cleanup } from "./helpers.mjs";

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

test("new: refuses to overwrite an existing recipe", () => {
  const root = makeRoot({ recipes: { dup: "---\nname: dup\n---\n# dup\n" } });
  try {
    const r = create("dup", { root });
    assert.equal(r.ok, false);
    assert.match(r.msg, /already exists/);
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
