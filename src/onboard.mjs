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
import {
  loadConfig, run, splitFm, fenceMasker, INCLUDE, GENERATED_BANNER_RE,
  hasForgeRole, validateConformance, isConformantName, roleOverlapError,
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

// ── report (P8): decision telemetry, inside the run's backup dir ─────────────────────────────
function writeReport(backupDir, { discRel, entries, gate, applied, enforce }) {
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
    ...(enforce ? [`## enforceGenerated`, ``, enforce, ``] : []),
  ].join("\n");
  writeFileSync(join(backupDir, "onboard-report.md"), md);
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
      msg: summary(` Dry-run: nothing written. Re-run with --apply to migrate (originals are snapshotted first).${from ? "" : ` Scanning the configured out dir — use --from <dir> if your skills live elsewhere.`}`),
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

  // P9 (maintainer decision §8b.5): 100% migrated → enforceGenerated flips ON automatically,
  // announced loudly. ANY skip, gate failure, or forge-role file still in the out dir (it would
  // become an instant orphan) blocks the auto-enable — then we only suggest.
  // Dual-review finding: the scanned root is ONE dir, but enforceGenerated's orphan scan covers
  // EVERY out dir — auto-enabling with an un-governed .md sitting in out[1] (or in outs[0] when
  // --from scanned elsewhere) would make the very next `forge check` fail. Sweep them all first.
  const recipeSet = new Set(existsSync(join(root, cfg.recipes)) ? readdirSync(join(root, cfg.recipes)).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")) : []);
  const strayOrphans = cfg.outs.flatMap((o) => {
    const dir = join(root, o);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((de) => de.isFile() && de.name.endsWith(".md") && !recipeSet.has(basename(de.name, ".md")))
      .map((de) => `${o}/${de.name}`);
  });
  let enforceNote = null;
  let enforced = false;
  if (!skipped.length && !gateFails.length && !excludedForgeRole.length && !strayOrphans.length && !cfg.enforceGenerated) {
    const cfgPath = join(root, "forge.config.json");
    const onDisk = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : (({ bricks, recipes, out, archive, deletePolicy }) => ({ bricks, recipes, out, archive, deletePolicy }))(cfg);
    onDisk.enforceGenerated = true;
    writeFileSync(cfgPath, JSON.stringify(onDisk, null, 2) + "\n");
    enforced = true;
    enforceNote = "**100% of the scanned skills are now governed by the forge — `enforceGenerated: true` was enabled automatically.** From now on, a hand-made skill in the out dir fails `forge check`; create skills via `forge new` (or import them) instead.";
  } else if (!cfg.enforceGenerated) {
    const why = skipped.length ? `${skipped.length} skill(s) were skipped` : gateFails.length ? "the fidelity gate failed" : excludedForgeRole.length ? "a forge-role tool file sits in the out dir" : strayOrphans.length ? `un-governed file(s) remain in the out dir(s): ${strayOrphans.join(", ")}` : "";
    enforceNote = `enforceGenerated stays OFF (${why}). Once everything is migrated, enable it in forge.config.json so hand-made skills can't drift in unnoticed.`;
  }

  writeReport(backupDir, { discRel, entries, gate, applied: true, enforce: enforceNote });

  const ok = gateFails.length === 0;
  return {
    ok, applied: true, root: discRel, entries, backupDir, gate, enforced,
    warnings: build.warnings,
    msg: ok
      ? summary(` ${imported.length} migrated, fidelity gate PASSED for all (normalized diff zero). Backup + report: ${backupDir}.${enforced ? " enforceGenerated: ON (100% migrated)." : ""}`)
      : summary(` GATE FAILED for ${gateFails.map((g) => g.skill).join(", ")} — originals are safe in ${backupDir}; see the report.`),
  };
}
