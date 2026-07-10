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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto"; // node builtin — the zero-runtime-deps guarantee holds
import {
  loadConfig, run, splitFm, fenceMasker, INCLUDE, PLACEHOLDER_RE, GENERATED_BANNER_RE,
  hasForgeRole, validateConformance, isConformantName, roleOverlapError, brickConsumers,
  segmentBlocks, blockCore,
} from "./compose.mjs";
import { importFile } from "./lifecycle.mjs";
import { CASE_INSENSITIVE_FS, canonFold, isInside } from "./paths.mjs";

const fold = (s) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

// ── preScan (P3): deterministic landmine detection on a RAW buffer ───────────────────────────
// Returns { utf8, bom, text, includeLike, placeholders } — `text` is BOM-stripped, CRLF-normalized.
// A body with a literal {{x}} is fine for the VERBATIM path (compose only substitutes inside
// brick bodies, never in a recipe body) — recorded for Fase 4's no-factor rule, not a skip.
// An include-like directive the engine WOULD expand — outside a fence, or a bang (`include!:`)
// directive anywhere (F-33) — is a whole-file skip: the build would try to expand it (build
// error `include of missing brick`), so there is no safe verbatim residual for it in v1.
// `includeLike` is null (none) | "unfenced" | "bang" — the KIND matters downstream because the
// two cases have opposite remedies: an unfenced plain directive is disarmed by fencing it,
// while a bang expands even inside a fence, so "fence it" advice for a bang is a dead end
// (athena triage: a fenced bang got exactly that advice, already satisfied, and re-running
// skipped it forever). Bang wins when both are present: fencing alone can never fix that file.
// Still truthy/falsy-compatible with the old boolean for every `if (scan.includeLike)` caller.
export function preScan(buf) {
  // BOM is detected on the RAW BYTES (EF BB BF) — TextDecoder strips a leading BOM during
  // decode by default, so a post-decode charCodeAt check would never fire (verified by test).
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(buf); }
  catch { return { utf8: false, bom, text: null, includeLike: null, placeholders: [] }; }
  // (decode already dropped the BOM, so splitFm's ^--- anchor is safe from here on)
  text = text.replace(/\r\n?/g, "\n");
  const { body } = splitFm(text);
  const isFenced = fenceMasker(body);
  INCLUDE.lastIndex = 0; // defensive — see compose.mjs's includesOf note
  // "Include-like" = the engine WOULD expand it on build (F-33 parity): a bang directive
  // (`include!:`, m[1] === "!") expands even inside a fence, so it is a landmine wherever it sits;
  // a bang-less directive is one only outside a fence (F-03 keeps it verbatim inside).
  const matches = [...body.matchAll(INCLUDE)];
  const includeLike = matches.some((m) => m[1] === "!") ? "bang"
    : matches.some((m) => !isFenced(m.index)) ? "unfenced" : null;
  const placeholders = [...body.matchAll(/\{\{\s*[\w-]+\s*\}\}/g)].map((m) => m[0]);
  return { utf8: true, bom, text, includeLike, placeholders };
}

// ── normalizeForGate (P4): the round-trip fidelity judge ─────────────────────────────────────
// A verbatim import differs from its build output ONLY by: the injected GENERATED banner,
// CRLF→LF, and EOF whitespace trimming. Normalize exactly those three axes — nothing more, so a
// real content divergence is never masked. Reassembly mirrors compose()/importFile's head shape.
export function normalizeForGate(text) {
  const norm = text.replace(/\r\n?/g, "\n");
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
  // Fable B9: `--from some-file.md` used to crash raw (ENOTDIR on readdirSync). Environment
  // mistake → clean user-facing error.
  if (!statSync(discAbs).isDirectory()) {
    throw Object.assign(new Error(`onboard: the scan root is not a directory: ${discRel}`), { userFacing: true });
  }

  // isFile: a directory named `x.md` is not a recipe — counting it would mask a real collision
  // (and the engine itself would EISDIR on it; dispositions must stay accurate regardless).
  const recipeNames = existsSync(join(root, cfg.recipes))
    ? new Set(readdirSync(join(root, cfg.recipes), { withFileTypes: true }).filter((de) => de.isFile() && de.name.endsWith(".md")).map((de) => fold(basename(de.name, ".md"))))
    : new Set();

  // Overwrite protection across ALL destinations (Fable B1, CONFIRMED data loss): the single
  // build after import writes <name>.md into EVERY out dir — any pre-existing file there that
  // is NOT byte-identical to the scanned source would be destroyed without ever entering the
  // snapshot. Per eligible name, every out dir OTHER than the scanned root itself (canonical
  // compare — a `--from .claude\commands` backslash spelling or `--from <out[1]>` must not make
  // a file "collide with itself", Fable B6) is checked: divergent bytes → skip-collision;
  // byte-identical → allowed (its content IS the snapshotted source).
  const scanCanon = canonFold(discAbs);
  const otherOuts = cfg.outs.filter((o) => canonFold(join(root, o)) !== scanCanon);

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
    // The reason must not claim more than the banner proves: the recipe may have been deleted
    // since (an orphan output still carrying the banner) — "has a recipe" was a lie there. The
    // exclusion itself is right either way: banner ⇒ build output, and output files are never
    // onboarded (round-tripping one would recipe-ify the forge's own artifact).
    if (GENERATED_BANNER_RE.test(body.replace(/^\n+/, ""))) { entries.push({ file: rel, name, status: "excluded-generated", reason: "carries the GENERATED banner — output files are never onboarded; edit the recipe instead" }); continue; }
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
    const divergentOut = otherOuts.find((o) => {
      const target = join(root, o, name + ".md");
      try {
        if (!existsSync(target)) return false;
        // Size check first (review nit): different sizes are divergent without reading the body.
        if (statSync(target).size !== buf.length) return true;
        return !buf.equals(readFileSync(target));
      } catch { return true; } // unreadable target: fail closed
    });
    if (divergentOut !== undefined) {
      entries.push({ file: rel, name, status: "skip-collision", reason: `a DIFFERENT file with this name already exists in ${divergentOut}/ — the build would overwrite it without a snapshot`, proposal: "reconcile the two copies (or remove one), then re-run" });
      continue;
    }
    // P3: an include-like directive the engine WOULD expand on build (→ `include of missing
    // brick` error) — no safe verbatim path for it in v1. The reason names the actual case:
    // "fence it" is only true advice for the unfenced plain directive — a bang (`include!:`)
    // expands even inside a fence (F-33), so telling its author to fence it would be factually
    // wrong AND a permanent dead end (the fence is often already there).
    if (scan.includeLike) {
      const reason = scan.includeLike === "bang"
        ? "body contains a bang include directive (`include!:`) — the engine expands it even inside a code fence; remove the `!` (or the directive) or onboard by hand"
        : "body contains an include-like directive outside a code fence — the engine would try to expand it; fence it or onboard by hand";
      entries.push({ file: rel, name, status: "skip-include-like", reason });
      continue;
    }
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
// The block-segmentation primitives (segmentBlocks / blockCore) now live in compose.mjs — the
// shared base that lifecycle's `promote` (F-36) also consumes — and are imported at the top of
// this file (an onboard-local copy would be an import cycle: onboard imports FROM lifecycle).

const slugHead = (heading) => {
  const s = heading ? slugify(heading.replace(/^#{1,6} /, "")) : "";
  return s || "section";
};

// ── F-34(a): sub-block segmentation INSIDE a heading-section ─────────────────────────────────
// A sub-block is a maximal run of lines that are neither blank nor fence-marker-shaped, so a
// block can never straddle a fence boundary: the opening/closing ```/~~~ line is a delimiter
// exactly like a blank line (and is never itself part of a block — swapping it away would break
// the fence structure). The marker test mirrors compose's FENCE_RE deliberately as a
// CONSERVATIVE SUPERSET: a fence-LOOKING content line inside a fence also delimits, which can
// only shrink candidate blocks (less factoring, never a wrong swap) — the authoritative
// inside/outside-a-fence decision for the swap comes from the exported fenceMasker (the engine's
// own rule, F-33 parity). Because the mask only flips on marker lines and no block contains one,
// every line of a block shares the fencedness of its first line.
const SUBBLOCK_DELIM_RE = /^ {0,3}(`{3,}|~{3,})/;
function segmentSubBlocks(lines, offsets, isFenced, start, end) {
  const blocks = [];
  const isDelim = (ln) => ln.trim() === "" || SUBBLOCK_DELIM_RE.test(ln);
  for (let i = start; i < end; ) {
    if (isDelim(lines[i])) { i++; continue; }
    let j = i + 1;
    while (j < end && !isDelim(lines[j])) j++;
    blocks.push({ start: i, end: j, fenced: isFenced(offsets[i]) });
    i = j;
  }
  return blocks;
}

// F-34: candidacy shared by the block factor pass AND the near-dup report — ≥3 lines (the same
// micro-brick floor as sections, approved decision 6), no literal {{param}} (a placeholder inside
// a BRICK body becomes a required param and breaks the build — and a suggested-{{param}} report
// over an already-{{x}}'d block would be nonsense), and NO include directive at all, real or
// documented (P3's no-factor rule): a fenced bang-less directive is legal documentation in a
// recipe, but the extracted brick body loses the fence context, where the engine's nested-include
// gate would see a REAL include and fail the whole build.
const blockEligible = (text, lineCount) => {
  if (lineCount < 3) return false;
  PLACEHOLDER_RE.lastIndex = 0;
  if (PLACEHOLDER_RE.test(text)) return false;
  INCLUDE.lastIndex = 0; // defensive — INCLUDE is the exported GLOBAL regex (see compose.mjs)
  return [...text.matchAll(INCLUDE)].length === 0;
};

// factorPass: find byte-identical cores shared by ≥2 skills (≥3 lines, no {{param}} — a literal
// placeholder inside a BRICK body becomes a required param and breaks the build), write each as
// bricks/onboarded/<slug>-<sha8>.md, swap each recipe's core LINES for the include directive,
// rebuild, and gate EVERY affected skill; any gate failure reverts that skill to its verbatim
// recipe (and drops a this-run brick nobody consumes). Factoring never fails the onboard.
// Two granularities (F-34a): the original HEADING-SECTION pass runs first, untouched; a second
// BLOCK pass then factors blank-line-delimited blocks inside the sections the first pass left
// behind — including blocks INSIDE a code fence, swapped with the F-33 bang (`include!:`), the
// only directive form the engine expands there. Same safety story at both granularities:
// byte-identical only, judged by the round-trip gate, self-reverting per skill.
//
// Replacement is by SEGMENT COORDINATES, never by text search (dual-review finding, both
// vendors): an indexOf over the whole body could match the same bytes embedded in ANOTHER
// section/fence and factor the wrong spot — byte-faithful to the gate, structurally wrong.
// Segment cores (sections and blocks alike) are disjoint line ranges by construction; applying
// them bottom-up per skill keeps every index valid with no re-scan.
function factorPass({ root, cfg, imported, backupDir, variants = false }) {
  const recipes = new Map(); // skill → { fm, body, verbatim }
  for (const e of imported) {
    // These recipes were created by THIS run's importFile — LF/BOM-normalized by construction.
    const raw = readFileSync(join(root, cfg.recipes, e.skill + ".md"), "utf8");
    const { fm, body } = splitFm(raw);
    recipes.set(e.skill, { fm, body, verbatim: raw });
  }

  // Pass 1 — segment each skill ONCE; group section cores by exact text with their line ranges.
  // The same walk also collects every eligible SUB-BLOCK (F-34): the near-dup report looks at ALL
  // of them (even inside sections the section pass will factor — a third skill's variant is still
  // worth surfacing), while block-FACTORING eligibility (residual sections only) is decided in
  // pass 2b, after the section pass's outcome is known.
  const groups = new Map(); // section core text → { heading, occ: Map(skill → [{coreStart, coreEnd}]) }
  const skillLines = new Map(); // skill → lines[] (single segmentation, coordinates stay valid)
  const skillBlocks = new Map(); // skill → [{ start, end, fenced, text }] (F-34 sub-block candidates)
  const nearDupIndex = new Map(); // F-34b: first line → Map(block text → Set(skill)) — report-only
  for (const [skill, r] of recipes) {
    const { lines, blocks, offsets, isFenced } = segmentBlocks(r.body);
    skillLines.set(skill, lines);
    const subs = [];
    for (const blk of blocks) {
      const core = blockCore(lines, blk.start, blk.end);
      // min 3 lines (approved decision 6); {{param}} = no-factor span (P3)
      if (core && core.coreEnd - core.coreStart >= 3 && !(PLACEHOLDER_RE.lastIndex = 0, PLACEHOLDER_RE.test(core.text))) {
        const g = groups.get(core.text) ?? { heading: blk.heading, occ: new Map() };
        if (!g.occ.has(skill)) g.occ.set(skill, []);
        g.occ.get(skill).push({ coreStart: core.coreStart, coreEnd: core.coreEnd });
        groups.set(core.text, g);
      }
      for (const sb of segmentSubBlocks(lines, offsets, isFenced, blk.start, blk.end)) {
        const text = lines.slice(sb.start, sb.end).join("\n");
        if (!blockEligible(text, sb.end - sb.start)) continue;
        subs.push({ ...sb, text });
        const byText = nearDupIndex.get(lines[sb.start]) ?? new Map();
        (byText.get(text) ?? byText.set(text, new Set()).get(text)).add(skill);
        nearDupIndex.set(lines[sb.start], byText);
      }
    }
    skillBlocks.set(skill, subs);
  }

  // F-34b — near-duplicate groups: first line byte-identical in ≥2 skills, bodies DIVERGE.
  // REPORT-ONLY by design (triage F3c): parameterizing a near-dup is semantic work — Fase B,
  // human-approved; nothing here writes a brick or touches a recipe. Deterministic ordering all
  // the way down: variants by body text, skills lexicographic, groups by slug then first line
  // (code-unit compares — locale-independent, the same stance as discover()'s scan sort).
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const nearDups = [];
  for (const [firstLine, byText] of nearDupIndex) {
    if (byText.size < 2) continue; // every occurrence byte-identical → the factor passes' territory
    const skills = new Set();
    for (const who of byText.values()) for (const s of who) skills.add(s);
    if (skills.size < 2) continue; // divergence confined to ONE skill — nothing to share
    const variants = [...byText.entries()]
      .map(([text, who]) => ({ skills: [...who].sort(cmp), lines: text.split("\n") }))
      .sort((a, b) => cmp(a.lines.join("\n"), b.lines.join("\n")));
    nearDups.push({ slug: slugHead(firstLine), firstLine, skills: [...skills].sort(cmp), variants });
  }
  nearDups.sort((a, b) => cmp(a.slug, b.slug) || cmp(a.firstLine, b.firstLine));

  // ── --variants: choose which groups MATERIALIZE as named variant families ──────────────────
  // The unit is the near-dup group above. ADDITIONALLY, a first line whose slug already owns an
  // on-disk family (`onboarded/<slug>_NN.md`) is adopted even when THIS batch alone could never
  // form a group: a single new skill arriving in a later batch must still join the existing
  // family (earlier recipes carry includes, not raw text, so cross-batch membership is only
  // visible through the family bricks — the same stance as ensureBrick's cross-batch reuse).
  // The family NAMESPACE key is the slug alone: two groups that slugify to the same base share
  // one NN sequence (familyMembers is re-read per group, so a member written for an earlier
  // same-slug group this run is already visible/taken for the next).
  const VARIANT_FILE_RE = /^(.*)_(\d{2,})\.md$/; // zero-pad 2 digits; ≥100 grows naturally unpadded
  const familyDirAbs = join(root, cfg.bricks, "onboarded");
  const familyMembers = (slug) => {
    if (!existsSync(familyDirAbs)) return [];
    const members = [];
    for (const f of readdirSync(familyDirAbs)) {
      const m = f.match(VARIANT_FILE_RE);
      if (!m || m[1] !== slug) continue;
      // An unreadable member (dir squatting the name, perms) carries a body that can never match
      // (no reuse) — its slot stays occupied via the allocation's existsSync scan, so the family
      // simply allocates elsewhere; nothing here ever throws the run away.
      let body = null;
      try { body = splitFm(readFileSync(join(familyDirAbs, f), "utf8").replace(/\r\n?/g, "\n")).body; } catch {}
      members.push({ nn: Number(m[2]), name: `onboarded/${basename(f, ".md")}`, body });
    }
    return members;
  };
  let vGroups = [];
  if (variants) {
    vGroups = [...nearDups];
    for (const [firstLine, byText] of nearDupIndex) {
      const slug = slugHead(firstLine);
      if (nearDups.some((g) => g.slug === slug && g.firstLine === firstLine)) continue;
      if (!familyMembers(slug).length) continue; // no on-disk family to join → not a variant case
      const skills = new Set();
      for (const who of byText.values()) for (const s of who) skills.add(s);
      const vs = [...byText.entries()]
        .map(([text, who]) => ({ skills: [...who].sort(cmp), lines: text.split("\n") }))
        .sort((a, b) => cmp(a.lines.join("\n"), b.lines.join("\n")));
      vGroups.push({ slug, firstLine, skills: [...skills].sort(cmp), variants: vs });
    }
    vGroups.sort((a, b) => cmp(a.slug, b.slug) || cmp(a.firstLine, b.firstLine));
  }
  // Every variant text is CLAIMED by the materialization pass: NEITHER identical pass (section
  // or block) may grab a variant shared by ≥2 skills first — it would land at the sha8 path and
  // split the family (dual-review, confirmed by execution: a shared variant that is a WHOLE
  // heading-section with no blank lines is a byte-identical section core AND sub-block at once,
  // and the section pass runs first) — and a double swap of one range would corrupt coordinates.
  const variantTexts = new Set(vGroups.flatMap((g) => g.variants.map((v) => v.lines.join("\n"))));

  // Pass 2 — write bricks. Collision guard (dual-review): a pre-existing file at the computed
  // path is REUSED when byte-identical (idempotent re-run) and SKIPS the group otherwise (never
  // clobber a user brick; sha8 is 32 bits — cheap paranoia). Any write error also just skips the
  // group: factoring degrades, it never throws the run away. ensureBrick is shared by the section
  // pass and the F-34 block pass — ONE collision/reuse policy, not two.
  // A group factors when ≥2 DISTINCT skills share the core in THIS batch, OR when a
  // byte-identical brick ALREADY sits at the deterministic path (a later batch matching a
  // previously-factored section/block — earlier recipes carry the include, not the raw text, so
  // cross-batch sharing is only visible through the brick itself).
  const created = [];   // bricks this run WROTE (deletable on no-consumer)
  const reused = [];    // pre-existing byte-identical bricks (user-owned — reported, never deleted)
  const ensureBrick = (text, slug, distinctSkills) => {
    const brickRel = `onboarded/${slug}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
    const brickPath = join(root, cfg.bricks, brickRel + ".md");
    try {
      if (existsSync(brickPath)) {
        const cur = readFileSync(brickPath, "utf8");
        if (cur !== text + "\n") return null; // different content at the same path → skip the group
        // A brick the SECTION pass created THIS run can be re-matched byte-identically by the
        // BLOCK pass (a whole-section block elsewhere) — record it once; the consumer merge at
        // the end keys by brick path, so a duplicate here would double the report row.
        if (!created.includes(brickRel) && !reused.includes(brickRel)) reused.push(brickRel);
      } else {
        if (distinctSkills < 2) return null; // singleton with no pre-existing brick → nothing to share
        mkdirSync(dirname(brickPath), { recursive: true });
        writeFileSync(brickPath, text + "\n");
        created.push(brickRel);
      }
    } catch { return null; } // unwritable path (dir squatting the name, perms) → skip the group
    return brickRel;
  };

  const replacements = new Map(); // skill → [{coreStart, coreEnd, line}]
  const addRep = (skill, rep) => (replacements.get(skill) ?? replacements.set(skill, []).get(skill)).push(rep);
  for (const [text, g] of groups) {
    // The family claim covers the SECTION pass too (review FIX, found by both vendors and proven
    // by execution): a shared whole-section variant used to be sha8-factored here while the
    // divergent copy became <slug>_01 — a split family Fase B cannot unify. Without --variants,
    // variantTexts is empty and the sha8 section factoring stays byte-identical to today.
    if (variantTexts.has(text)) continue; // claimed by the --variants materialization (pass 2c)
    const brickRel = ensureBrick(text, slugHead(g.heading), g.occ.size);
    if (!brickRel) continue;
    for (const [skill, occs] of g.occ)
      for (const o of occs) addRep(skill, { coreStart: o.coreStart, coreEnd: o.coreEnd, line: `<!-- include: ${brickRel} -->` });
  }

  // Pass 2b (F-34a) — block granularity, ONLY in the residual the section pass left behind: an
  // occurrence overlapping a section replacement for ITS skill is already factored (those lines
  // are about to be spliced away — swapping inside them would corrupt coordinates); blocks in
  // untouched sections are fair game. Grouping happens HERE, after the section outcome is known,
  // so a skill whose whole section factored never drags its sub-blocks into a group.
  const blockGroups = new Map(); // block text → Map(skill → [{start, end, fenced}])
  for (const [skill, subs] of skillBlocks) {
    const reps = replacements.get(skill) ?? [];
    for (const sb of subs) {
      if (variantTexts.has(sb.text)) continue; // claimed by the --variants materialization below
      if (reps.some((rp) => sb.start < rp.coreEnd && sb.end > rp.coreStart)) continue;
      const occ = blockGroups.get(sb.text) ?? new Map();
      (occ.get(skill) ?? occ.set(skill, []).get(skill)).push(sb);
      blockGroups.set(sb.text, occ);
    }
  }
  for (const [text, occ] of blockGroups) {
    const first = text.slice(0, text.indexOf("\n")); // ≥3 lines by candidacy, so "\n" always exists
    const brickRel = ensureBrick(text, slugHead(first), occ.size);
    if (!brickRel) continue;
    // The directive line keeps the block's first-line INDENT: compose() inlines b.trim(), which
    // strips exactly that leading run from the (verbatim) brick body — indent-on-the-directive +
    // verbatim brick is the pair that makes the round trip byte-identical (the gate still judges
    // it; e.g. trailing whitespace on the LAST block line is also trimmed and self-reverts).
    // Inside a fence the swap uses the F-33 bang (`include!:`) — the only form the engine expands
    // there; outside, the plain directive (byte-identical semantics to the section pass).
    const indent = /^[ \t]*/.exec(first)[0];
    for (const [skill, occs] of occ)
      for (const o of occs)
        addRep(skill, { coreStart: o.start, coreEnd: o.end, line: `${indent}<!-- include${o.fenced ? "!" : ""}: ${brickRel} -->` });
  }

  // Pass 2c — --variants materialization: ONE brick per VARIANT, named onboarded/<slug>_NN in
  // the report's deterministic variant order (body text, code-unit). Every version is kept
  // VERBATIM — the family is a staging area for the human Fase B unification, never a merge.
  // Same safety story as the passes above: the swap is by segment coordinates, the round-trip
  // gate judges every touched skill, and a failure degrades PER GROUP (never fails the run).
  const vCreated = [];    // variant bricks THIS RUN wrote (deletable when consumer-less)
  const variantRecs = []; // committed groups, pre-gate: [{ group, firstLine, bricks: [name] }]
  for (const g of vGroups) {
    const members = familyMembers(g.slug); // fresh read: same-slug groups share the NN namespace
    const plan = []; // per-variant swap plan, committed only when the WHOLE group resolves
    let failed = false;
    for (const v of g.variants) {
      const text = v.lines.join("\n");
      // Every occurrence of this variant in each of its skills — minus any overlapping a
      // replacement already planned (its whole section factored: those lines are being spliced
      // away, so swapping inside them would corrupt coordinates). Sub-blocks are disjoint per
      // skill, so variant occurrences can never collide with the block pass or with each other.
      const occs = [];
      for (const skill of v.skills) {
        const reps = replacements.get(skill) ?? [];
        for (const sb of skillBlocks.get(skill))
          if (sb.text === text && !reps.some((rp) => sb.start < rp.coreEnd && sb.end > rp.coreStart)) occs.push({ skill, ...sb });
      }
      if (!occs.length) continue; // the variant was wholly absorbed by the section pass
      // Reuse: ONLY an EXACT-CASE on-disk member (familyMembers keys on the exact readdir name,
      // so a Deploy_01.md never qualifies for the deploy family — the engine's include
      // case-match would reject that path at build anyway) whose body is byte-identical (any NN
      // — the report order of a LATER batch need not match the on-disk order of an earlier one);
      // otherwise the first FREE NN gets a new member (divergent occupants are walked past — the
      // family grows across batches: deploy_04, …).
      let name = members.find((m) => m.body === text + "\n")?.name;
      if (!name) {
        // Free-slot scan by EXISTENCE at the exact candidate path (review FIX 2, destruction
        // proven by execution on NTFS): a differently-cased occupant (Deploy_01.md) is invisible
        // to the exact-case member parse above, but on a case-insensitive filesystem
        // existsSync(deploy_01.md) still finds it — the old taken-set scan considered NN 1 free,
        // writeFileSync OVERWROTE the user's file, the gate then failed on the engine's include
        // case-match, and the consumer-less cleanup DELETED it. An occupied slot — any case, any
        // content — is NEVER written over: the scan moves to the next free NN, which also makes
        // vCreated hold only paths this run created from scratch (the delete-guard invariant the
        // cleanup below relies on).
        let nn = 0, piece;
        do { piece = `${g.slug}_${String(++nn).padStart(2, "0")}`; }
        while (existsSync(join(familyDirAbs, piece + ".md")));
        name = `onboarded/${piece}`;
        // fm is ADVISORY (compose drops brick frontmatter at build, so the round trip only ever
        // sees the verbatim body): it names the piece, its family, and the Fase B intent.
        const fmB = `piece: ${piece}\nvariant-group: ${g.slug}\nsummary: variant ${String(nn).padStart(2, "0")} of a near-identical family — all variants kept verbatim; candidates for ONE {{param}} brick (see the onboard report / Fase B)`;
        try {
          mkdirSync(familyDirAbs, { recursive: true });
          writeFileSync(join(root, cfg.bricks, name + ".md"), `---\n${fmB}\n---\n${text}\n`);
        } catch { failed = true; break; } // unwritable state → this group stays verbatim
        vCreated.push(name);
        members.push({ nn, name, body: text + "\n" }); // visible to this group's next variant
      }
      plan.push({ brick: name, indent: /^[ \t]*/.exec(text)[0], occs });
    }
    if (failed || !plan.length) continue; // degrade per group; an orphan write is swept below
    for (const p of plan)
      for (const o of p.occs)
        addRep(o.skill, { coreStart: o.start, coreEnd: o.end, line: `${p.indent}<!-- include${o.fenced ? "!" : ""}: ${p.brick} -->` });
    variantRecs.push({ group: g.slug, firstLine: g.firstLine, bricks: plan.map((p) => p.brick) });
  }

  // Pass 3 — apply per skill, bottom-up (section and block ranges are disjoint by construction;
  // descending order keeps every earlier index valid). One write per touched skill.
  const touched = new Set();
  for (const [skill, reps] of replacements) {
    const lines = skillLines.get(skill).slice();
    for (const rep of reps.sort((a, b) => b.coreStart - a.coreStart)) {
      lines.splice(rep.coreStart, rep.coreEnd - rep.coreStart, rep.line);
    }
    const r = recipes.get(skill);
    r.body = lines.join("\n");
    writeFileSync(join(root, cfg.recipes, skill + ".md"), r.fm === null ? r.body : `---\n${r.fm}${r.fm ? "\n" : ""}---\n${r.body}`);
    touched.add(skill);
  }
  if (!touched.size) {
    // A group that failed mid-write (or whose swaps were all absorbed) may have left this-run
    // variant bricks behind with no possible consumer — sweep them before returning.
    for (const b of vCreated) rmSync(join(root, cfg.bricks, b + ".md"), { force: true });
    return { factored: [], kept: [], nearDups, variants: [] };
  }

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
  // Variant bricks mirror the created/reused policy above: a this-run brick nobody consumes (its
  // group failed, or its only skill self-reverted at the gate) is dropped; a reused pre-existing
  // family member is the earlier batches' — reported when consumed, never deleted here. `skills`
  // comes from the live consumer map, so a reused member lists its OLD consumers too (the whole
  // family membership is what the Fase B human needs to see).
  const variantsOut = [];
  for (const rec of variantRecs) {
    const bricks = [];
    for (const name of rec.bricks)
      if (consumers[name]?.size) bricks.push({ brick: name, skills: [...consumers[name]].sort() });
    if (bricks.length) variantsOut.push({ group: rec.group, firstLine: rec.firstLine, bricks });
  }
  for (const name of vCreated)
    if (!consumers[name]?.size) rmSync(join(root, cfg.bricks, name + ".md"), { force: true });
  return { factored, kept, nearDups, variants: variantsOut };
}

// ── F-34(b): near-duplicate report rendering (pure — report-only, never a write) ─────────────
// Mechanical {{param}} suggestion for ONE differing line position: the longest common prefix +
// suffix across every variant, with {{paramN}} in the varying middle. Purely lexical (never
// semantic — naming the param is the human's Fase B job); deterministic by construction.
const suggestParamLine = (texts, n) => {
  const min = Math.min(...texts.map((t) => t.length));
  let p = 0;
  while (p < min && texts.every((t) => t[p] === texts[0][p])) p++;
  // The suffix scan is capped at `min - p` so prefix and suffix never overlap on the shortest variant.
  let s = 0;
  while (s < min - p && texts.every((t) => t[t.length - 1 - s] === texts[0][texts[0].length - 1 - s])) s++;
  return texts[0].slice(0, p) + `{{param${n}}}` + texts[0].slice(texts[0].length - s);
};
// One group → markdown lines: the diff lists ONLY the positions that differ, each variant line
// prefixed by the skills that carry it. Line 0 (the group key) is identical by construction and
// never listed. A position where some variant has no line gets "(no such line)" and NO param
// suggestion (a single-line {{param}} cannot absorb a structural difference).
// The `materialized as:` line a group gains under --variants — short brick names (the family is
// always onboarded/…) with each variant's consumers, and the Fase B instruction spelled out.
const materializedLine = (v) =>
  `- materialized as: ${v.bricks.map((b) => `${b.brick.replace(/^onboarded\//, "")} (${b.skills.join(", ")})`).join(", ")} — unify into one {{param}} brick in Fase B (forge-onboard)`;
function renderNearDup(g, mat) {
  const out = [`### ${g.slug} — first line: \`${g.firstLine}\``, ``, `- skills: ${g.skills.join(", ")}`];
  if (mat) out.push(materializedLine(mat)); // --variants: the family this group became
  const maxLen = Math.max(...g.variants.map((v) => v.lines.length));
  let param = 0;
  for (let i = 1; i < maxLen; i++) {
    const texts = g.variants.map((v) => v.lines[i]);
    if (texts.every((t) => t === texts[0])) continue;
    out.push(`- line ${i + 1} differs:`);
    for (const v of g.variants) out.push(`  - ${v.skills.join(", ")}: ${v.lines[i] === undefined ? "(no such line)" : "`" + v.lines[i] + "`"}`);
    if (!texts.includes(undefined)) out.push(`  - suggested \`{{param${++param}}}\` line: \`${suggestParamLine(texts, param)}\``);
  }
  if (new Set(g.variants.map((v) => v.lines.length)).size > 1)
    out.push(`- note: the variants differ in line COUNT — align their structure by hand before extracting a shared brick`);
  out.push(``);
  return out;
}

// ── report (P8): decision telemetry, inside the run's backup dir ─────────────────────────────
function writeReport(backupDir, { discRel, entries, gate, applied, enforce, factoring }) {
  const line = (e) => `| ${e.file.replace(/\\/g, "/")} | ${e.status} | ${e.reason ?? ""}${e.proposal ? ` — ${e.proposal}` : ""} |`;
  // EN like every other user-visible artifact of this repo (the "✔ fiel (diff normalizado zero)"
  // cell was a leftover PT string; the CLI's own gate message already says "normalized diff zero").
  const gateLine = (g) => `| ${g.skill} | ${g.pass ? "✔ faithful (normalized diff zero)" : "✗ GATE FAILED"} |`;
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
        // `(reused)` = the brick pre-existed this run byte-identically (idempotent re-run / a
        // later batch joining an earlier extraction) — the row must say so, or "extracted" reads
        // as "newly written" for a brick this run never touched. Additive: absent when not reused.
        ? [`| brick | used by |`, `|---|---|`, ...factoring.factored.map((f) => `| ${f.brick}${f.reused ? " (reused)" : ""} | ${f.usedBy.join(", ")} |`)]
        : [`No byte-identical shared block (≥3 lines, no {{param}}) was found across two or more skills.`]),
      ...(factoring.kept.length ? [``, `Kept **verbatim** (factored round-trip failed its gate and was reverted): ${factoring.kept.join(", ")}.`] : []),
      ``,
      // F-34(b): without --variants these groups changed NOTHING on disk (report-only). With
      // --variants each group carries a `materialized as:` line naming its variant family; the
      // no-variants rendering below stays byte-identical to the pre-variants report (regression).
      ...(() => {
        const vList = factoring.variants ?? [];
        const vFor = (g) => vList.find((v) => v.group === g.slug && v.firstLine === g.firstLine);
        // A materialized family with NO near-dup group in THIS batch is a cross-batch join (a
        // single new skill matched an on-disk family) — rendered as its own compact entry, or the
        // materialization would be invisible in the report.
        const crossBatch = vList.filter((v) => !factoring.nearDups.some((g) => g.slug === v.group && g.firstLine === v.firstLine));
        return [
          vList.length
            ? `## near-duplicates (materialized as variant families — unify each into ONE {{param}} brick in Fase B)`
            : `## near-duplicates (report-only — candidates for a {{param}} brick)`,
          ``,
          ...(factoring.nearDups.length
            ? [
                vList.length
                  ? `${factoring.nearDups.length} group(s) share a byte-identical first line across skills but diverge in the body. --variants materialized each group below (see its \`materialized as:\` line) as a NAMED VARIANT FAMILY — every version kept verbatim as its own brick; unify each family into ONE {{param}} brick in Fase B (forge-onboard).`
                  : `${factoring.nearDups.length} group(s) share a byte-identical first line across skills but diverge in the body. Nothing was written for these — they are Fase B candidates: extract a {{param}} brick by hand (via forge-onboard) if the variation is a real parameter.`,
                ``,
                ...factoring.nearDups.flatMap((g) => renderNearDup(g, vFor(g))),
              ]
            : [`No near-duplicate block group (same first line in ≥2 skills, diverging body) was found.`, ``]),
          ...crossBatch.flatMap((v) => [
            `### ${v.group} — first line: \`${v.firstLine}\` (cross-batch: joined an existing variant family)`,
            ``,
            materializedLine(v),
            ``,
          ]),
        ];
      })(),
    ] : []),
    ...(enforce ? [`## enforceGenerated`, ``, enforce, ``] : []),
  ].join("\n");
  // Hard guard (athena triage F2, proven by execution): a USER SKILL literally named
  // `onboard-report.md` lands in this dir as a byte-faithful snapshot BEFORE the report is
  // written — writing the report over it would silently destroy the only byte-exact copy of the
  // original (the recipe survives, but LF/BOM-normalized), and the report's own rollback
  // instruction would then restore the report text over the user's skill. The backup dir is
  // fresh per run (snapshot() refuses an existing one) and this is the run's single report
  // write, so a pre-existing file here can ONLY be a snapshot: never overwrite it — fall back
  // to the first free `onboard-report-<n>.md` instead.
  let dest = join(backupDir, "onboard-report.md");
  for (let n = 2; existsSync(dest); n++) dest = join(backupDir, `onboard-report-${n}.md`);
  writeFileSync(dest, md);
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
    if (!hasForgeRole(splitFm(cur.replace(/\r\n?/g, "\n")).fm))
      return { ok: false, msg: `refusing to overwrite ${cfg.outs[0]}/forge-onboard.md: it exists and does NOT carry the forge-role marker (looks like a user file, not our tooling)` };
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  return { ok: true, already: false, msg: `forge-onboard skill installed → ${cfg.outs[0]}/forge-onboard.md. Run it in your agent AFTER \`forge onboard --apply --factor\` (it reads ONBOARD-SPEC.md from the package). It carries the forge-role marker, so onboarding scans always ignore it.` };
}

// ── onboard: the orchestrator. `ts` is ALWAYS injected by the caller (P2 — determinism). ─────
export function onboard({ root = process.cwd(), ts, apply = false, from, factor = false, variants = false } = {}) {
  // --variants IS a form of factoring (it writes bricks and swaps includes) — without --factor
  // there is no factoring pass to hang it on, so this is a usage error, never a silent no-op.
  if (variants && !factor) return { ok: false, msg: "onboard: --variants requires --factor (materializing variant families is a form of factoring) — re-run with --factor --variants" };
  // Backslash spelling of --from (Fable B6) only self-normalizes via join()/resolve() on win32 —
  // POSIX treats `\` as a literal filename character, so `sub\cmd` silently scanned nothing.
  // Fold to forward slashes up front so both the validation below and discover() agree cross-platform.
  if (from) from = from.replace(/\\/g, "/");
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
      msg: summary(` Dry-run: nothing written. Re-run with --apply to migrate (originals are snapshotted first).${factor ? " (--factor takes effect together with --apply.)" : ""}${variants ? " (--variants takes effect together with --apply.)" : ""}${from ? "" : ` Scanning the configured out dir — use --from <dir> if your skills live elsewhere.`}`),
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
    factoring = factorPass({ root, cfg, imported, backupDir, variants });
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
    try { return hasForgeRole(splitFm(readFileSync(absFile, "utf8").replace(/\r\n?/g, "\n")).fm); } catch { return false; }
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
  // F-34: the near-dup count is APPENDED (never reshapes the existing message) and only when
  // there is something to see — the msg stays byte-identical to pre-F-34 runs with no near-dups.
  // --variants clause appended ONLY when something materialized (same additive stance): the msg
  // stays byte-identical to a plain --factor run whenever the variants pass had nothing to do.
  // Review FIX 3: once groups DID materialize, calling them "report-only" alongside
  // "materialized" is a contradiction — the near-dup clause drops that claim exactly (and only)
  // when the variant clause is present; with vGroupCount 0 the wording is byte-identical to F-34.
  const vGroupCount = factoring?.variants?.length ?? 0;
  const vBrickCount = vGroupCount ? factoring.variants.reduce((a, g) => a + g.bricks.length, 0) : 0;
  const nearDupClause = factoring?.nearDups.length
    ? (vGroupCount
        ? `; ${factoring.nearDups.length} near-duplicate group(s) found (see the report)`
        : `; ${factoring.nearDups.length} near-duplicate group(s) reported (report-only — see the report)`)
    : "";
  // `(M reused)` — additive, appended ONLY when a pre-existing byte-identical brick was re-matched
  // (M>0): a batch that only RE-USES an earlier extraction used to report a bare "1 shared
  // brick(s) extracted", indistinguishable from a fresh write. M=0 keeps the msg byte-identical.
  const reusedCount = factoring ? factoring.factored.filter((f) => f.reused).length : 0;
  const factorNote = factoring
    ? ` Factoring: ${factoring.factored.length} shared brick(s) extracted${reusedCount ? ` (${reusedCount} reused)` : ""}${factoring.kept.length ? `, ${factoring.kept.length} kept verbatim (gate)` : ""}${nearDupClause}${vGroupCount ? `; ${vGroupCount} variant group(s) materialized (${vBrickCount} variant brick(s))` : ""}.`
    : "";
  return {
    ok, applied: true, root: discRel, entries, backupDir, gate, enforced, factoring,
    warnings: build.warnings,
    msg: ok
      ? summary(` ${imported.length} migrated, fidelity gate PASSED for all (normalized diff zero).${factorNote} Backup + report: ${backupDir}.${enforced ? " enforceGenerated: ON (100% migrated)." : ""}`)
      : summary(` GATE FAILED for ${gateFails.map((g) => g.skill).join(", ")} — originals are safe in ${backupDir}; see the report.`),
  };
}
