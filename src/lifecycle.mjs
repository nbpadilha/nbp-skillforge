// nbp-forge — skill lifecycle: new / remove / restore / gc / rename.
// Ref-counted soft-delete: removing a skill archives its recipe + the bricks it EXCLUSIVELY owns
// (ref-count would drop to 0); shared bricks stay. Everything is recoverable (versioned).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, realpathSync, statSync } from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { loadConfig, run, includesOf, brickConsumers, splitFm, GENERATED_BANNER_RE } from "./compose.mjs";

const mdFiles = (dir) =>
  // Normalize separators: readdirSync({recursive}) yields OS-native backslashes on Windows, but
  // include keys (brickConsumers) are always forward-slash — without this, nested bricks would be
  // mis-counted and gc/remove could archive/delete a brick that is actually in use.
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md")).map((f) => String(f).replace(/\\/g, "/")) : [];
const move = (src, dest) => { mkdirSync(dirname(dest), { recursive: true }); renameSync(src, dest); };
const uniq = (a) => [...new Set(a)];

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
    return real === base || real.startsWith(base + sep);
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
export function create(skill, { root = process.cwd() } = {}) {
  const bad = unsafeName(skill);
  if (bad) return { ok: false, msg: bad };
  const P = paths(root);
  const dest = join(P.recipes, skill + ".md");
  if (existsSync(dest)) return { ok: false, msg: `recipe already exists: ${skill}` };
  mkdirSync(P.recipes, { recursive: true });
  writeFileSync(dest, `---\nname: ${skill}\ndescription: TODO\n---\n# ${skill}\n\nTODO — write the skill here. Reuse shared bricks with an include directive (see SPEC.md).\n`);
  const r = run({ root, mode: "build" });
  return { ok: r.ok, msg: `recipe created: ${skill} (edit ${P.cfg.recipes}/${skill}.md, then build)`, build: r };
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

  // Name precedence: --name › frontmatter `name:` › source basename (extension stripped).
  let skill = name;
  if (!skill && fm) { const m = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m); if (m) skill = m[1].replace(/^["'](.*)["']$/, "$1"); }
  if (!skill) skill = basename(srcPath).replace(/\.[^./\\]+$/, "");

  const bad = unsafeName(skill); // shared guard: blocks traversal / reserved chars / device names
  if (bad) return { ok: false, msg: bad };

  const dest = join(P.recipes, skill + ".md");
  if (existsSync(dest)) {
    if (statSync(dest).isDirectory()) return { ok: false, msg: `destination is a directory, refusing: ${dest}` };
    if (!force) return { ok: false, msg: `recipe already exists: ${skill} (use --force to overwrite)` };
  }

  mkdirSync(P.recipes, { recursive: true });
  writeFileSync(dest, fm !== null ? `---\n${fm}\n---\n${cleanBody}` : cleanBody);

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
    for (const b of exclusive) move(join(P.bricks, b + ".md"), join(dir, "bricks", b + ".md"));
  } else {
    rmSync(recipePath);
    for (const b of exclusive) rmSync(join(P.bricks, b + ".md"));
  }
  const cmd = join(P.out, skill + ".md");
  if (existsSync(cmd)) rmSync(cmd); // the command is build output

  const r = run({ root, mode: "build" });
  const verb = policy === "soft" ? "Archived" : "Deleted";
  return { ok: r.ok, policy, exclusive, shared, msg:
    `skill "${skill}" removed (${policy}). ` +
    `${verb}: recipe${exclusive.length ? " + " + exclusive.length + " exclusive brick(s): " + exclusive.join(", ") : ""}. ` +
    (shared.length ? `Kept (shared): ${shared.map((s) => `${s.brick} [${s.alsoUsedBy.join(",")}]`).join("; ")}.` : "No shared bricks.") };
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
  return { ok: r.ok, restored, msg: `skill "${skill}" restored${restored.length ? " + bricks: " + restored.join(", ") : ""}.` };
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
      if (policy === "hard") { rmSync(join(P.bricks, b + ".md")); continue; }
      // Version the archive target so re-archiving a same-named orphan never clobbers a prior one.
      let dest = join(P.archive, "_orphans", b + ".md"), n = 1;
      while (existsSync(dest)) dest = join(P.archive, "_orphans", `${b}.${n++}.md`);
      move(join(P.bricks, b + ".md"), dest);
    }
  }
  return { ok: true, orphans, applied: apply,
    msg: orphans.length ? `${orphans.length} orphan brick(s): ${orphans.join(", ")}${apply ? " — archived" : " (run with --apply to archive)"}` : "no orphan bricks." };
}

// ── init (scaffold a forge project) ──────────────────────────────────────────
// Purely additive & idempotent: writes forge.config.json only if absent (never overwrites,
// so custom config keys are safe), seeds a sample only when there are no recipes yet, and
// builds only that fresh sample (an already-initialized project is left exactly as-is).
export function init(root = process.cwd()) {
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
  // Canonicalize so the bricks/recipes/out roles must be three genuinely distinct dirs
  // (realpath resolves symlinks, trailing slashes, and case on case-insensitive FS; falls
  // back to resolve() for a dir that doesn't exist yet). If any two coincide, the build would
  // treat a brick as a recipe or overwrite a recipe with its output — so skip the sample.
  const canon = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const distinctRoles = new Set([canon(P.bricks), canon(P.recipes), canon(P.out)]).size === 3;
  const sampleSafe = !hasRecipes && distinctRoles &&
    !existsSync(brickPath) && !existsSync(recipePath) && !existsSync(outPath);
  if (sampleSafe) {
    writeFileSync(brickPath, `---\npiece: footer\nsummary: shared closing line, parameterized by project\n---\n_Generated for **{{project}}** by nbp-forge — edit the recipe/brick, not this file._\n`);
    writeFileSync(recipePath, `---\nname: hello\ndescription: sample skill — replace me\n---\n# hello\n\nThis is a sample skill. Reuse shared bricks with an include directive:\n\n<!-- include: footer | project=my-app -->\n`);
    created.push(rel(brickPath), rel(recipePath));
    build = run({ root, mode: "build" }); // build only the sample we just seeded
  }

  return { ok: build ? build.ok : true, created, build, msg:
    (created.length ? `initialized forge: ${created.join(", ")}` : "forge already initialized (nothing to scaffold)") +
    `. Edit ${cfg.recipes}/, then \`forge build\`.` };
}

// ── list (skills → bricks, with ref-count / blast radius) ─────────────────────
export function list(root = process.cwd()) {
  const P = paths(root);
  if (!existsSync(P.recipes)) return { ok: false, msg: `no recipes directory: ${P.cfg.recipes}`, skills: [], bricks: [] };
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
  // Escape regex metachars in the old name and accept an optionally-quoted value; function
  // replacement avoids `$` in the new name being treated as a replacement token.
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let txt = readFileSync(src, "utf8").replace(
    new RegExp(`^(name:[ \\t]*)["']?${esc}["']?[ \\t]*$`, "m"),
    (_m, p1) => p1 + newName);
  writeFileSync(src, txt);
  move(src, dest);
  const oldCmd = join(P.out, oldName + ".md");
  if (existsSync(oldCmd)) rmSync(oldCmd); // old command is now an orphan
  const r = run({ root, mode: "build" });
  return { ok: r.ok, msg: `skill "${oldName}" → "${newName}" (old command removed, new one generated).` };
}
