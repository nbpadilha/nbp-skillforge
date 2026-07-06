// nbp-skillforge — skill lifecycle: new / remove / restore / gc / rename.
// Ref-counted soft-delete: removing a skill archives its recipe + the bricks it EXCLUSIVELY owns
// (ref-count would drop to 0); shared bricks stay. Everything is recoverable (versioned).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, rmdirSync, renameSync, realpathSync, statSync } from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { loadConfig, run, includesOf, brickConsumers, splitFm, isConformantName, GENERATED_BANNER_RE } from "./compose.mjs";
import { installHooks } from "./hooks.mjs";
import { canonFold, isInside } from "./paths.mjs";

const mdFiles = (dir) =>
  // Normalize separators: readdirSync({recursive}) yields OS-native backslashes on Windows, but
  // include keys (brickConsumers) are always forward-slash — without this, nested bricks would be
  // mis-counted and gc/remove could archive/delete a brick that is actually in use.
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md")).map((f) => String(f).replace(/\\/g, "/")) : [];
const move = (src, dest) => { mkdirSync(dirname(dest), { recursive: true }); renameSync(src, dest); };
const uniq = (a) => [...new Set(a)];

// F-07: every lifecycle command that runs a full-project build afterward (create/remove/restore/
// rename) must say WHY it exited 1 when the action itself (write/move/delete) succeeded but the
// follow-up build failed — a bare "✗ <success-shaped message>" with no cause is a trust bug. Only
// call this AFTER `run()` has actually executed; an early-return failure (bad name, not-found,
// conflict, …) keeps its own message untouched and must never go through this composer.
//
// F-14: create/remove/restore/rename (and init's conditional build) additionally return a
// `command` field — `{ ok: true, msg: actionMsg }` — distinguishing the ACTION's own result
// (always true by the time `run()` is called: every early-return guard above already ran) from
// the full-project `build` result attached alongside it (`build` is `null` for init when no
// sample was seeded — it never calls run() then). `ok`/`msg`/`errors` stay top-level aggregates
// (msg = composeMsg(...), errors = build's) so bin/cli.mjs's finish() is unaffected by this shape.
function composeMsg(actionMsg, r) {
  if (r.ok) return actionMsg;
  const trimmed = actionMsg.replace(/\.+$/, "");
  return `${trimmed}. BUT the follow-up build failed (${r.errors.length} error(s) below) — the action itself succeeded.`;
}

// F-09: shared frontmatter `name:` rewrite, used by both `rename` (whole-file text, oldName is
// always the current fm value by construction) and `importFile` (applied to the ALREADY-split
// `fm` block only — narrower blast radius, never risks matching a `name:`-shaped line inside a
// recipe's body). Escapes regex metachars in `oldName` and accepts an optionally-quoted value;
// function replacement avoids `$` in `newName` being treated as a regex replacement token.
function rewriteFmName(txt, oldName, newName) {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return txt.replace(new RegExp(`^(name:[ \\t]*)["']?${esc}["']?[ \\t]*$`, "m"), (_m, p1) => p1 + newName);
}

// F-10: remove()/gc() can archive/delete a NESTED brick (e.g. `core/sub/deep.md`), leaving its
// now-empty parent dir(s) behind under bricks/ — cosmetic, but untidy. Climb from `dir` up toward
// (never including) `stopAt`, removing each dir only while it is truly empty; a non-empty dir
// (ENOTEMPTY) stops the climb immediately (silently — this is best-effort tidiness, not a thing
// that should ever fail the surrounding remove/gc call). Never touches anything outside `stopAt`.
function pruneEmptyDirs(dir, stopAt) {
  const stop = resolve(stopAt);
  let cur = resolve(dir);
  // C5: reuse paths.mjs's isInside (already C3-fixed for a drive-root `stop`) instead of a local
  // `cur.startsWith(stop + sep)` — the same double-separator bug (`C:\\`/`//`) made this climb a
  // silent no-op whenever `stopAt` was itself a filesystem/drive root.
  while (cur !== stop && isInside(cur, stop)) {
    try { rmdirSync(cur); } catch { break; }
    cur = dirname(cur);
  }
}

// A skill name must be a single, filesystem-safe path segment — no traversal (`..`/separators),
// Windows-reserved characters or device names, or control chars. (Naming POLICY — lowercase etc. —
// is the conformance gate's job.) Returns an error message, or null when the name is safe.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function unsafeName(skill) {
  if (!skill || skill === "." || skill === ".." || skill !== basename(skill) ||
      /[<>:"/\\|?*]/.test(skill) || [...skill].some((c) => c.charCodeAt(0) < 32) || RESERVED_DEVICE.test(skill))
    return `invalid skill name "${skill}" (single path segment only — no / \\ : * ? " < > | control chars, or reserved device names)`;
  return null;
}

// A brick path (from a recipe's include text) is only safe to move/delete if it resolves INSIDE
// the bricks dir — a crafted `<!-- include: ../victim -->` must never let remove touch outside it.
// realpath-aware so even a symlinked brick that points outside bricks/ is left untouched; falls
// back to a lexical check when the target doesn't exist yet.
const insideBricks = (P, b) => {
  const target = join(P.bricks, b + ".md");
  try {
    const real = realpathSync.native(target), base = realpathSync.native(P.bricks);
    return isInside(real, base);
  } catch {
    return resolve(target).startsWith(resolve(P.bricks) + sep);
  }
};

function paths(root, cfg = loadConfig(root)) {
  return {
    cfg,
    recipes: join(root, cfg.recipes),
    bricks: join(root, cfg.bricks),
    out: join(root, cfg.out),
    archive: join(root, cfg.archive),
  };
}

// ── new ────────────────────────────────────────────────────────────────────
export function create(skill, { root = process.cwd(), description = "TODO" } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  // A description with an embedded newline would prematurely close the frontmatter block (the
  // `---\n...\n---` parser stops at the first bare `---` line) and corrupt the scaffolded recipe.
  if (/[\r\n]/.test(description)) return { ok: false, msg: "--description must not contain a newline" };
  const P = paths(root);
  const dest = join(P.recipes, skill + ".md");
  if (existsSync(dest)) return { ok: false, msg: `recipe already exists: ${skill}` };
  mkdirSync(P.recipes, { recursive: true });
  writeFileSync(dest, `---\nname: ${skill}\ndescription: ${description}\n---\n# ${skill}\n\nTODO — write the skill here. Reuse shared bricks with an include directive (see SPEC.md).\n`);
  const r = run({ root, mode: "build" });
  const actionMsg = `recipe created: ${skill} (edit ${P.cfg.recipes}/${skill}.md, then build)`;
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, msg: composeMsg(actionMsg, r), errors: r.errors, warnings: r.warnings };
}

// ── import (onboard an existing SKILL.md/command as a recipe) ─────────────────
// Deterministic, no LLM: wraps the source file's frontmatter + body verbatim into a recipe.
// A previously-GENERATED banner is stripped so a re-import never double-banners on build.
export function importFile(srcPath, { root = process.cwd(), name, force = false } = {}) {
  const P = paths(root);
  if (!srcPath) return { ok: false, msg: "import: missing <file>" };
  if (!existsSync(srcPath)) return { ok: false, msg: `source file not found: ${srcPath}` };
  if (!statSync(srcPath).isFile()) return { ok: false, msg: `source is not a file: ${srcPath}` };

  const raw = readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n");
  const { fm, body } = splitFm(raw);
  const cleanBody = body.replace(GENERATED_BANNER_RE, "");

  // Extract the frontmatter's OWN `name:` value independently of the precedence chain below (not
  // gated on `!skill`) — F-09 needs it regardless of which precedence branch wins, to detect when
  // the final skill name diverges from what the source file's own fm declares.
  let fmName = null;
  if (fm) { const m = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m); if (m) fmName = m[1].replace(/^["'](.*)["']$/, "$1"); }

  // Name precedence: --name › frontmatter `name:` › source basename (extension stripped).
  let skill = name || fmName || basename(srcPath).replace(/\.[^./\\]+$/, "");

  const bad = unsafeName(skill); // shared guard: blocks traversal / reserved chars / device names
  if (bad) return { ok: false, msg: bad };

  const dest = join(P.recipes, skill + ".md");
  if (existsSync(dest)) {
    if (statSync(dest).isDirectory()) return { ok: false, msg: `destination is a directory, refusing: ${dest}` };
    if (!force) return { ok: false, msg: `recipe already exists: ${skill} (use --force to overwrite)` };
  }

  mkdirSync(P.recipes, { recursive: true });
  // F-09: when the final skill name (--name > fm > basename) diverges from the source's OWN fm
  // `name:` value, rewrite fm's `name:` to match — otherwise the recipe/output would publish a
  // name that disagrees with its own file identity, and the conformance gate never catches it
  // (it only validates the fm value's shape, never compares it to the filename). Applied to `fm`
  // alone (already split from body) — never the raw body — so a body line that happens to look
  // like `name: ...` (e.g. inside a fenced YAML example) is never touched.
  const fmOut = fm !== null && fmName !== null && fmName !== skill ? rewriteFmName(fm, fmName, skill) : fm;
  // fm === "" (present but empty) must NOT insert a blank line between the two fences — mirrors
  // the head-template fix in compose.mjs (same bug, same shape).
  writeFileSync(dest, fm === null ? cleanBody : `---\n${fmOut}${fmOut ? "\n" : ""}---\n${cleanBody}`);

  // Deliberately does NOT auto-build: an imported skill may not build yet (missing brick or a
  // non-conformant name), so building here could fail after a --force overwrite and leave a
  // clobbered, broken recipe. Creating the recipe is atomic; the user runs `forge build` next.
  return { ok: true, skill, msg: `imported "${skill}" → ${P.cfg.recipes}/${skill}.md. Run \`forge build\` to generate.` };
}

// ── remove (soft by default) ─────────────────────────────────────────────────
export function remove(skill, { root = process.cwd(), hard = false } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  const P = paths(root);
  // Fail CLOSED: only an explicit `--hard` or deletePolicy:"hard" hard-deletes; any other value
  // (typo, missing) is treated as soft, so a misconfig never silently destroys files.
  const policy = (hard || P.cfg.deletePolicy === "hard") ? "hard" : "soft";
  const recipePath = join(P.recipes, skill + ".md");
  if (!existsSync(recipePath)) return { ok: false, msg: `skill not found: ${skill}` };

  const includes = uniq(includesOf(readFileSync(recipePath, "utf8")));
  const consumers = brickConsumers(root, P.cfg);
  // Only consider bricks that resolve inside bricks/ for the move/delete — never act on an
  // include that escapes the tree (build already rejects it; this protects remove independently).
  const exclusive = includes.filter((b) => consumers[b] && consumers[b].size === 1 && consumers[b].has(skill) && insideBricks(P, b));
  const shared = includes
    .filter((b) => !exclusive.includes(b))
    .map((b) => ({ brick: b, alsoUsedBy: [...(consumers[b] || [])].filter((s) => s !== skill) }));

  if (policy === "soft") {
    const dir = join(P.archive, skill);
    if (existsSync(dir)) return { ok: false, msg: `conflict: already archived: ${skill} (restore it, or clear ${P.cfg.archive}/${skill} first)` };
    move(recipePath, join(dir, "recipe.md"));
    for (const b of exclusive) {
      const src = join(P.bricks, b + ".md");
      move(src, join(dir, "bricks", b + ".md"));
      pruneEmptyDirs(dirname(src), P.bricks); // F-10: don't leave an empty parent dir under bricks/
    }
  } else {
    rmSync(recipePath);
    for (const b of exclusive) {
      const src = join(P.bricks, b + ".md");
      rmSync(src);
      pruneEmptyDirs(dirname(src), P.bricks); // F-10
    }
  }
  const cmd = join(P.out, skill + ".md");
  if (existsSync(cmd)) rmSync(cmd); // the command is build output

  const r = run({ root, mode: "build" });
  const verb = policy === "soft" ? "Archived" : "Deleted";
  const actionMsg = `skill "${skill}" removed (${policy}). ` +
    `${verb}: recipe${exclusive.length ? " + " + exclusive.length + " exclusive brick(s): " + exclusive.join(", ") : ""}. ` +
    (shared.length ? `Kept (shared): ${shared.map((s) => `${s.brick} [${s.alsoUsedBy.join(",")}]`).join("; ")}.` : "No shared bricks.");
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, policy, exclusive, shared, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}

// ── restore ───────────────────────────────────────────────────────────────────
export function restore(skill, { root = process.cwd() } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  const P = paths(root);
  const dir = join(P.archive, skill);
  if (!existsSync(dir)) return { ok: false, msg: `nothing archived for: ${skill}` };
  const recDest = join(P.recipes, skill + ".md");
  if (existsSync(recDest)) return { ok: false, msg: `conflict: recipe ${skill} already exists (resolve before restoring)` };

  const conflicts = [];
  for (const rel of mdFiles(join(dir, "bricks"))) {
    if (existsSync(join(P.bricks, rel))) conflicts.push(rel);
  }
  if (conflicts.length) return { ok: false, msg: `conflict: bricks already exist: ${conflicts.join(", ")}` };

  move(join(dir, "recipe.md"), recDest);
  const restored = [];
  for (const rel of mdFiles(join(dir, "bricks"))) { move(join(dir, "bricks", rel), join(P.bricks, rel)); restored.push(rel.replace(/\.md$/, "")); }
  rmSync(dir, { recursive: true, force: true });

  const r = run({ root, mode: "build" });
  const actionMsg = `skill "${skill}" restored${restored.length ? " + bricks: " + restored.join(", ") : ""}.`;
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, restored, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}

// ── gc (orphan bricks: ref-count 0) ──────────────────────────────────────────
export function gc(root = process.cwd(), { apply = false, hard = false } = {}) {
  const P = paths(root);
  const consumers = brickConsumers(root, P.cfg);
  // Repo meta / community-health files dropped under bricks/ are documentation, never bricks —
  // so gc never reports or archives them. Matched by canonical basename, at any depth, any case.
  // The set is kept deliberately TIGHT: only names that are overwhelmingly repo-meta, not skill
  // content. Ambiguous names that are plausible brick *content* (`security`, `notice`, `authors`,
  // `funding`, …) are left OUT on purpose so a genuinely-orphan brick is still caught — over-
  // reserving would silently hide it from gc. Reserving too little only soft-deletes (recoverable);
  // reserving too much defeats gc's job, so we err toward the smaller, unambiguous set.
  const DOC_BASENAMES = /^(readme|changelog|contributing|code_of_conduct|license|licence)$/i;
  const isDoc = (b) => DOC_BASENAMES.test(String(b).split("/").pop());
  const orphans = mdFiles(P.bricks).map((f) => String(f).replace(/\.md$/, "")).filter((b) => !consumers[b] && !isDoc(b));
  if (apply && orphans.length) {
    const policy = (hard || P.cfg.deletePolicy === "hard") ? "hard" : "soft"; // fail closed to soft
    for (const b of orphans) {
      const src = join(P.bricks, b + ".md");
      if (policy === "hard") { rmSync(src); pruneEmptyDirs(dirname(src), P.bricks); continue; } // F-10
      // Version the archive target so re-archiving a same-named orphan never clobbers a prior one.
      let dest = join(P.archive, "_orphans", b + ".md"), n = 1;
      while (existsSync(dest)) dest = join(P.archive, "_orphans", `${b}.${n++}.md`);
      move(src, dest);
      pruneEmptyDirs(dirname(src), P.bricks); // F-10
    }
  }
  return { ok: true, orphans, applied: apply,
    msg: orphans.length ? `${orphans.length} orphan brick(s): ${orphans.join(", ")}${apply ? " — archived" : " (run with --apply to archive)"}` : "no orphan bricks." };
}

// ── init (scaffold a forge project) ──────────────────────────────────────────
// Purely additive & idempotent: writes forge.config.json only if absent (never overwrites,
// so custom config keys are safe), seeds a sample only when there are no recipes yet, and
// builds only that fresh sample (an already-initialized project is left exactly as-is).
// Also installs the pre-commit drift-gate hook best-effort (opt out with { hooks:false }) so a
// fresh npm consumer gets it in one step — never fatal, never clobbering (see the hook note below).
export function init(root = process.cwd(), { hooks = true } = {}) {
  const cfg = loadConfig(root);
  const P = paths(root, cfg);
  const created = [];
  const rel = (p) => relative(root, p).replace(/\\/g, "/");

  const cfgPath = join(root, "forge.config.json");
  if (!existsSync(cfgPath)) {
    const { bricks, recipes, out, archive, deletePolicy, enforceGenerated } = cfg;
    writeFileSync(cfgPath, JSON.stringify({ bricks, recipes, out, archive, deletePolicy, enforceGenerated }, null, 2) + "\n");
    created.push("forge.config.json");
  }

  mkdirSync(P.bricks, { recursive: true });
  mkdirSync(P.recipes, { recursive: true });

  // Seed a sample only when it is provably safe: no recipes yet, bricks/recipes are distinct
  // dirs, and none of the sample's targets (brick, recipe, built output) already exist — so we
  // can never overwrite a user's footer brick, hello recipe, or a hand-written hello command.
  let build = null;
  const brickPath = join(P.bricks, "footer.md");
  const recipePath = join(P.recipes, "hello.md");
  const outPath = join(P.out, "hello.md");
  const hasRecipes = readdirSync(P.recipes).some((f) => f.endsWith(".md"));
  // Canonicalize so the bricks/recipes/out roles must be three genuinely distinct dirs (realpath
  // resolves symlinks/trailing slashes; falls back to resolve() for a dir that doesn't exist yet).
  // C7: canonFold (not plain canon) — realpath only folds case for you once a dir actually EXISTS
  // on a case-insensitive FS (win32/darwin); here bricks/out can both be simultaneously
  // nonexistent (fresh project, pre-first-build, same structural reason compose.mjs's role-
  // overlap check needs canonFold too — see paths.mjs), so a case-only collision (`bricks: "foo"`
  // vs `out: "FOO"`) would otherwise slip past as "3 distinct dirs" and let init seed the sample
  // into colliding folders. If any two coincide, the build would treat a brick as a recipe or
  // overwrite a recipe with its output — so skip the sample.
  const distinctRoles = new Set([canonFold(P.bricks), canonFold(P.recipes), canonFold(P.out)]).size === 3;
  const sampleSafe = !hasRecipes && distinctRoles &&
    !existsSync(brickPath) && !existsSync(recipePath) && !existsSync(outPath);
  if (sampleSafe) {
    writeFileSync(brickPath, `---\npiece: footer\nsummary: shared closing line, parameterized by project\n---\n_Generated for **{{project}}** by nbp-skillforge — edit the recipe/brick, not this file._\n`);
    writeFileSync(recipePath, `---\nname: hello\ndescription: sample skill — replace me\n---\n# hello\n\nThis is a sample skill. Reuse shared bricks with an include directive:\n\n<!-- include: footer | project=my-app -->\n`);
    created.push(rel(brickPath), rel(recipePath));
    build = run({ root, mode: "build" }); // build only the sample we just seeded
  }

  // Best-effort pre-commit hook install so a fresh consumer gets the drift-gate without a second
  // command. NON-FATAL and NON-CLOBBERING: no --force (a foreign pre-commit is left untouched and
  // merely reported), and a non-git dir just reports back — init's success never hinges on it.
  const hook = hooks ? installHooks({ root, onlyRoot: true }) : null;
  const hookNote = !hook ? ""
    : hook.ok ? (hook.already ? "" : `\n  ✔ installed the pre-commit hook (drift-gate + secret scan).`)
    : `\n  · pre-commit hook not installed (${hook.msg}). Run \`npx nbp-skillforge install-hooks\` when ready.`;

  // F-14: init's own action (scaffold config/dirs, optionally seed+build a sample) always
  // succeeds by this point — every early-exit guard already ran — so `command.ok` is always
  // true here too; `build` is `null` when no sample was seeded (sampleSafe was false), the only
  // lifecycle function where that field is genuinely absent rather than a run() result.
  const actionMsg = (created.length ? `initialized forge: ${created.join(", ")}` : "forge already initialized (nothing to scaffold)") +
    `. Edit ${cfg.recipes}/, then \`forge build\`.`;
  return { ok: build ? build.ok : true, command: { ok: true, msg: actionMsg }, created, build, hook,
    errors: build?.errors ?? [], msg: actionMsg + hookNote };
}

// ── list (skills → bricks, with ref-count / blast radius) ─────────────────────
export function list(root = process.cwd()) {
  const P = paths(root);
  if (!existsSync(P.recipes)) return { ok: false, msg: `no recipes directory: ${P.cfg.recipes} — run \`npx nbp-skillforge init\` to scaffold a forge project`, skills: [], bricks: [] };
  const consumers = brickConsumers(root, P.cfg);
  const skills = readdirSync(P.recipes).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")).sort();
  const perSkill = skills.map((s) => ({ skill: s, bricks: uniq(includesOf(readFileSync(join(P.recipes, s + ".md"), "utf8"))) }));
  const bricks = Object.entries(consumers)
    .map(([brick, set]) => ({ brick, refCount: set.size, usedBy: [...set].sort() }))
    .sort((a, b) => b.refCount - a.refCount || a.brick.localeCompare(b.brick));
  return { ok: true, skills: perSkill, bricks, msg: `${skills.length} skill(s), ${bricks.length} brick(s).` };
}

// ── rename ─────────────────────────────────────────────────────────────────────
export function rename(oldName, newName, { root = process.cwd() } = {}) {
  const badOld = unsafeName(oldName); if (badOld) return { ok: false, msg: badOld };
  const badNew = unsafeName(newName); if (badNew) return { ok: false, msg: badNew };
  const P = paths(root);
  const src = join(P.recipes, oldName + ".md");
  const dest = join(P.recipes, newName + ".md");
  if (!existsSync(src)) return { ok: false, msg: `skill not found: ${oldName}` };
  if (existsSync(dest)) return { ok: false, msg: `target already exists: ${newName}` };

  const raw = readFileSync(src, "utf8");
  const { fm, body } = splitFm(raw.replace(/\r\n/g, "\n"));
  // C6/F-09: the recipe's OWN fm `name:` value — may differ from `oldName` (the filename) when
  // they've drifted apart. Extracted the same way importFile does (quotes stripped), so a STALE
  // fm name is corrected regardless of how it got out of sync with the filename, instead of
  // silently surviving the rename because it never matched `oldName` in the first place.
  let fmName = null;
  if (fm !== null) {
    const m = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m);
    if (m) fmName = m[1].replace(/^["'](.*)["']$/, "$1");
  }

  // F-08: pre-validate the new name against the SAME conformance gate the build enforces, before
  // touching disk. Without this, a rename to a non-conformant name would delete the old output
  // (below) and move the recipe, only for the follow-up build to then refuse to (re)generate the
  // new one — leaving out/ empty and a misleadingly success-shaped message. Only gated when the
  // recipe actually HAS frontmatter with a `name:` field: a recipe with no frontmatter (e.g. a
  // plain slash-command) is not subject to the SKILL.md name gate, so rename proceeds normally.
  if (P.cfg.conformance && fmName !== null && !isConformantName(newName)) {
    return { ok: false, msg: `rename blocked: "${newName}" is not a conformant skill name (lowercase a-z/0-9, hyphen-separated, ≤64) — rename would delete the old output and the build would refuse the new one` };
  }

  // C6: scope the name rewrite to the FRONTMATTER BLOCK ONLY, using the recipe's ACTUAL fm name —
  // never the whole raw file (the old bug: a NO-frontmatter recipe whose BODY happens to contain
  // a `name: <old>`-shaped line, e.g. inside a fenced YAML example, had that body line silently
  // corrupted by a whole-file rewrite). Mirrors importFile's write shape exactly. rename now
  // ALWAYS sets the fm name to `newName` (the new identity) whenever fm HAS a `name:` field — even
  // when that field never matched the OLD filename — consistent with F-09's "the recipe must
  // never disagree with its own identity" decision; this is an intended behavior improvement over
  // the old "only rewrite if the fm name literally equals oldName" gap. When there is no
  // frontmatter, or fm has no `name:` field at all, the file is written back byte-for-byte
  // UNCHANGED (no write at all) — a plain slash-command has no SKILL.md identity to rewrite, and
  // its body must never be touched.
  if (fmName !== null) {
    const fmOut = rewriteFmName(fm, fmName, newName);
    writeFileSync(src, `---\n${fmOut}${fmOut ? "\n" : ""}---\n${body}`);
  }
  move(src, dest);
  const oldCmd = join(P.out, oldName + ".md");
  if (existsSync(oldCmd)) rmSync(oldCmd); // old command is now an orphan
  const r = run({ root, mode: "build" });
  const actionMsg = `skill "${oldName}" → "${newName}" (old command removed, new one generated).`;
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}
