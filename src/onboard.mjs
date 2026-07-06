// nbp-skillforge — onboarding: migrate an existing skill library into the forge (F-31 Fases 2+3).
// Deterministic layer ABOVE the engine: it discovers user-authored skills in the configured out
// dir, classifies each one (eligible / excluded / skipped, every file gets an explicit
// disposition), snapshots the originals, imports them verbatim as recipes, runs ONE build, and
// judges fidelity with a normalized round-trip diff. No LLM anywhere in this module — the
// semantic factoring (Fase B) lives in the forge-onboard agent skill, above this.
// Imports from compose/lifecycle/paths — never the other way around (no cycles).
//
// Design: .claude-ops/design-onboarding.md (P1–P9 + maintainer decisions §8b).
// Maintainer decisions honored here: dry by default (--apply executes); discovery root =
// configured cfg.outs[0] (announced in the output; --from overrides); nested files are skipped
// and reported; names are never rewritten without consent (skip + proposal); enforceGenerated
// auto-enables ONLY on the 100%-migrated condition.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto"; // node builtin — the zero-runtime-deps guarantee holds
import {
  loadConfig, run, splitFm, fenceMasker, INCLUDE, PLACEHOLDER_RE, GENERATED_BANNER_RE,
  hasForgeRole, validateConformance, isConformantName, roleOverlapError, brickConsumers,
} from "./compose.mjs";
import { importFile } from "./lifecycle.mjs";
import { CASE_INSENSITIVE_FS, canonFold, isInside } from "./paths.mjs";

const fold = (s) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

// ── preScan (P3): deterministic landmine detection on a RAW buffer ───────────────────────────
// Returns { utf8, bom, text, includeLike, placeholders } — `text` is BOM-stripped, CRLF-normalized.
// A body with a literal {{x}} is fine for the VERBATIM path (compose only substitutes inside
// brick bodies, never in a recipe body) — recorded for Fase 4's no-factor rule, not a skip.
// An include-like directive OUTSIDE a fence is a whole-file skip: the engine WOULD expand it
// (build error `include of missing brick`), so there is no safe verbatim residual for it in v1.
export function preScan(buf) {
  // BOM is detected on the RAW BYTES (EF BB BF) — TextDecoder strips a leading BOM during
  // decode by default, so a post-decode charCodeAt check would never fire (verified by test).
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(buf); }
  catch { return { utf8: false, bom, text: null, includeLike: false, placeholders: [] }; }
  // (decode already dropped the BOM, so splitFm's ^--- anchor is safe from here on)
  text = text.replace(/\r\n/g, "\n");
  const { body } = splitFm(text);
  const isFenced = fenceMasker(body);
  INCLUDE.lastIndex = 0; // defensive — see compose.mjs's includesOf note
  const includeLike = [...body.matchAll(INCLUDE)].some((m) => !isFenced(m.index));
  const placeholders = [...body.matchAll(/\{\{\s*[\w-]+\s*\}\}/g)].map((m) => m[0]);
  return { utf8: true, bom, text, includeLike, placeholders };
}

// ── normalizeForGate (P4): the round-trip fidelity judge ─────────────────────────────────────
// A verbatim import differs from its build output ONLY by: the injected GENERATED banner,
// CRLF→LF, and EOF whitespace trimming. Normalize exactly those three axes — nothing more, so a
// real content divergence is never masked. Reassembly mirrors compose()/importFile's head shape.
export function normalizeForGate(text) {
  const norm = text.replace(/\r\n/g, "\n");
  const { fm, body } = splitFm(norm);
  const cleanBody = body.replace(GENERATED_BANNER_RE, "");
  const whole = fm === null ? cleanBody : `---\n${fm}${fm ? "\n" : ""}---\n${cleanBody}`;
  return whole.replace(/\s*$/, "") + "\n";
}

// ── snapshot (P2): Buffer-faithful backup of the originals, BEFORE any write ─────────────────
// The first build overwrites the originals in place (out == discovery root), so the backup must
// preserve the exact original bytes (CRLF/BOM included) for a documented rollback. Refuses an
// existing backupDir (never silently merge two runs) and a backupDir inside any role dir.
export function snapshot(root, files, backupDir, cfg) {
  if (existsSync(backupDir)) throw Object.assign(new Error(`backup dir already exists: ${backupDir} (one backup per run — remove it or use a new timestamp)`), { userFacing: true });
  const roles = [cfg.bricks, cfg.recipes, cfg.archive, ...cfg.outs].map((d) => canonFold(join(root, d)));
  const canonBackup = canonFold(backupDir);
  for (const r of roles) if (isInside(canonBackup, r)) throw Object.assign(new Error(`backup dir must live outside every role dir: ${backupDir}`), { userFacing: true });
  mkdirSync(backupDir, { recursive: true });
  for (const f of files) writeFileSync(join(backupDir, basename(f)), readFileSync(f)); // Buffer copy
}

// ── discover: whitelist scan of ONE root, every file gets an explicit disposition ────────────
// status ∈ eligible | excluded-generated | excluded-forge-role | excluded-has-recipe
//        | skip-nested | skip-non-utf8 | skip-include-like | skip-nonconformant | skip-collision
export function discover(root, cfg, { from } = {}) {
  const discRel = from ?? cfg.outs[0];
  const discAbs = join(root, discRel);
  const entries = [];
  if (!existsSync(discAbs)) return { discRel, entries };

  // isFile: a directory named `x.md` is not a recipe — counting it would mask a real collision
  // (and the engine itself would EISDIR on it; dispositions must stay accurate regardless).
  const recipeNames = existsSync(join(root, cfg.recipes))
    ? new Set(readdirSync(join(root, cfg.recipes), { withFileTypes: true }).filter((de) => de.isFile() && de.name.endsWith(".md")).map((de) => fold(basename(de.name, ".md"))))
    : new Set();

  // The scanned root may be a custom --from dir: an eligible name whose <out>/<name>.md ALREADY
  // exists would then be OVERWRITTEN by the build without ever entering the snapshot (dual-review
  // finding) — those become skip-collision. With the default scan (from === outs[0]) the source
  // IS the out file itself, already snapshotted, so this guard is scoped to custom roots.
  const customFrom = from !== undefined && from !== cfg.outs[0];

  const seenNames = new Map(); // fold(name) → first file (in-batch collision detection, P6)
  // Code-unit sort (not localeCompare): the scan order must not depend on the host's locale.
  for (const de of readdirSync(discAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (de.isDirectory()) {
      // v1: nested commands are out of scope — reported, never silently ignored (decision 4).
      for (const sub of readdirSync(join(discAbs, de.name), { recursive: true })) {
        if (String(sub).endsWith(".md")) entries.push({ file: join(discRel, de.name, String(sub)), name: null, status: "skip-nested", reason: "nested commands are not onboarded in v1 (flatten it, or leave it un-governed)" });
      }
      continue;
    }
    if (!de.name.endsWith(".md")) continue;
    const rel = join(discRel, de.name);
    const abs = join(discAbs, de.name);
    const name = basename(de.name, ".md");
    // Symlinks are skipped with an explicit disposition (consistent with the engine's stance on
    // symlinked bricks); an unreadable entry (broken link, dir masquerading as .md) must land as
    // a disposition too — "every scanned file gets one" is a promise, not a happy-path comment.
    if (de.isSymbolicLink()) { entries.push({ file: rel, name, status: "skip-symlink", reason: "symlinked skills are not onboarded (mirrors the engine's symlink stance)" }); continue; }
    let buf;
    try { buf = readFileSync(abs); }
    catch (e) { entries.push({ file: rel, name, status: "skip-unreadable", reason: `cannot read: ${e.code ?? e.message}` }); continue; }
    const scan = preScan(buf);

    if (!scan.utf8) { entries.push({ file: rel, name, status: "skip-non-utf8", reason: "not valid UTF-8 — convert the encoding first" }); continue; }
    const { fm, body } = splitFm(scan.text);
    // Category 1 (design §5): the forge's own tooling — never a user skill to onboard.
    if (hasForgeRole(fm)) { entries.push({ file: rel, name, status: "excluded-forge-role", reason: "nbp-skillforge tooling (forge-role marker)" }); continue; }
    // Category 3: already generated/governed. splitFm FIRST — in a frontmatter'd file the banner
    // sits after the fm block, so an ^-anchored test on the raw text would false-negative.
    // Leading blank lines are tolerated for DETECTION only (an editor may have inserted one
    // between the fm and the banner) — importing such a file would double-banner its build.
    if (GENERATED_BANNER_RE.test(body.replace(/^\n+/, ""))) { entries.push({ file: rel, name, status: "excluded-generated", reason: "already generated by the forge (has a recipe)" }); continue; }
    if (recipeNames.has(fold(name))) { entries.push({ file: rel, name, status: "excluded-has-recipe", reason: "a recipe with this name already exists" }); continue; }
    // Identity must be unambiguous BEFORE import: importFile's name precedence is fm `name:` over
    // basename, so a divergent pair would create a recipe under a DIFFERENT name than the scanned
    // file — leaving the original as an instant orphan in the out dir (dual-review finding).
    if (fm !== null) {
      const m = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m);
      const fmName = m ? m[1].replace(/^["'](.*)["']$/, "$1") : null;
      if (fmName !== null && fmName !== name) {
        entries.push({ file: rel, name, status: "skip-name-mismatch", reason: `frontmatter declares name "${fmName}" but the file is "${name}.md"`, proposal: "align the two (the fm name is the SKILL.md identity; the filename is how it's invoked), then re-run" });
        continue;
      }
    }
    if (customFrom && cfg.outs.some((o) => existsSync(join(root, o, name + ".md")))) {
      entries.push({ file: rel, name, status: "skip-collision", reason: "a file with this name already exists in an out dir — the build would overwrite it without a snapshot", proposal: "remove/rename the out file, or onboard it first" });
      continue;
    }
    // P3: an include-like directive outside a fence would be EXPANDED by the engine on build
    // (→ `include of missing brick` error) — no safe verbatim path for it in v1.
    if (scan.includeLike) { entries.push({ file: rel, name, status: "skip-include-like", reason: "body contains an include-like directive outside a code fence — the engine would try to expand it; fence it or onboard by hand" }); continue; }
    // P5: conformance per skill, BEFORE import — the build gate is all-or-nothing, so one bad
    // legacy name must never block the whole onboarded batch. Never renamed without consent.
    if (fm !== null) {
      const errs = [];
      validateConformance(name, fm, errs);
      if (errs.length) {
        const proposal = slugify(name);
        entries.push({ file: rel, name, status: "skip-nonconformant", reason: errs[0].msg, proposal: proposal && proposal !== name ? `rename to "${proposal}" (changes the invocation name — needs your consent)` : "fix the frontmatter name" });
        continue;
      }
    }
    if (!isConformantName(name) && fm !== null) {
      // fm name is fine but the FILENAME (which becomes the recipe/skill name) is not.
      entries.push({ file: rel, name, status: "skip-nonconformant", reason: `filename "${name}" is not a conformant skill name`, proposal: `rename to "${slugify(name)}" (changes the invocation name — needs your consent)` });
      continue;
    }
    // P6: collisions — against existing recipes (folded above) and within this batch.
    if (seenNames.has(fold(name))) {
      entries.push({ file: rel, name, status: "skip-collision", reason: `collides with ${seenNames.get(fold(name))} (case-insensitive filesystems fold these to one recipe)`, proposal: `import with --name ${name}-2` });
      continue;
    }
    seenNames.set(fold(name), rel);
    entries.push({ file: rel, name, status: "eligible", bom: scan.bom, placeholders: scan.placeholders });
  }
  return { discRel, entries };
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 64);

// ── Fase A factoring (--factor): byte-identical blocks only, gate-verified, self-reverting ───
// Segments a recipe BODY into heading-sections (a heading line up to — not including — the next
// heading; plus a preamble block before the first heading). Fence-aware: a `# ...` line inside a
// code fence is content, not a heading. Line-based; returns [{ heading, lines: [start, end) }].
export function segmentBlocks(body) {
  const lines = body.split("\n");
  const isFenced = fenceMasker(body);
  // Map each line index to its char offset so the fence mask (offset-based) applies per line.
  const offsets = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  const heads = [];
  // 0–3 leading spaces: CommonMark's ATX-heading indentation allowance — mirrors FENCE_RE.
  for (let i = 0; i < lines.length; i++) if (/^ {0,3}#{1,6} /.test(lines[i]) && !isFenced(offsets[i])) heads.push(i);
  const blocks = [];
  if (heads.length === 0 || heads[0] > 0) blocks.push({ heading: null, start: 0, end: heads[0] ?? lines.length });
  for (let h = 0; h < heads.length; h++) blocks.push({ heading: lines[heads[h]], start: heads[h], end: heads[h + 1] ?? lines.length });
  return { lines, blocks };
}

// The CORE of a block = its lines minus leading/trailing blank lines. The core (exact bytes,
// joined by \n) is both the dedup key and the future brick body — compose inlines `b.trim()`,
// so keeping the surrounding blank lines in the RECIPE (never in the brick) is what makes the
// factored round-trip byte-identical. No per-line normalization: near-identical is Fase B's job.
function blockCore(lines, start, end) {
  let a = start, b = end - 1;
  while (a <= b && lines[a].trim() === "") a++;
  while (b >= a && lines[b].trim() === "") b--;
  return a > b ? null : { coreStart: a, coreEnd: b + 1, text: lines.slice(a, b + 1).join("\n") };
}

const slugHead = (heading) => {
  const s = heading ? slugify(heading.replace(/^#{1,6} /, "")) : "";
  return s || "section";
};

// factorPass: find byte-identical cores shared by ≥2 skills (≥3 lines, no {{param}} — a literal
// placeholder inside a BRICK body becomes a required param and breaks the build), write each as
// bricks/onboarded/<slug>-<sha8>.md, swap each recipe's core LINES for the include directive,
// rebuild, and gate EVERY affected skill; any gate failure reverts that skill to its verbatim
// recipe (and drops a this-run brick nobody consumes). Factoring never fails the onboard.
//
// Replacement is by SEGMENT COORDINATES, never by text search (dual-review finding, both
// vendors): an indexOf over the whole body could match the same bytes embedded in ANOTHER
// section/fence and factor the wrong spot — byte-faithful to the gate, structurally wrong.
// Segment cores are disjoint line ranges by construction; applying them bottom-up per skill
// keeps every index valid with no re-scan.
function factorPass({ root, cfg, imported, backupDir }) {
  const recipes = new Map(); // skill → { fm, body, verbatim }
  for (const e of imported) {
    // These recipes were created by THIS run's importFile — LF/BOM-normalized by construction.
    const raw = readFileSync(join(root, cfg.recipes, e.skill + ".md"), "utf8");
    const { fm, body } = splitFm(raw);
    recipes.set(e.skill, { fm, body, verbatim: raw });
  }

  // Pass 1 — segment each skill ONCE; group cores by exact text with their line ranges.
  const groups = new Map(); // core text → { heading, occ: Map(skill → [{coreStart, coreEnd}]) }
  const skillLines = new Map(); // skill → lines[] (single segmentation, coordinates stay valid)
  for (const [skill, r] of recipes) {
    const { lines, blocks } = segmentBlocks(r.body);
    skillLines.set(skill, lines);
    for (const blk of blocks) {
      const core = blockCore(lines, blk.start, blk.end);
      if (!core) continue;
      if (core.coreEnd - core.coreStart < 3) continue; // min 3 lines (approved decision 6)
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(core.text)) continue;   // no-factor span (P3)
      const g = groups.get(core.text) ?? { heading: blk.heading, occ: new Map() };
      if (!g.occ.has(skill)) g.occ.set(skill, []);
      g.occ.get(skill).push({ coreStart: core.coreStart, coreEnd: core.coreEnd });
      groups.set(core.text, g);
    }
  }

  // A group factors when ≥2 DISTINCT skills share the core in THIS batch, OR when a
  // byte-identical brick ALREADY sits at the deterministic path (a later batch matching a
  // previously-factored section — earlier recipes carry the include, not the raw text, so
  // cross-batch sharing is only visible through the brick itself).
  const candidates = [...groups.entries()];
  if (!candidates.length) return { factored: [], kept: [] };

  // Pass 2 — write bricks. Collision guard (dual-review): a pre-existing file at the computed
  // path is REUSED when byte-identical (idempotent re-run) and SKIPS the group otherwise (never
  // clobber a user brick; sha8 is 32 bits — cheap paranoia). Any write error also just skips the
  // group: factoring degrades, it never throws the run away.
  const created = [];   // bricks this run WROTE (deletable on no-consumer)
  const reused = [];    // pre-existing byte-identical bricks (user-owned — reported, never deleted)
  const replacements = new Map(); // skill → [{coreStart, coreEnd, brickRel}]
  for (const [text, g] of candidates) {
    const brickRel = `onboarded/${slugHead(g.heading)}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
    const brickPath = join(root, cfg.bricks, brickRel + ".md");
    let wroteThisRun = false;
    try {
      if (existsSync(brickPath)) {
        const cur = readFileSync(brickPath, "utf8");
        if (cur !== text + "\n") continue; // different content at the same path → skip the group
        reused.push(brickRel);
      } else {
        if (g.occ.size < 2) continue; // singleton with no pre-existing brick → nothing to share
        mkdirSync(dirname(brickPath), { recursive: true });
        writeFileSync(brickPath, text + "\n");
        wroteThisRun = true;
      }
    } catch { continue; } // unwritable path (dir squatting the name, perms) → skip the group
    if (wroteThisRun) created.push(brickRel);
    for (const [skill, occs] of g.occ) {
      (replacements.get(skill) ?? replacements.set(skill, []).get(skill)).push(
        ...occs.map((o) => ({ ...o, brickRel })));
    }
  }

  // Pass 3 — apply per skill, bottom-up (ranges are disjoint segments; descending order keeps
  // every earlier index valid). One write per touched skill.
  const touched = new Set();
  for (const [skill, reps] of replacements) {
    const lines = skillLines.get(skill).slice();
    for (const rep of reps.sort((a, b) => b.coreStart - a.coreStart)) {
      lines.splice(rep.coreStart, rep.coreEnd - rep.coreStart, `<!-- include: ${rep.brickRel} -->`);
    }
    const r = recipes.get(skill);
    r.body = lines.join("\n");
    writeFileSync(join(root, cfg.recipes, skill + ".md"), r.fm === null ? r.body : `---\n${r.fm}${r.fm ? "\n" : ""}---\n${r.body}`);
    touched.add(skill);
  }
  if (!touched.size) return { factored: [], kept: [] };

  // Rebuild + gate every touched skill; revert the ones that fail (never fail the run).
  // A build-level failure reverts EVERY touched skill — deliberately global: a broken factored
  // state must never survive, and the verbatim baseline is proven good.
  const build = run({ root, mode: "build" });
  const kept = [];
  const judge = (skill, srcFile) => {
    const original = new TextDecoder("utf8").decode(readFileSync(join(backupDir, basename(srcFile))));
    const rebuilt = readFileSync(join(root, cfg.outs[0], skill + ".md"), "utf8");
    return normalizeForGate(original.replace(/^﻿/, "")) === normalizeForGate(rebuilt);
  };
  let needRebuild = !build.ok;
  for (const e of imported.filter((x) => touched.has(x.skill))) {
    if (build.ok && judge(e.skill, e.file)) continue;
    writeFileSync(join(root, cfg.recipes, e.skill + ".md"), recipes.get(e.skill).verbatim); // revert
    kept.push(e.skill);
    needRebuild = true;
  }
  if (needRebuild) run({ root, mode: "build" }); // regenerate the reverted outputs
  // Drop only bricks THIS RUN created that ended up with no consumer (a reused pre-existing
  // brick is the user's — never deleted here even if unconsumed).
  const consumers = brickConsumers(root, cfg);
  const factored = [];
  for (const brick of created) {
    if (consumers[brick]?.size) factored.push({ brick, usedBy: [...consumers[brick]].sort() });
    else rmSync(join(root, cfg.bricks, brick + ".md"), { force: true });
  }
  for (const brick of reused) {
    if (consumers[brick]?.size) factored.push({ brick, usedBy: [...consumers[brick]].sort(), reused: true });
  }
  return { factored, kept };
}

// ── report (P8): decision telemetry, inside the run's backup dir ─────────────────────────────
function writeReport(backupDir, { discRel, entries, gate, applied, enforce, factoring }) {
  const line = (e) => `| ${e.file.replace(/\\/g, "/")} | ${e.status} | ${e.reason ?? ""}${e.proposal ? ` — ${e.proposal}` : ""} |`;
  const gateLine = (g) => `| ${g.skill} | ${g.pass ? "✔ fiel (diff normalizado zero)" : "✗ GATE FAILED"} |`;
  const md = [
    `# onboard report`,
    ``,
    `- scanned root: \`${discRel}\` (from forge.config.json's \`out\`; use \`--from <dir>\` to scan another folder)`,
    `- mode: ${applied ? "APPLIED" : "dry-run (nothing written — re-run with --apply)"}`,
    `- backup: this folder holds a byte-faithful copy of every original that was onboarded`,
    `- rollback: copy the files in this folder back over \`${discRel}\` and delete the created recipes`,
    ``,
    `## dispositions (every scanned file, no silent drops)`,
    ``,
    `| file | disposition | detail |`,
    `|---|---|---|`,
    ...entries.map(line),
    ``,
    ...(gate.length ? [`## fidelity gate (normalized round-trip diff vs the original)`, ``, `| skill | verdict |`, `|---|---|`, ...gate.map(gateLine), ``] : []),
    ...(factoring ? [
      `## mechanical factoring (--factor: byte-identical blocks only)`,
      ``,
      ...(factoring.factored.length
        ? [`| brick | used by |`, `|---|---|`, ...factoring.factored.map((f) => `| ${f.brick} | ${f.usedBy.join(", ")} |`)]
        : [`No byte-identical shared block (≥3 lines, no {{param}}) was found across two or more skills.`]),
      ...(factoring.kept.length ? [``, `Kept **verbatim** (factored round-trip failed its gate and was reverted): ${factoring.kept.join(", ")}.`] : []),
      ``,
    ] : []),
    ...(enforce ? [`## enforceGenerated`, ``, enforce, ``] : []),
  ].join("\n");
  writeFileSync(join(backupDir, "onboard-report.md"), md);
}

// ── installSkill: materialize the ephemeral forge-onboard agent skill from the package ───────
// The skill is PACKAGE TOOLING (durable home = the installed package; the copy in the out dir is
// ephemeral and carries the forge-role marker that excludes it from every onboarding scan).
// Deliberately NOT self-archiving via _archive/ — that dir is the `restore` contract, and
// restoring would turn the tool into a user recipe (design §4). Idempotent; never clobbers a
// same-named file that does NOT carry our marker (destruction guard).
export function installSkill({ root = process.cwd(), cfg = loadConfig(root) } = {}) {
  // Same pre-flight as every mutating command: never materialize into a role-overlapping config.
  const overlap = roleOverlapError(root, cfg);
  if (overlap) return { ok: false, msg: overlap };
  const wrapperUrl = new URL("../assets/onboard/claude-code/forge-onboard.md", import.meta.url);
  const specUrl = new URL("../assets/onboard/ONBOARD-SPEC.md", import.meta.url);
  let body;
  try {
    // The installed copy is SELF-CONTAINED: the harness-neutral protocol is embedded verbatim
    // below the wrapper (dual-review: a path-based "read it from the package" instruction breaks
    // under npx / global installs / pnpm stores / a copied-out skill file).
    body = readFileSync(wrapperUrl, "utf8") +
      "\n---\n\n<!-- ONBOARD-SPEC.md — embedded verbatim from the nbp-skillforge package at install time -->\n\n" +
      readFileSync(specUrl, "utf8");
  } catch { return { ok: false, msg: "bundled onboarding assets not found (broken install?)" }; }
  const dest = join(root, cfg.outs[0], "forge-onboard.md");
  if (existsSync(dest)) {
    const cur = readFileSync(dest, "utf8");
    if (cur === body) return { ok: true, already: true, msg: `forge-onboard skill already installed: ${cfg.outs[0]}/forge-onboard.md` };
    if (!hasForgeRole(splitFm(cur.replace(/\r\n/g, "\n")).fm))
      return { ok: false, msg: `refusing to overwrite ${cfg.outs[0]}/forge-onboard.md: it exists and does NOT carry the forge-role marker (looks like a user file, not our tooling)` };
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  return { ok: true, already: false, msg: `forge-onboard skill installed → ${cfg.outs[0]}/forge-onboard.md. Run it in your agent AFTER \`forge onboard --apply --factor\` (it reads ONBOARD-SPEC.md from the package). It carries the forge-role marker, so onboarding scans always ignore it.` };
}

// ── onboard: the orchestrator. `ts` is ALWAYS injected by the caller (P2 — determinism). ─────
export function onboard({ root = process.cwd(), ts, apply = false, from, factor = false } = {}) {
  const cfg = loadConfig(root);
  const overlap = roleOverlapError(root, cfg);
  if (overlap) return { ok: false, msg: overlap };
  if (apply && !ts) return { ok: false, msg: "onboard --apply: missing run timestamp (internal — the CLI injects it)" };
  // --from must never point inside a forge source dir: recipes/ is naturally inert (every file
  // there is excluded-has-recipe) but bricks/ would happily onboard each brick as a NEW recipe —
  // not destructive (build writes only to out) yet clearly wrong. Fail closed, case-fold aware.
  if (from) {
    // Absolute paths corrupt the join(root, from) composition on Windows (verified: join mangles
    // a second absolute segment) — refuse with a clear message instead of scanning a wrong dir.
    if (isAbsolute(from)) return { ok: false, msg: `onboard: --from must be a path relative to the project root (got an absolute path: ${from})` };
    const fromAbs = canonFold(join(root, from));
    // `..` escaping the project would let discover() record paths whose later join(root, file)
    // reaches OUTSIDE the project (dual-review: a marked file out there could even be deleted).
    // Everything onboard touches stays inside the root, always.
    if (!isInside(fromAbs, canonFold(root)))
      return { ok: false, msg: `onboard: --from must stay inside the project root (got: ${from})` };
    for (const [role, dir] of [["bricks", cfg.bricks], ["recipes", cfg.recipes], ["archive", cfg.archive]])
      if (isInside(fromAbs, canonFold(join(root, dir))))
        return { ok: false, msg: `onboard: --from must not point inside the ${role} dir (${from}) — those are forge sources, not skills to migrate` };
  }

  const { discRel, entries } = discover(root, cfg, { from });
  const eligible = entries.filter((e) => e.status === "eligible");
  const skipped = entries.filter((e) => e.status.startsWith("skip-"));
  const excludedForgeRole = entries.filter((e) => e.status === "excluded-forge-role");
  const summary = (extra) =>
    `onboard: scanned ${discRel} — ${eligible.length} eligible, ${entries.length - eligible.length - skipped.length} already governed/excluded, ${skipped.length} skipped.${extra}`;

  if (!apply) {
    return {
      ok: true, applied: false, root: discRel, entries,
      msg: summary(` Dry-run: nothing written. Re-run with --apply to migrate (originals are snapshotted first).${factor ? " (--factor takes effect together with --apply.)" : ""}${from ? "" : ` Scanning the configured out dir — use --from <dir> if your skills live elsewhere.`}`),
    };
  }

  // ── apply ──
  if (!eligible.length) return { ok: true, applied: false, root: discRel, entries, msg: summary(" Nothing to apply.") };

  // Pre-flight drift gate (dual-review finding): the single build below rebuilds EVERY governed
  // skill into EVERY out dir — a governed file carrying a hand-edit (drift) would be silently
  // healed/overwritten without ever entering this run's snapshot. Refuse to proceed until the
  // project is clean; the message says exactly how to resolve it either way.
  if (existsSync(join(root, cfg.recipes)) && readdirSync(join(root, cfg.recipes), { withFileTypes: true }).some((de) => de.isFile() && de.name.endsWith(".md"))) {
    const pre = run({ root, mode: "check" });
    if (pre.drift > 0) {
      return { ok: false, msg: `onboard: ${pre.drift} governed skill(s) have drifted from their recipes — the onboarding build would overwrite those hand-edits without a snapshot. Run \`forge check\` to see them, then either \`forge build\` (discard the hand-edits) or fold the edits into their recipes, and re-run onboard.` };
    }
  }

  const backupDir = join(root, dirname(cfg.archive), `_onboard-backup-${ts}`);
  try { snapshot(root, eligible.map((e) => join(root, e.file)), backupDir, cfg); }
  catch (e) { if (e.userFacing) return { ok: false, msg: e.message }; throw e; }

  // Import each eligible source verbatim, under its SCANNED identity (name = basename —
  // discover already skipped any fm/basename mismatch, so importFile's own precedence can never
  // mint a recipe under a different name than the file we snapshotted). A failure rolls back
  // every recipe this run created (atomic batch — a rerun then re-snapshots everything).
  const imported = [];
  for (const e of eligible) {
    const r = importFile(join(root, e.file), { root, name: e.name });
    if (!r.ok) {
      for (const done of imported) rmSync(join(root, cfg.recipes, done.skill + ".md"), { force: true });
      writeReport(backupDir, { discRel, entries, gate: [], applied: true, enforce: null });
      return { ok: false, applied: true, root: discRel, entries, backupDir, msg: `onboard aborted at ${e.file}: ${r.msg} — the ${imported.length} recipe(s) this run had created were rolled back; originals are untouched (backup kept at ${backupDir})` };
    }
    imported.push({ ...e, skill: r.skill });
  }

  // ONE full build (writes the generated output over the originals — the snapshot covers this).
  const build = run({ root, mode: "build" });
  if (!build.ok) {
    writeReport(backupDir, { discRel, entries, gate: [], applied: true, enforce: null });
    return { ok: false, applied: true, root: discRel, entries, backupDir, errors: build.errors, msg: `onboard: recipes created but the build failed (${build.errors.length} error(s) below) — originals are safe in ${backupDir}` };
  }

  // Fidelity gate (P4): normalized round-trip diff per skill, judged by execution, not opinion.
  const gate = imported.map((e) => {
    const original = new TextDecoder("utf8").decode(readFileSync(join(backupDir, basename(e.file))));
    const rebuilt = readFileSync(join(root, cfg.outs[0], e.skill + ".md"), "utf8");
    // Strip a leading BOM (﻿ escape — editor-proof) — the backup is byte-faithful, so a
    // BOM'd original still carries it here, and it would break normalizeForGate's splitFm anchor.
    const pass = normalizeForGate(original.replace(/^\uFEFF/, "")) === normalizeForGate(rebuilt);
    return { skill: e.skill, pass };
  });
  const gateFails = gate.filter((g) => !g.pass);

  // Fase A factoring (opt-in, decision 6): only after the VERBATIM gate passed for everyone —
  // factoring must start from a proven-faithful baseline. It gates and reverts per skill and can
  // never fail the run (worst case: everything stays verbatim, reported as kept).
  let factoring = null;
  if (factor && !gateFails.length) {
    factoring = factorPass({ root, cfg, imported, backupDir });
  }

  // P9 (maintainer decision §8b.5): 100% migrated → enforceGenerated flips ON automatically,
  // announced loudly. ANY skip or gate failure blocks the auto-enable — then we only suggest.
  // Dual-review finding: the scanned root is ONE dir, but enforceGenerated's orphan scan covers
  // EVERY out dir — auto-enabling with an un-governed .md sitting in out[1] (or in outs[0] when
  // --from scanned elsewhere) would make the very next `forge check` fail. Sweep them all first.
  // Stray detection is MARKER-based (each candidate's own fm), never a path-list comparison —
  // path-string matching broke on Windows separators and missed a tool the scan never saw
  // (--from / out[1]); the engine's own orphan scan uses the same marker rule.
  const isMarkedTool = (absFile) => {
    try { return hasForgeRole(splitFm(readFileSync(absFile, "utf8").replace(/\r\n/g, "\n")).fm); } catch { return false; }
  };
  const recipeSet = new Set(existsSync(join(root, cfg.recipes)) ? readdirSync(join(root, cfg.recipes)).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")) : []);
  const outTools = []; // marked tool files sitting in GOVERNED out dirs (the only removal targets)
  const strayOrphans = cfg.outs.flatMap((o) => {
    const dir = join(root, o);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((de) => de.isFile() && de.name.endsWith(".md") && !recipeSet.has(basename(de.name, ".md")))
      .filter((de) => {
        if (isMarkedTool(join(dir, de.name))) { outTools.push({ rel: `${o}/${de.name}`, abs: join(dir, de.name) }); return false; }
        return true;
      })
      .map((de) => `${o}/${de.name}`);
  });
  let enforceNote = null;
  let enforced = false;
  let removedTools = [];
  if (!skipped.length && !gateFails.length && !strayOrphans.length && !cfg.enforceGenerated) {
    // Order matters (dual-review): persist the config FIRST, remove the tool files after — an
    // I/O failure between the two then leaves strict mode ON with the tool still present, which
    // the engine's marker-aware orphan scan tolerates (never the reverse: tool gone, mode off).
    const cfgPath = join(root, "forge.config.json");
    const onDisk = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : (({ bricks, recipes, out, archive, deletePolicy }) => ({ bricks, recipes, out, archive, deletePolicy }))(cfg);
    onDisk.enforceGenerated = true;
    writeFileSync(cfgPath, JSON.stringify(onDisk, null, 2) + "\n");
    enforced = true;
    // Maintainer decision §8b.5: the ephemeral tool skill leaves with the enable. Removal is
    // CONFINED to marked files inside the governed out dirs (never a --from source dir — a
    // marked file there is the user's copy, not an installation of ours).
    for (const t of outTools) { rmSync(t.abs, { force: true }); removedTools.push(t.rel.replace(/\\/g, "/")); }
    enforceNote = `**100% of the scanned skills are now governed by the forge — \`enforceGenerated: true\` was enabled automatically.** From now on, a hand-made skill in the out dir fails \`forge check\`; create skills via \`forge new\` (or import them) instead.${removedTools.length ? ` The ephemeral tool skill (${removedTools.join(", ")}) was removed — \`forge onboard --install-skill\` brings it back on demand.` : ""}`;
  } else if (!cfg.enforceGenerated) {
    const why = skipped.length ? `${skipped.length} skill(s) were skipped` : gateFails.length ? "the fidelity gate failed" : strayOrphans.length ? `un-governed file(s) remain in the out dir(s): ${strayOrphans.join(", ")}` : "";
    enforceNote = `enforceGenerated stays OFF (${why}). Once everything is migrated, enable it in forge.config.json so hand-made skills can't drift in unnoticed.`;
  }

  writeReport(backupDir, { discRel, entries, gate, applied: true, enforce: enforceNote, factoring });

  const ok = gateFails.length === 0;
  const factorNote = factoring
    ? ` Factoring: ${factoring.factored.length} shared brick(s) extracted${factoring.kept.length ? `, ${factoring.kept.length} kept verbatim (gate)` : ""}.`
    : "";
  return {
    ok, applied: true, root: discRel, entries, backupDir, gate, enforced, factoring,
    warnings: build.warnings,
    msg: ok
      ? summary(` ${imported.length} migrated, fidelity gate PASSED for all (normalized diff zero).${factorNote} Backup + report: ${backupDir}.${enforced ? " enforceGenerated: ON (100% migrated)." : ""}`)
      : summary(` GATE FAILED for ${gateFails.map((g) => g.skill).join(", ")} — originals are safe in ${backupDir}; see the report.`),
  };
}
