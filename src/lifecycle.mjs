// nbp-skillforge — skill lifecycle: new / remove / restore / gc / rename.
// Ref-counted soft-delete: removing a skill archives its recipe + the bricks it EXCLUSIVELY owns
// (ref-count would drop to 0); shared bricks stay. Everything is recoverable (versioned).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, rmdirSync, renameSync, realpathSync, statSync } from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { loadConfig, run, includesOf, brickConsumers, splitFm, isConformantName, GENERATED_BANNER_RE, hasForgeRole, roleOverlapError } from "./compose.mjs";
import { installHooks } from "./hooks.mjs";
import { canonFold, isInside, allDistinct } from "./paths.mjs";

const mdFiles = (dir) =>
  // Normalize separators: readdirSync({recursive}) yields OS-native backslashes on Windows, but
  // include keys (brickConsumers) are always forward-slash — without this, nested bricks would be
  // mis-counted and gc/remove could archive/delete a brick that is actually in use.
  //
  // FILES ONLY (cross-vendor review HIGH, proven by execution): readdirSync({recursive}) returns
  // DIRECTORY entries too, and a directory named `*.md` (e.g. bricks/orphan.md/) passed the
  // suffix filter — gc then listed it as an orphan "brick" and --apply --hard crashed with a raw
  // ERR_FS_EISDIR on the non-recursive rmSync (soft's renameSync would instead have MOVED the
  // whole tree into the archive as if it were one brick); restore's archive scan had the same
  // hole (a dir named `*.md` would be renamed wholesale into bricks/). A brick is a FILE by
  // definition, so stat each hit and keep regular files only; a stat failure excludes (fail
  // closed — an entry a sweep cannot even stat is nothing it should act on). Deliberately NOT
  // readdirSync({recursive, withFileTypes}): the support floor is Node ≥ 18 and Dirent.path/
  // parentPath is unstable across versions — the string list + statSync is the portable form.
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .filter((f) => String(f).endsWith(".md"))
        .filter((f) => { try { return statSync(join(dir, String(f))).isFile(); } catch { return false; } })
        .map((f) => String(f).replace(/\\/g, "/"))
    : [];
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

// F-35: a brick whose frontmatter says `keep: true` is PINNED — exempt from every auto-archival
// sweep (gc's orphan sweep and remove's exclusive-brick sweep), even under --apply --hard. This is
// the escape hatch for an intentionally-orphan brick (e.g. staging content not yet wired into a
// recipe) that gc would otherwise keep re-archiving. The matcher mirrors compose.mjs's
// FORGE_ROLE_RE shape exactly: line-anchored, optionally SAME-quoted value via backreference
// (`("|')?true\1` — an unparticipated group's backreference matches the empty string, so unquoted
// passes and mismatched quotes fail), `\r?` before `$` so a caller-side CRLF slip stays immune.
// FAIL-CLOSED by construction: any other value (`false`, `yes`, `"maybe"`), a missing field, no
// frontmatter at all, or a read/parse error = NOT pinned — a pin must be an explicit, well-formed
// opt-in, never something a parse hiccup grants (an accidental pin would silently defeat gc).
// Brick fm is advisory and dropped on build, so the field never leaks into generated output.
const KEEP_RE = /^keep:[ \t]*("|')?true\1[ \t]*\r?$/m;
const isPinned = (P, b) => {
  try {
    const { fm } = splitFm(readFileSync(join(P.bricks, b + ".md"), "utf8").replace(/\r\n?/g, "\n"));
    return fm !== null && KEEP_RE.test(fm);
  } catch { return false; } // unreadable brick → not pinned (the sweep's own fs calls will surface real errors)
};
// A `keep:` field that is PRESENT but not well-formed (`keep: True`, `keep: yes`, mismatched
// quotes, …) still means "not pinned" — the fail-closed rule above is intact — but it is the one
// spot where fail-closed can silently cross the user's INTENT: under `--apply --hard` /
// deletePolicy:"hard" the brick they tried to pin is deleted permanently, indistinguishable from
// one with no keep at all (athena triage, proven by execution: `keep: True` deleted, no archive,
// no hint). So the sweeps WARN — same fm read as isPinned, only ever run on the rare sweep
// CANDIDATES (the F-35 cost posture); pinning behavior itself does not change here.
const KEEP_FIELD_RE = /^keep:/m;
const hasMalformedKeep = (P, b) => {
  try {
    const { fm } = splitFm(readFileSync(join(P.bricks, b + ".md"), "utf8").replace(/\r\n?/g, "\n"));
    return fm !== null && KEEP_FIELD_RE.test(fm) && !KEEP_RE.test(fm);
  } catch { return false; } // unreadable → nothing to warn about (mirrors isPinned's stance)
};
// The shared warning text (gc + remove): says what was found, what it did NOT do, and the one
// well-formed spelling — so the user can fix the pin BEFORE a permanent --hard sweep eats it.
const malformedKeepWarning = (suspects) =>
  suspects.length ? ` warning: keep field present but not well-formed (NOT pinned): ${suspects.join(", ")} — only \`keep: true\` pins (see SPEC).` : "";

// A file is only GOVERNABLE (listable/movable/deletable) by a sweep if it RESOLVES inside its
// base dir — realpath-aware, so a path that merely SITS under the base lexically but crosses a
// junction/symlink (either the file itself, or any ancestor directory component) to somewhere
// outside is out of bounds. Falls back to a lexical check when the target doesn't exist yet
// (nothing to realpath — and nothing a sweep could destroy either).
const resolvesInside = (baseDir, target) => {
  try {
    return isInside(realpathSync.native(target), realpathSync.native(baseDir));
  } catch {
    return resolve(target).startsWith(resolve(baseDir) + sep);
  }
};
// A brick path (from a recipe's include text) is only safe to move/delete if it resolves INSIDE
// the bricks dir — a crafted `<!-- include: ../victim -->` must never let remove touch outside it.
// realpath-aware so even a symlinked brick that points outside bricks/ is left untouched.
const insideBricks = (P, b) => resolvesInside(P.bricks, join(P.bricks, b + ".md"));

function paths(root, cfg = loadConfig(root)) {
  return {
    cfg,
    recipes: join(root, cfg.recipes),
    bricks: join(root, cfg.bricks),
    // F-26 (DECISION 3): the singular `out` is deliberately GONE — `outs` (always an array) is the
    // sole destination surface, so a future call site can't silently ignore out[1..] by reaching
    // for a singular path. Only cfg.out (as authored, string-or-array) survives, for init's
    // config-scaffold round-trip.
    outs: cfg.outs.map((o) => join(root, o)),
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
  // Same pre-flight as its siblings (remove/rename/restore/gc): create was the ONE mutant without
  // it — it wrote the recipe FIRST and only then had the follow-up run() reject the config, so a
  // hostile layout (out == bricks, or recipes nested inside bricks) exited 1 yet left the new
  // recipe on disk — worse, `recipes` inside `bricks` means the write itself landed INSIDE the
  // bricks tree. Fail closed before touching disk.
  const overlap = roleOverlapError(root, P.cfg);
  if (overlap) return { ok: false, msg: overlap };
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

  // Strip a leading BOM alongside the CRLF normalization — a BOM'd source would silently defeat
  // splitFm's ^--- anchor and import the whole frontmatter as body text (found in the F-31 dual
  // review, verified by execution). The engine's own output is always BOM-less LF.
  const raw = readFileSync(srcPath, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const { fm, body } = splitFm(raw);
  // Fable B10: tolerate blank lines between the fm and a previous GENERATED banner (an editor
  // artifact) — without this, only a banner at the exact body start was stripped and the next
  // build double-bannered. The blank lines themselves are preserved only when NO banner follows
  // (a legitimate leading gap in a hand-written file is content, not artifact).
  const LENIENT_BANNER_RE = new RegExp(`^\\n*${GENERATED_BANNER_RE.source.replace(/^\^/, "")}`); // strip the anchor safely, not positionally
  const cleanBody = body.replace(LENIENT_BANNER_RE, "");


  // Extract the frontmatter's OWN `name:` value independently of the precedence chain below (not
  // gated on `!skill`) — F-09 needs it regardless of which precedence branch wins, to detect when
  // the final skill name diverges from what the source file's own fm declares.
  let fmName = null;
  if (fm) { const m = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m); if (m) fmName = m[1].replace(/^["'](.*)["']$/, "$1"); }

  // Name precedence: --name › frontmatter `name:` › source basename (extension stripped).
  let skill = name || fmName || basename(srcPath).replace(/\.[^./\\]+$/, "");

  const bad = unsafeName(skill); // shared guard: blocks traversal / reserved chars / device names
  if (bad) return { ok: false, msg: bad };

  // F-31: a source carrying the forge-role marker is nbp-skillforge's OWN tooling (e.g. the
  // ephemeral forge-onboard skill) — importing it turns a package tool into a user recipe, which
  // is almost never intended (and would leak the marker into the generated output, excluding it
  // from future onboarding scans forever). WARN, don't block: the user may genuinely want it, and
  // a hard refusal here would be a policy call the engine has no business making. Emitted after
  // name resolution so the message carries the [skill] tag, same shape as build's warnings.
  const warnings = [];
  if (hasForgeRole(fm)) warnings.push(`warning: [${skill}] source carries the forge-role marker (nbp-skillforge tooling) — importing it turns the tool into a user recipe; remove the marker from the recipe if this was intended`);

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
  // `warnings` rides the same non-blocking channel build/check use — bin/cli.mjs's finish()
  // already prints r.warnings unconditionally, so no CLI change is needed for the F-31 warn.
  return { ok: true, skill, msg: `imported "${skill}" → ${P.cfg.recipes}/${skill}.md. Run \`forge build\` to generate.`, warnings };
}

// ── remove (soft by default) ─────────────────────────────────────────────────
export function remove(skill, { root = process.cwd(), hard = false } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  const P = paths(root);
  // F-26 review fix (destructive repro): with a hostile `out` entry overlapping bricks/, the
  // P.outs deletion below would destroy a SOURCE brick before the follow-up run() ever rejected
  // the config. Fail CLOSED before touching anything — same check, same message, just pre-flight.
  const overlap = roleOverlapError(root, P.cfg);
  if (overlap) return { ok: false, msg: overlap };
  // Fail CLOSED: only an explicit `--hard` or deletePolicy:"hard" hard-deletes; any other value
  // (typo, missing) is treated as soft, so a misconfig never silently destroys files.
  const policy = (hard || P.cfg.deletePolicy === "hard") ? "hard" : "soft";
  const recipePath = join(P.recipes, skill + ".md");
  if (!existsSync(recipePath)) return { ok: false, msg: `skill not found: ${skill}` };

  const includes = uniq(includesOf(readFileSync(recipePath, "utf8")));
  const consumers = brickConsumers(root, P.cfg);
  // Cross-vendor review HIGH (proven by execution): an EXCLUSIVE brick whose on-disk target is a
  // DIRECTORY squatting `<name>.md` used to crash remove AFTER the recipe was already deleted —
  // hard: rmSync (non-recursive) threw a raw ERR_FS_EISDIR mid-sweep; soft: renameSync would have
  // moved the WHOLE tree into the archive as one "brick". Either way the follow-up build never
  // ran (recipe gone, state inconsistent). A brick is a FILE: a non-file (or unstatable — fail
  // closed, same stance as mdFiles) target is simply never swept — it stays on disk untouched,
  // lands in the Kept bucket below (same reporting path as an insideBricks-failing include, so
  // the keep is never silent), and remove completes cleanly.
  const isBrickFile = (b) => { try { return statSync(join(P.bricks, b + ".md")).isFile(); } catch { return false; } };
  // Only consider bricks that resolve inside bricks/ AND are regular files for the move/delete —
  // never act on an include that escapes the tree (build already rejects it; this protects
  // remove independently) or on a non-file squatting the brick path.
  const sweepable = includes.filter((b) => consumers[b] && consumers[b].size === 1 && consumers[b].has(skill) && insideBricks(P, b) && isBrickFile(b));
  // F-35: a PINNED exclusive brick leaves the sweep entirely — never archived, never deleted,
  // even with --hard. It becomes a pinned orphan afterward, which is coherent: gc's own sweep
  // exempts it for the same reason. fm is read only for the rare sweep CANDIDATES (cheap).
  const pinned = sweepable.filter((b) => isPinned(P, b));
  const exclusive = sweepable.filter((b) => !pinned.includes(b));
  // Malformed-keep warning (athena triage): a `keep: True`/`keep: yes` brick lands in `exclusive`
  // and IS swept below — correct (fail-closed) but the user tried to pin it, so warn. Computed
  // BEFORE the sweep: after a --hard delete the fm is gone and could no longer be read.
  const suspectKeep = exclusive.filter((b) => hasMalformedKeep(P, b));
  const shared = includes
    .filter((b) => !sweepable.includes(b))
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
  // F-26: the generated command is deleted from EVERY out dir that has it (silently skip one
  // where it was never built — same if-exists guard as before, just looped).
  for (const outDir of P.outs) {
    const cmd = join(outDir, skill + ".md");
    if (existsSync(cmd)) rmSync(cmd); // the command is build output
  }

  const r = run({ root, mode: "build" });
  const verb = policy === "soft" ? "Archived" : "Deleted";
  const actionMsg = `skill "${skill}" removed (${policy}). ` +
    `${verb}: recipe${exclusive.length ? " + " + exclusive.length + " exclusive brick(s): " + exclusive.join(", ") : ""}. ` +
    // F-35: a pin must never be silent — the user asked to remove and the tool kept something.
    (pinned.length ? `Kept (pinned): ${pinned.join(", ")}. ` : "") +
    (shared.length ? `Kept (shared): ${shared.map((s) => `${s.brick} [${s.alsoUsedBy.join(",")}]`).join("; ")}.` : "No shared bricks.") +
    malformedKeepWarning(suspectKeep);
  // `pinned`/`suspectKeep` are ADDITIVE on the --json shape (F-35 + the malformed-keep warning) —
  // every pre-existing field is unchanged.
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, policy, exclusive, pinned, suspectKeep, shared, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}

// ── restore ───────────────────────────────────────────────────────────────────
export function restore(skill, { root = process.cwd() } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  const P = paths(root);
  // Same pre-flight as remove/rename/gc: restore MOVES files into recipes/ and bricks/ — a
  // role-overlapping config must be refused before anything lands in a colliding tree.
  const overlap = roleOverlapError(root, P.cfg);
  if (overlap) return { ok: false, msg: overlap };
  const dir = join(P.archive, skill);
  if (!existsSync(dir)) return { ok: false, msg: `nothing archived for: ${skill}` };
  const recDest = join(P.recipes, skill + ".md");
  if (existsSync(recDest)) return { ok: false, msg: `conflict: recipe ${skill} already exists (resolve before restoring)` };

  // Same reparse-point exposure as gc's orphan scan (see there): mdFiles descends a junction/
  // symlinked dir a user may have placed under the archive, so an unguarded loop would (a) count
  // EXTERNAL files as restore conflicts and (b) `move` them — renameSync THROUGH the junction —
  // i.e. rip real files out of the user's linked folder into bricks/. Lower risk than gc (the
  // forge itself never creates links in the archive; one can only appear by hand), but the guard
  // is the same realpath containment: only entries that RESOLVE inside this skill's archived
  // bricks dir are conflicts/restorable. The trailing rmSync(recursive) is safe on what's left —
  // node's fs.rm never traverses a reparse point, it unlinks the junction itself (target
  // contents untouched; verified by the regression test's checksum).
  const archBricks = join(dir, "bricks");
  const restorable = mdFiles(archBricks).filter((rel) => resolvesInside(archBricks, join(archBricks, rel)));
  const conflicts = [];
  for (const rel of restorable) {
    if (existsSync(join(P.bricks, rel))) conflicts.push(rel);
  }
  if (conflicts.length) return { ok: false, msg: `conflict: bricks already exist: ${conflicts.join(", ")}` };

  move(join(dir, "recipe.md"), recDest);
  const restored = [];
  for (const rel of restorable) { move(join(archBricks, rel), join(P.bricks, rel)); restored.push(rel.replace(/\.md$/, "")); }
  rmSync(dir, { recursive: true, force: true });

  const r = run({ root, mode: "build" });
  const actionMsg = `skill "${skill}" restored${restored.length ? " + bricks: " + restored.join(", ") : ""}.`;
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, restored, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}

// ── gc (orphan bricks: ref-count 0) ──────────────────────────────────────────
export function gc(root = process.cwd(), { apply = false, hard = false } = {}) {
  const P = paths(root);
  // Fable B2 (CONFIRMED destructive): with a role-overlapping config (e.g. recipes nested inside
  // bricks), gc's recursive bricks scan lists RECIPES as "orphan bricks" and --apply --hard
  // deletes them permanently — build/check refuse such a config, and remove/rename already fail
  // closed pre-flight (F-26 review); gc gets the same guard.
  const overlap = roleOverlapError(root, P.cfg);
  if (overlap) return { ok: false, msg: overlap };
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
  // CRITICAL (release-readiness bug, proven by execution): mdFiles' readdirSync({recursive})
  // DESCENDS reparse points — a junction/symlinked DIRECTORY inside bricks/ (e.g. a user linking
  // a folder of notes in) listed the EXTERNAL files as "orphan bricks", and --apply then
  // archived/deleted the REAL files THROUGH the junction (hard = permanent data loss outside the
  // project). Same realpath-containment guard remove() has always had (insideBricks): a path that
  // does not RESOLVE inside bricks/ is not a governable brick — never listed as an orphan, never
  // touched, not even reported (it isn't ours to report). Ordered last: realpath runs only on the
  // rare candidates that survived the cheap consumer/doc filters.
  const candidates = mdFiles(P.bricks).map((f) => String(f).replace(/\.md$/, "")).filter((b) => !consumers[b] && !isDoc(b) && insideBricks(P, b));
  // F-35: PINNED bricks (`keep: true` in the brick's own fm) leave the orphan set entirely —
  // never archived/deleted, even with --apply --hard. fm is read only for the rare orphan
  // CANDIDATES (never every brick), same cost posture as check()'s F-31 orphan scan.
  const pinned = candidates.filter((b) => isPinned(P, b));
  const orphans = candidates.filter((b) => !pinned.includes(b));
  // Malformed-keep warning (athena triage): computed BEFORE the apply sweep below — after a hard
  // delete/archive the brick's fm is gone from disk and hasMalformedKeep could no longer read it.
  const suspectKeep = orphans.filter((b) => hasMalformedKeep(P, b));
  const policy = (hard || P.cfg.deletePolicy === "hard") ? "hard" : "soft"; // fail closed to soft
  if (apply && orphans.length) {
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
  // Fable B7: the message must say what actually happened — "archived" for a hard delete lied
  // about a permanent, unrecoverable operation.
  // The dry-run hint is policy-aware too — "run with --apply to archive" under deletePolicy:
  // "hard" would promise recoverability the actual apply doesn't offer.
  // F-35: pins are reported, never silent — an invisible "gc did nothing to x" would read as a
  // bug the next time the user looks for x among the orphans. `pinned` is ADDITIVE on the --json
  // shape; `orphans`/`applied`/`msg`'s existing text are unchanged when nothing is pinned.
  // `suspectKeep` is ADDITIVE on the --json shape (same stance as F-35's `pinned`) and the
  // warning text is APPENDED — the pre-existing msg is byte-identical when nothing is malformed.
  return { ok: true, orphans, pinned, suspectKeep, applied: apply,
    msg: (orphans.length ? `${orphans.length} orphan brick(s): ${orphans.join(", ")}${apply ? (policy === "hard" ? " — deleted (permanent)" : " — archived") : ` (run with --apply to ${policy === "hard" ? "delete permanently" : "archive"})`}` : "no orphan bricks.") +
      (pinned.length ? ` ${pinned.length} pinned brick(s) kept: ${pinned.join(", ")}.` : "") +
      malformedKeepWarning(suspectKeep) };
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
    // The scaffold spells out EVERY documented config key (SPEC "Config") — `conformance` was
    // missing, so a fresh project had no visible handle on the SKILL.md gate. `out` survives
    // as authored (string, never the derived `outs` array) — the round-trip contract.
    const { bricks, recipes, out, archive, deletePolicy, enforceGenerated, conformance } = cfg;
    writeFileSync(cfgPath, JSON.stringify({ bricks, recipes, out, archive, deletePolicy, enforceGenerated, conformance }, null, 2) + "\n");
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
  // F-26: the sample is unsafe if hello.md already exists in ANY out dir — a hand-written
  // hello command sitting in out[1] must be exactly as protected as one in out[0].
  const outPaths = P.outs.map((o) => join(o, "hello.md"));
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
  // F-26: bricks, recipes and EVERY out entry must be pairwise-distinct (allDistinct — shared
  // check, own failure handling: init silently downgrades sampleSafe instead of erroring, because
  // init's job is "scaffold what's safe", not "validate the whole config" — build/check does that).
  const distinctRoles = allDistinct([canonFold(P.bricks), canonFold(P.recipes), ...P.outs.map(canonFold)]);
  const sampleSafe = !hasRecipes && distinctRoles &&
    !existsSync(brickPath) && !existsSync(recipePath) && !outPaths.some(existsSync);
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
  // F-26 review fix: same pre-flight as remove() — rename deletes the old output from every out
  // dir before its follow-up build; a role-overlapping config must be refused before any mutation.
  const overlap = roleOverlapError(root, P.cfg);
  if (overlap) return { ok: false, msg: overlap };
  const src = join(P.recipes, oldName + ".md");
  const dest = join(P.recipes, newName + ".md");
  if (!existsSync(src)) return { ok: false, msg: `skill not found: ${oldName}` };
  if (existsSync(dest)) return { ok: false, msg: `target already exists: ${newName}` };

  const raw = readFileSync(src, "utf8");
  const { fm, body } = splitFm(raw.replace(/\r\n?/g, "\n"));
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
  // F-26: the stale old-named output is removed from every out dir that has it, before the
  // follow-up build regenerates the new name into every out dir.
  for (const outDir of P.outs) {
    const oldCmd = join(outDir, oldName + ".md");
    if (existsSync(oldCmd)) rmSync(oldCmd); // old command is now an orphan
  }
  const r = run({ root, mode: "build" });
  const actionMsg = `skill "${oldName}" → "${newName}" (old command removed, new one generated).`;
  return { ok: r.ok, command: { ok: true, msg: actionMsg }, build: r, errors: r.errors, warnings: r.warnings, msg: composeMsg(actionMsg, r) };
}
