// nbp-skillforge — composition engine. Builds SKILL.md/command files from recipes + bricks.
// Zero dependencies. Generalized from the engine it was extracted from (ADR 0036).
//
// Paths come from forge.config.json at the project root (or the defaults below):
//   { "bricks": "...", "recipes": "...", "out": "...", "enforceGenerated": false }
//
//   Include:  <!-- include: doc-checklist -->
//   Param:    <!-- include: run-dir | skill=fix; flags=--prefix fix --track -->  → {{skill}}/{{flags}}
//   Bang:     <!-- include!: sub-prompt | k=v -->  → F-33: expands even INSIDE a fenced code
//             block (opt-in at the point of use — for factoring duplicated fence content, e.g.
//             subagent prompts). Plain `include:` keeps the F-03 verbatim-in-fence semantics.
//
// F-12: run()'s `errors` array holds structured `{ kind, skill, msg }` objects — never bare
// strings. `kind` ∈ "build" | "conformance" | "drift" | "orphan" | "config" (config covers the
// two whole-project early-return paths: role-dir overlap and a missing recipes/ dir — neither
// has a single `skill`, so `skill` is omitted there). `msg` is the FULL text this project has
// always shown at the CLI (prefix included, e.g. "build error: [demo] …") — `kind` exists purely
// so `blocking` (kind === "build" || kind === "conformance") never depends on string-prefix
// matching; it does NOT change what's printed. bin/cli.mjs's finish() prints `e.msg` verbatim, so
// CLI output stays byte-identical to the pre-F-12 shape (plain strings).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve, sep, isAbsolute, posix } from "node:path";
import { canonFold, isInside } from "./paths.mjs";

const DEFAULTS = {
  bricks: ".claude/forge/bricks",
  recipes: ".claude/forge/recipes",
  out: ".claude/commands",
  archive: ".claude/forge/_archive", // soft-delete target: recipe + exclusive bricks land here (versioned)
  enforceGenerated: false, // true = every generated file must have a recipe (forbids hand-made skills)
  deletePolicy: "soft",    // "soft" = move to archive (recoverable) · "hard" = delete permanently
  conformance: true,       // validate name/description against the SKILL.md standard when present
};

// agentskills SKILL.md spec: name is lowercase a-z/0-9 segments joined by single hyphens.
// Exported so lifecycle.mjs (rename's pre-flight gate, F-08) can validate a candidate name
// against the SAME rule the build enforces, without duplicating the regex/length check.
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isConformantName = (v) => typeof v === "string" && NAME_RE.test(v) && v.length <= 64;
// Minimal, zero-dep field reader: first matching line, value trimmed and unquoted. NOT a YAML
// parser — validates only single-line name/description (the standard's required scalar fields);
// block scalars (`|`/`>`) are out of scope. `fm` is already CRLF-normalized to LF by compose().
const unquote = (v) => (v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/) || [, v])[1];
// Exported (F-31 Fase 1) so the onboarding layer can validate a legacy skill's conformance
// per-file BEFORE import — with the SAME rule the build enforces, never a reimplementation.
export function validateConformance(skill, fm, errors) {
  const nameM = fm.match(/^name:[ \t]*(.*?)[ \t]*$/m);
  if (nameM) {
    const v = unquote(nameM[1]);
    if (!isConformantName(v))
      errors.push({ kind: "conformance", skill, msg: `conformance: [${skill}] name "${v}" must be lowercase a-z/0-9 in single-hyphen segments (no leading/trailing/doubled '-'), 1–64 chars` });
  }
  const descM = fm.match(/^description:[ \t]*(.*?)[ \t]*$/m);
  if (descM) {
    const v = unquote(descM[1]);
    if (v.length === 0) errors.push({ kind: "conformance", skill, msg: `conformance: [${skill}] description must not be empty` });
    else if (v.length > 1024) errors.push({ kind: "conformance", skill, msg: `conformance: [${skill}] description must be ≤1024 chars (got ${v.length})` });
  }
}

// Exported (F-31 Fase 1) for the onboarding pre-scan: legacy skill bodies are checked for
// directive-like text with the SAME regex the engine expands. Global regex — use ONLY with
// matchAll()/replace() (never .test()/.exec(): they leave `lastIndex` dirty and corrupt a later,
// unrelated matchAll in the same process — see the nested-include gate note below).
// F-33: group 1 is the optional bang (`include!:` — "expand EVEN inside a fence"). Group indices
// therefore shifted: m[1]=bang (`"!"` or `""`), m[2]=path, m[3]=params — every consumer below and
// in onboard.mjs was updated in lockstep; a new consumer must use the same indices. The bang sits
// hard against `include` (no `\s*` between them) on purpose: `include !:` is not a directive.
export const INCLUDE = /<!--\s*include(!?):\s*([^\s|]+)\s*(?:\|\s*([^]*?)\s*)?-->/g;
// The {{param}} placeholder the engine substitutes (key charset [\w-]). Single source of truth,
// exported (F-31 Fase 1) so the onboarding pre-scan flags legacy `{{…}}` text with exactly the
// rule the engine applies — and so a future widening (F-27 param defaults) edits ONE regex.
// Same global-regex caution as INCLUDE above.
export const PLACEHOLDER_RE = /\{\{\s*([\w-]+)\s*\}\}/g;
// F-40: scans the composed output for an UNEXPANDED include-family directive OPENER — broader than
// INCLUDE (which only matches the forms THIS binary can expand) so it also catches a directive a
// running binary is too OLD to recognize (athena's case: a stale 0.7.3 install doesn't understand
// `include!:`, leaves it verbatim, and `build` would WRITE `<!-- include!: … -->` into the skill =
// broken). Matches the directive HEAD only — `<!-- include<suffix>:` — which (a) REQUIRES the `:`
// so a plain-English comment like `<!-- include the notes below -->` is NOT a false positive, (b)
// uses `\b` so `<!-- includes: … -->` (a word, not a directive) doesn't match, and (c) never
// consumes past the `:`, so a `>` inside the params (`… | a > b -->`) can't make the match miss.
// Same global-regex caution as INCLUDE (matchAll/replace only).
export const RESIDUAL_INCLUDE_RE = /<!--\s*include\b[^\s:>]*:/g;
// F-31: frontmatter marker that stamps a file as nbp-skillforge's own tooling (e.g. the ephemeral
// `forge-onboard` agent skill). Namespaced VALUE (not just the key) so a user's unrelated
// `forge-role:` field never false-positives. `hasForgeRole` takes the ALREADY-SPLIT fm block
// (splitFm(...).fm) by contract — never raw file text — so a `forge-role:`-shaped line in a BODY
// (e.g. inside a fenced example) is structurally out of reach.
export const FORGE_ROLE_VALUE = "nbp-skillforge/onboard";
// Quote handling via backreference: `("|')?…\1` accepts unquoted or SAME-quoted values and
// rejects mismatched quotes (`"value` / `value'`) — an unparticipated group's backreference
// matches the empty string in JS, so the unquoted case still passes. `\r?` before `$` tolerates
// a caller that split an un-normalized CRLF file (hasForgeRole is then CR-immune by itself).
const FORGE_ROLE_RE = new RegExp(`^forge-role:[ \\t]*("|')?${FORGE_ROLE_VALUE}\\1[ \\t]*\\r?$`, "m");
export const hasForgeRole = (fm) => fm !== null && fm !== undefined && FORGE_ROLE_RE.test(fm);
const BANNER = (name, recipes) =>
  `<!-- GENERATED by nbp-skillforge from ${recipes}/${name}.md — do not edit here; edit the recipe/brick and run \`npx nbp-skillforge build\`. -->`;
// Matches a leading GENERATED banner (with or without its trailing newline) — used by `import`
// to strip a previously-generated banner so a re-import never double-banners on the next build.
// Tolerant to the pre-rename name (`nbp-forge`) so files generated before the nbp-skillforge
// rename are still recognized as generated; the next `build` rewrites them with the new banner.
export const GENERATED_BANNER_RE = /^<!-- GENERATED by nbp-(?:skill)?forge[\s\S]*?-->\n?/;

// F-03: an include directive on a line inside a fenced code block (``` or ~~~, up to 3 leading
// spaces — CommonMark basics, not a full parser) is never expanded/ref-counted — UNLESS it
// carries the F-33 bang (`include!:`), which opts that one directive back in everywhere (the
// fence mask is consulted only for bang-less directives, in all three consumers). A single mask is
// computed once per text and consulted by every INCLUDE-matching consumer — compose()'s
// expansion, includesOf()'s ref-count, and the nested-include-in-a-brick-body gate (F-01) — so a
// brick that merely DOCUMENTS the include syntax inside a fence never (a) leaks an unexpanded
// directive as if it were real content, (b) desyncs gc's ref-count, or (c) trips the nested-
// include gate. Inline single-backtick code spans are explicitly OUT of scope (not masked).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// C4: pure slice helper for the include on-disk CASE MATCH check below — deliberately NOT a
// containment/overlap check (that's paths.mjs's isInside/canon), just "strip the base prefix +
// its separator to get the relative tail". Exported (not inlined) so the drive-root edge case
// (`realBase` IS `C:\`/`/`, already ending in `sep` — appending "+1" would also eat the first
// character of the real relative path) is unit-testable with synthetic strings, without needing
// an actual filesystem drive root.
export const relFromBase = (base, full) => full.slice(base.endsWith(sep) ? base.length : base.length + 1);
// Returns `isFenced(offset)`: true if the character offset in `text` falls on a line inside an
// (open or since-closed) fence. A fence, once opened, stays open until a line with the SAME
// fence character and a run at least as long closes it, or EOF — matching CommonMark's "an
// unclosed fence extends to the end of the document" rule.
// Exported (F-31 Fase 1): the onboarding pre-scan must mask fenced blocks with the SAME rules
// the engine uses to decide expansion — a diverging reimplementation would flag (or miss) a
// directive the build treats the opposite way.
export function fenceMasker(text) {
  const lines = text.split("\n");
  const maskedLine = new Array(lines.length).fill(false);
  let fenceChar = null, fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (fenceChar) {
      maskedLine[i] = true;
      // C2: a closing fence must have nothing but the fence run (+ optional trailing whitespace)
      // on its line — CommonMark requires this. Without the trailing-blank check, a line like
      // `````not-a-close` (a longer/equal fence run immediately followed by more text) would
      // wrongly close the fence, unmasking the rest of the "still fenced" block and letting an
      // include on a later line (still visually inside the ``` block) get expanded/ref-counted.
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && lines[i].slice(m[0].length).trim() === "") fenceChar = null; // closing line
      continue;
    }
    if (m) { fenceChar = m[1][0]; fenceLen = m[1].length; maskedLine[i] = true; } // opening line
  }
  // Prefix line-start offsets so an arbitrary regex match offset maps to its line in O(log n).
  const lineStart = [0];
  for (const l of lines) lineStart.push(lineStart[lineStart.length - 1] + l.length + 1); // +1 = the '\n'
  return (offset) => {
    let lo = 0, hi = maskedLine.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= offset) lo = mid; else hi = mid - 1; }
    return maskedLine[lo];
  };
}

// ── Block segmentation (shared base: onboard's --factor pass AND lifecycle's `promote`, F-36) ──
// Segments a recipe BODY into heading-sections (a heading line up to — not including — the next
// heading; plus a preamble block before the first heading). Fence-aware: a `# ...` line inside a
// code fence is content, not a heading. Line-based; returns { lines, blocks, offsets, isFenced }
// where each block is { heading, start, end } over the half-open line range [start, end). The
// `offsets` (char offset per line) + `isFenced` are exposed (additively) so a caller reuses THIS
// body's fence mask — F-33 parity — instead of recomputing it: one mask per body, engine rules.
// Lives here (not onboard.mjs) so lifecycle.mjs can import it too without an onboard→lifecycle
// import cycle (onboard already imports FROM lifecycle).
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
  return { lines, blocks, offsets, isFenced };
}

// The CORE of a block = its lines minus leading/trailing blank lines. The core (exact bytes,
// joined by \n) is both the dedup key and the future brick body — compose inlines `b.trim()`, so
// keeping the surrounding blank lines in the RECIPE (never in the brick) is what makes the
// factored/promoted round-trip byte-identical. No per-line normalization: near-identical is Fase
// B's job. Returns { coreStart, coreEnd, text } (coreEnd exclusive) or null for an all-blank span.
export function blockCore(lines, start, end) {
  let a = start, b = end - 1;
  while (a <= b && lines[a].trim() === "") a++;
  while (b >= a && lines[b].trim() === "") b--;
  return a > b ? null : { coreStart: a, coreEnd: b + 1, text: lines.slice(a, b + 1).join("\n") };
}

// F-26: `out` accepts string | non-empty array of non-empty strings. Validation lives HERE (the
// one place that branches on the shape) — before this guard, `"out": ["a","b"]` reached
// node:path's join() unguarded and crashed every command with a raw TypeError. The derived
// `cfg.outs` (always an array) is the ONE iteration surface every consumer loops over; `cfg.out`
// stays exactly as authored so init's config-scaffold write keeps round-tripping a single-out
// config as a plain string.
const userErr = (msg) => Object.assign(new Error(msg), { userFacing: true });
function normalizeOut(cfg) {
  const bad = () => { throw userErr(`forge.config.json: "out" must be a non-empty string or a non-empty array of non-empty strings`); };
  if (typeof cfg.out === "string") { if (!cfg.out.trim()) bad(); cfg.outs = [cfg.out]; return cfg; }
  if (Array.isArray(cfg.out)) {
    if (cfg.out.length === 0 || cfg.out.some((o) => typeof o !== "string" || !o.trim())) bad();
    // Exact-duplicate entries would slip past the pairwise role-overlap scan (two entries with the
    // SAME literal key compare as self and are skipped) — reject them here with a precise message.
    // Case-fold/canonical duplicates (`out: ["X","x"]` on Windows) are still the overlap scan's job.
    const seen = new Set();
    for (const o of cfg.out) { if (seen.has(o)) throw userErr(`forge.config.json: duplicate "out" entry: ${o}`); seen.add(o); }
    cfg.outs = [...cfg.out];
    return cfg;
  }
  bad();
}

export function loadConfig(root) {
  const p = join(root, "forge.config.json");
  if (!existsSync(p)) return normalizeOut({ ...DEFAULTS });
  const text = readFileSync(p, "utf8"); // an unreadable file surfaces its own clear fs error
  let user;
  // Wrap ONLY the parse: a clean, user-facing message instead of a raw SyntaxError + stack trace.
  // Marked `userFacing` so the CLI prints just the message; other (unexpected) throws keep their stack.
  try { user = JSON.parse(text); }
  catch (e) { const err = new Error(`forge.config.json: invalid JSON (${e.message})`); err.userFacing = true; throw err; }
  return normalizeOut({ ...DEFAULTS, ...user });
}

// F-40 (part 2): the running binary's own version, read ONCE from the package it ships in. Used to
// honor forge.config.json's optional `minVersion`. Read defensively — a missing/unreadable
// package.json (never expected in a real install) leaves it null and the guard simply no-ops
// rather than crashing a build over a self-diagnostic.
let RUNNING_VERSION = null;
try { RUNNING_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch {}
// Zero-dep semver-lite: compares the numeric major.minor.patch, ignoring any pre-release suffix
// (`-rc.1`) — enough for the "is this binary new enough" gate (maintainer-authored minVersion is a
// plain release like "0.8.1"). Returns -1 | 0 | 1.
export function cmpVersion(a, b) {
  const parse = (v) => String(v).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// F-40 (part 2): if forge.config.json pins `minVersion`, a binary OLDER than it refuses to run
// (build/check) instead of silently mis-generating with an engine the recipes weren't written for.
// Inherent limitation (why part 1 — the residual guard — is the real defense): a binary predating
// this field ignores it entirely, so minVersion only protects from the version that INTRODUCES it
// forward. Returns a config-error string, or null when satisfied / not configured / undeterminable.
export function minVersionError(cfg) {
  if (cfg.minVersion === undefined || cfg.minVersion === null) return null;
  if (typeof cfg.minVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cfg.minVersion.trim()))
    return `forge.config.json: "minVersion" must be a version string like "0.8.1" (got ${JSON.stringify(cfg.minVersion)})`;
  if (RUNNING_VERSION && cmpVersion(RUNNING_VERSION, cfg.minVersion.trim()) < 0)
    return `forge.config.json requires nbp-skillforge ≥ ${cfg.minVersion.trim()}, but this binary is ${RUNNING_VERSION} — upgrade (e.g. \`npx nbp-skillforge@latest\`) or lower "minVersion"`;
  return null;
}

// Brick paths included by a recipe's text (without .md). Basis for ref-counting. Backslashes are
// normalized to '/' so a `core\run` include keys the same as `core/run` (and as mdFiles on Windows).
export function includesOf(text) {
  // Ref-count only what compose() actually expands: the BODY. An include directive sitting inside
  // the recipe's own frontmatter is never scanned/expanded by compose() (fm is emitted verbatim),
  // so counting it here would falsely protect a brick from gc / mark it as a false consumer.
  // CRLF is normalized first — splitFm requires a literal `\n` between the `---` fences, so a
  // CRLF-checked-out recipe would otherwise fail to split and this fix would silently no-op.
  const body = splitFm(text.replace(/\r\n?/g, "\n")).body;
  // F-03: a directive documented inside a fenced code block is not "really" an include —
  // matches compose()'s expansion mask exactly, or gc could archive a brick a live recipe still
  // (verbatim, unexpanded) documents an example for. F-33: a BANG directive is counted even in a
  // fence — compose() really expands it there, so not counting it would let gc archive a live brick.
  const isFenced = fenceMasker(body);
  // Canonicalize so `core\run`, `sub/../foo`, `./foo` all key the same as the real brick path
  // (and as mdFiles) — otherwise ref-counting (gc/remove) mismatches and could delete a used brick.
  // Defensive reset: matchAll CLONES the regex but INHERITS its current lastIndex (verified by
  // execution — a dirty lastIndex silently drops every include before that offset). INCLUDE is an
  // exported global regex (F-31), so an external consumer's stray .test()/.exec() must never be
  // able to corrupt ref-counting (gc/remove could then archive a brick that is actually in use).
  INCLUDE.lastIndex = 0;
  return [...body.matchAll(INCLUDE)].filter((m) => m[1] === "!" || !isFenced(m.index)).map((m) => posix.normalize(m[2].trim().replace(/\\/g, "/")));
}

// Map brick-path → Set(skills) that include it, across the ACTIVE recipes.
export function brickConsumers(root, cfg = loadConfig(root)) {
  const recipesAbs = join(root, cfg.recipes);
  const map = {};
  if (!existsSync(recipesAbs)) return map;
  for (const f of readdirSync(recipesAbs).filter((f) => f.endsWith(".md"))) {
    const skill = basename(f, ".md");
    for (const b of includesOf(readFileSync(join(recipesAbs, f), "utf8"))) {
      (map[b] ??= new Set()).add(skill);
    }
  }
  return map;
}

export const splitFm = (txt) => {
  // The frontmatter block is optional (`---\n---\n`, no fields, is valid and distinct from "no
  // frontmatter at all"): `m` matching at all means the fences were found, so fm is `""` — never
  // `null` — even when the inner group didn't participate in the match (empty block).
  // C1: the closing fence's trailing newline (and the body it introduces) must be matched as ONE
  // unit — `(?:\n([\s\S]*))?` — not `\n?` followed by an unconditional body capture. The old
  // pattern let the closing-fence branch match with NO newline at all, so `---\n---literal body`
  // (a genuinely empty fm immediately followed by body text starting with `---`) had its closing
  // `---` swallow the body's leading `---`, silently dropping it (data loss). Requiring the `\n`
  // and the body group together means the closer must be followed by a real newline OR
  // end-of-input — never by arbitrary trailing text on the same line.
  const m = txt.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n([\s\S]*))?$/);
  return { fm: m ? (m[1] ?? "") : null, body: m ? (m[2] ?? "") : txt };
};
// Split on ';' separators, WITHOUT decoding — escapes are left intact for a SINGLE decode pass
// later (unescapeParam, via parseValue). A ';' preceded by an ODD number of backslashes is escaped
// (`\;`) and does not split; an even count (`\\;`) is an escaped backslash, so that ';' still
// splits. Deferring the decode is what lets a `\\` sitting against a quoted value's closing quote
// be told apart from an escaped quote (`\"`) — the two-pass version collapsed `\\`→`\` first and
// then mis-read the lone `\` + `"` as an escaped quote, swallowing the real close (cross-vendor
// review, adjudicated by execution).
const splitParams = (raw) => {
  const parts = [];
  let cur = "", bs = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === ";" && bs % 2 === 0) { parts.push(cur); cur = ""; bs = 0; continue; }
    cur += c;
    bs = c === "\\" ? bs + 1 : 0;
  }
  parts.push(cur);
  return parts;
};
// The ONE place param escapes are decoded: `\;`→';', `\\`→'\', `\"`→'"', `\'`→"'". Any other `\x`
// is left as-is (so Windows-style paths rarely need escaping). Used for an unquoted value and as
// the fall-through for a value that starts with a quote but isn't a single clean wrapper.
const unescapeParam = (s) => s.replace(/\\([;\\"'])/g, "$1");
// F-38: a param value CLEANLY wrapped in MATCHING quotes (`k="  spaced  "` or `k='…'`) keeps its
// INNER text VERBATIM — leading/trailing whitespace included — so `filtro=" AND x"` stops
// collapsing its leading space onto the adjacent brick text (the G1 bug: `'48 hours'AND`). An
// UNQUOTED value keeps the historical trim (what makes `skill=fix; flags=--a --b` legible).
//
// "Cleanly wrapped" is decided by SCANNING for the matching closing quote, and unwrapping only when
// that close is the value's LAST character — so a value that merely STARTS and ENDS with a quote but
// isn't a single wrapper (`'hello' 'world'`, or an SQL string with inner quotes) is NOT mis-stripped
// (it falls through to the unquoted branch, quotes preserved). Escapes are decoded in ONE pass — the
// scan here decodes `\;`/`\\`/`\"`/`\'` inline as it walks, and unquoted values run the same decode
// via unescapeParam — so a quoted `\\` and an unquoted `\\` yield the SAME single backslash, and a
// `\\` against the closing quote is a literal backslash + a real close, never a mis-read `\"`. To
// emit a value that is ITSELF wrapped in literal quotes, escape the pair (`k=\"x\"` / `k=\'x\'`):
// the leading `\"` stops it being read as a wrapper and the unquoted decode turns `\"`/`\'` literal.
const parseValue = (v) => {
  const t = v.trim(); // `t` still carries raw escapes (splitParams no longer decodes)
  const q = t[0];
  if (q === '"' || q === "'") {
    // Scan for the matching closing quote, decoding escapes as we go (`\<x>` consumes both chars).
    // Because the decode happens HERE, in the same pass that finds the close, a `\\` right before
    // the close (`"a\\"` → value `a\`) is correctly a literal backslash + a real closing quote —
    // never mistaken for `\"` (an escaped quote). Only an UNescaped `q` at the LAST position makes
    // it a clean single wrapper (verbatim inner, whitespace kept); anything else falls through.
    let inner = "", i = 1, closed = false;
    for (; i < t.length; i++) {
      const c = t[i];
      if (c === "\\" && i + 1 < t.length) {
        const n = t[i + 1];
        inner += (n === ";" || n === "\\" || n === '"' || n === "'") ? n : c + n; // decode or keep
        i++;
        continue;
      }
      if (c === q) { closed = true; break; }
      inner += c;
    }
    if (closed && i === t.length - 1) return inner; // the close is the LAST char → a clean wrapper
    // else: starts with a quote but isn't a single clean wrapper → treat as an unquoted value.
  }
  // Unquoted: whitespace already trimmed; a single decode of the `\;`/`\\`/`\"`/`\'` escapes. The
  // `\"`/`\'` decode is what makes the literal-quote escape hatch (`\'x\'` → `'x'`) work.
  return unescapeParam(t);
};
const parseParams = (raw) => {
  const out = {};
  if (raw) for (const part of splitParams(raw)) {
    const s = part.trim(); if (!s) continue;
    const i = s.indexOf("=");
    out[i < 0 ? s : s.slice(0, i).trim()] = i < 0 ? "" : parseValue(s.slice(i + 1));
  }
  return out;
};

// F-18: on drift, point at the first diverging line (1-indexed) with a short excerpt of each
// side, so a `check` failure is diagnosable without a manual diff. Both inputs are already
// LF-normalized by the caller (compose() output is always LF; `cur` is normalized right before
// this is called), so this is a plain line-array comparison — no CRLF handling needed here.
// When one side runs out of lines first (a trailing line was added/removed by hand), the shorter
// side reports "end-of-file" instead of an excerpt, symmetrically in either direction.
const DIFF_EXCERPT_LEN = 60;
const diffExcerpt = (s) => (s === undefined ? "end-of-file" : `"${s.length > DIFF_EXCERPT_LEN ? s.slice(0, DIFF_EXCERPT_LEN) + "…" : s}"`);
// Exported (F-36): lifecycle's `promote` reuses it to point at the diverging line when a
// promotion's round-trip gate fails — the same diagnostic the drift-gate shows.
export function firstDiffSuffix(expectedText, foundText) {
  const expectedLines = expectedText.split("\n");
  const foundLines = foundText.split("\n");
  const n = Math.max(expectedLines.length, foundLines.length);
  for (let i = 0; i < n; i++) {
    const e = i < expectedLines.length ? expectedLines[i] : undefined;
    const f = i < foundLines.length ? foundLines[i] : undefined;
    if (e === f) continue;
    return ` (first difference at line ${i + 1}: expected ${diffExcerpt(e)}, found ${diffExcerpt(f)})`;
  }
  return ""; // callers only invoke this when expectedText !== foundText, so this is unreachable
}

// F-43: the single brick-expansion unit — path safety, on-disk case match, no-nested-include gate,
// and {{param}} substitution — factored out of compose()'s INCLUDE replacer so that BOTH `build`
// and the read-only `forge expand <brick> --params …` preview run byte-identical logic (a preview
// that diverged from what build emits would be worse than none). Returns the expanded brick body
// (trimmed) or a `‹…›` sentinel, pushing a structured build error for every failure — exactly as
// the inline code did. `p` is the raw include path, `rawP` the raw param string; `name` is the
// owning skill/brick used only in error prefixes. Behavior-preserving extraction (the build's
// byte-level tests pin that it did not drift).
export function expandBrick(bricksAbs, p, rawP, name, errors, warnings) {
  const bp = posix.normalize(p.trim().replace(/\\/g, "/"));
  const file = join(bricksAbs, bp + ".md");
  // Keep includes inside the bricks root — an absolute or `../` (post-normalization) path must
  // not read (and inline) files outside bricks/, nor leave a path lifecycle code could move/delete.
  if (isAbsolute(bp) || bp === ".." || bp.startsWith("../") || !isInside(resolve(file), resolve(bricksAbs))) {
    errors.push({ kind: "build", skill: name, msg: `build error: [${name}] include path escapes bricks/: ${bp}` }); return `‹UNSAFE INCLUDE: ${bp}›`;
  }
  if (!existsSync(file)) { errors.push({ kind: "build", skill: name, msg: `build error: [${name}] include of missing brick: ${bp}` }); return `‹MISSING BRICK: ${bp}›`; }
  // Keying stays case-sensitive (ref-count is not case-folded); instead require the include's
  // case to match the on-disk file exactly, even on a case-insensitive FS (Windows/macOS) where
  // existsSync() above would otherwise let a mismatched case silently through. Runs unconditionally
  // (not gated by platform) so behavior never bifurcates by OS — on a case-sensitive FS the
  // existsSync() check above already rejected a mismatch, so this is inert there.
  try {
    const realBase = realpathSync.native(bricksAbs);
    const real = realpathSync.native(file);
    // A-1: a symlink whose target resolves OUTSIDE bricks/ used to be silently followed (SPEC
    // "out of scope"); the on-disk identity check now rejects it. Distinguish that from a real
    // case mismatch — otherwise the message ("case mismatch (on-disk: <garbage suffix>)") is
    // nonsensical for a target outside the tree. Rejecting a symlinked brick is intentional
    // (coherent with lifecycle's insideBricks + deterministic build) — see SPEC.
    if (!isInside(real, realBase)) {
      errors.push({ kind: "build", skill: name, msg: `build error: [${name}] include resolves outside bricks/ (symlink?): ${bp}` });
      return `‹UNSAFE INCLUDE: ${bp}›`;
    }
    const relReal = relFromBase(realBase, real).replace(/\\/g, "/");
    if (relReal !== bp + ".md") {
      errors.push({ kind: "build", skill: name, msg: `build error: [${name}] include path case mismatch: ${bp} (on-disk: ${relReal})` });
      return `‹CASE MISMATCH: ${bp}›`;
    }
  } catch { errors.push({ kind: "build", skill: name, msg: `build error: [${name}] include of missing brick: ${bp}` }); return `‹MISSING BRICK: ${bp}›`; }
  const params = parseParams(rawP);
  // A brick that exists but cannot be READ — a directory squatting `<name>.md` (EISDIR: it
  // passes existsSync, realpath, and the case-match above), or a permissions failure — is an
  // ENVIRONMENT problem, not a programming error: structured, blocking build error (nothing
  // written project-wide), never a raw stack trace. Mirrors the destination-side EISDIR
  // handling in run() (Fable B9) — the source side had no such symmetry until now.
  let brickRaw;
  try { brickRaw = readFileSync(file, "utf8"); }
  catch (e) {
    errors.push({ kind: "build", skill: name, msg: `build error: [${name}] cannot read brick ${bp} (${e.code ?? e.message}) — is it a directory?` });
    return `‹UNREADABLE BRICK: ${bp}›`;
  }
  let b = splitFm(brickRaw.replace(/\r\n?/g, "\n")).body;
  // Bricks must not include bricks (composition lives in the recipe, AGENTS.md's "no nesting"
  // rule enforced as a gate) — use matchAll (NEVER .test()/.exec() on the shared module-level
  // INCLUDE regex: it is global, so .test() would leave `lastIndex` dirty and corrupt a LATER,
  // unrelated .matchAll(INCLUDE) call in the same process, e.g. ref-counting for another recipe).
  // F-03: a brick that merely DOCUMENTS the include syntax inside a fence (e.g. explaining "how
  // to use includes") is not a real nested include — same fence mask as the two consumers above.
  // F-33: a BANG directive inside a brick's fence WOULD be expanded, so it is a real nested
  // include → same build error (bang-less-in-fence stays allowed: it's documentation).
  const isFencedBrick = fenceMasker(b);
  INCLUDE.lastIndex = 0; // same defensive reset as includesOf — see the note there (F-31 export)
  const nested = [...b.matchAll(INCLUDE)].filter((m) => m[1] === "!" || !isFencedBrick(m.index));
  if (nested.length) {
    const inner = posix.normalize(nested[0][2].trim().replace(/\\/g, "/"));
    errors.push({ kind: "build", skill: name, msg: `build error: [${name}] brick ${bp} contains a nested include (${inner}) — bricks must not include bricks (inline the content or include both from the recipe)` });
    return `‹NESTED INCLUDE: ${inner}›`;
  }
  const usedKeys = new Set();
  b = b.replace(PLACEHOLDER_RE, (_, k) => {
    usedKeys.add(k);
    if (!(k in params)) { errors.push({ kind: "build", skill: name, msg: `build error: [${name}] brick ${bp} requires {{${k}}}, not provided by the recipe` }); return `‹NO ${k}›`; }
    return params[k];
  });
  const unused = Object.keys(params).filter((k) => !usedKeys.has(k));
  if (unused.length) warnings.push(`warning: [${name}] include ${bp}: unused param(s): ${unused.join(", ")}`);
  return b.trim();
}

// Exported (F-36): lifecycle's `promote` composes a single skill's output in memory, before and
// after the recipe rewrite, so its byte-identical gate judges exactly what `build` would emit —
// no divergent reimplementation of the compose path. `errors`/`warnings` are caller-owned arrays.
export function compose(name, cfg, root, errors, warnings) {
  const bricksAbs = join(root, cfg.bricks);
  const raw = readFileSync(join(root, cfg.recipes, name + ".md"), "utf8").replace(/\r\n?/g, "\n");
  const { fm, body } = splitFm(raw);
  if (cfg.conformance && fm !== null) validateConformance(name, fm, errors);
  // F-03: an include directive on a line inside a fenced code block is left verbatim (`whole`),
  // e.g. a recipe/brick showing include syntax as a documentation example inside a ``` fence.
  // F-33: the bang form (`include!:`) expands ALWAYS — inside or outside a fence — so duplicated
  // fence content (subagent prompts etc.) can be factored into a brick. The opt-in lives at the
  // point of use, never on the fence, so every other directive in the same fence stays verbatim.
  const isFencedBody = fenceMasker(body);
  const out = body.replace(INCLUDE, (whole, bang, p, rawP, offset) => {
    if (!bang && isFencedBody(offset)) return whole;
    return expandBrick(bricksAbs, p, rawP, name, errors, warnings);
  });
  // F-40 (part 1 — the real defense): the composed body must never carry an UNEXPANDED
  // include-family directive. A recipe/brick may legitimately DOCUMENT plain `include:` syntax
  // inside a fenced code block (F-03 verbatim), so a bang-LESS directive that lands inside a fence
  // is allowed; a BANG form (always expands) or ANY include-family directive OUTSIDE a fence
  // should have expanded — a residual one means this binary didn't recognize it (too OLD, or a
  // bug), so we REFUSE to emit a broken skill instead of writing the literal directive out. This
  // fires in THIS binary only as an invariant assertion (it always expands what it knows); its
  // real value is protecting every FUTURE version pair — a binary too old to expand a newer
  // directive shape errors here rather than silently writing garbage (athena's `include!:` case).
  const outMasked = fenceMasker(out);
  RESIDUAL_INCLUDE_RE.lastIndex = 0;
  for (const m of out.matchAll(RESIDUAL_INCLUDE_RE)) {
    const bang = /^<!--\s*include!/.test(m[0]); // the bang form sits hard against `include`
    if (!bang && outMasked(m.index)) continue;  // plain include documented inside a fence — legit
    const snip = out.slice(m.index).split("\n", 1)[0]; // the residual directive's whole line
    errors.push({ kind: "build", skill: name, msg: `build error: [${name}] unexpanded include directive left in output (${snip.length > 70 ? snip.slice(0, 70) + "…" : snip}) — this nbp-skillforge binary may be older than the recipe needs; upgrade (e.g. \`npx nbp-skillforge@latest\`) and rebuild` });
  }
  // fm === "" (present but empty) must NOT insert a blank line between the two fences.
  const head = fm === null ? `${BANNER(name, cfg.recipes)}\n` : `---\n${fm}${fm ? "\n" : ""}---\n${BANNER(name, cfg.recipes)}\n`;
  return head + out.replace(/\s*$/, "") + "\n";
}

// mode: "build" | "check". dryRun (build only): compose + classify, write NOTHING.
// Returns { ok, drift, orphans, errors, warnings, count, written, unchanged, plan }.
// `plan` (build mode) is [{ name, status }] with status "create" | "change" | "same".
// `warnings` are NON-blocking (never affect `ok`/exit code) — e.g. an unused include param.
// The role dirs must be mutually non-nested: build writes into out, and gc scans bricks
// recursively — so any overlap (equal, or one inside another) could clobber/delete source files.
// canonFold: realpath (resolves symlinks/junctions, canonical on-disk case) with a lexical
// resolve() fallback for a role dir that doesn't exist yet, folded to lowercase on a
// case-insensitive filesystem (Windows/macOS) so `Bricks` and `bricks` overlap — needed HERE
// (not just plain canon()) because out/archive can both be simultaneously nonexistent
// (fresh project, pre-first-build), which forces the fallback on both sides.
// F-26: one entry PER out, keyed by its literal configured path (actionable message without
// cross-referencing array indices); exact-duplicate literals were already rejected in loadConfig,
// so ak !== bk never wrongly skips a real pair here. Growth is O((3+N)²) — trivially cheap.
// EXPORTED (F-26 review fix, verified by a destructive repro): the mutating lifecycle commands
// (remove/rename) delete a skill's output from every out dir BEFORE their follow-up run() would
// ever validate the config — with a hostile `out` entry overlapping bricks/ they destroyed a
// SOURCE brick first. They now call this same check pre-flight and fail closed, touching nothing.
export function roleOverlapError(root, cfg) {
  const R = [
    ["bricks", canonFold(join(root, cfg.bricks))], ["recipes", canonFold(join(root, cfg.recipes))], ["archive", canonFold(join(root, cfg.archive))],
    ...cfg.outs.map((o) => [cfg.outs.length === 1 ? "out" : `out '${o}'`, canonFold(join(root, o))]),
  ];
  for (const [ak, a] of R) for (const [bk, b] of R)
    if (ak !== bk && isInside(b, a))
      return `config error: '${bk}' must not be inside or equal to '${ak}' (build/gc would clobber source files)`;
  return null;
}

export function run({ root = process.cwd(), mode = "build", dryRun = false } = {}) {
  const cfg = loadConfig(root);
  const recipesAbs = join(root, cfg.recipes);
  // F-26: N destinations. `cfg.outs` is the one always-array surface (loadConfig derives it);
  // every loop below iterates (recipe × out). N=1 must reproduce the historical single-out
  // behavior byte-for-byte — that is the retrocompat contract the tests pin.
  const outsAbs = cfg.outs.map((o) => join(root, o));
  const bricksAbs = join(root, cfg.bricks);
  const archiveAbs = join(root, cfg.archive);
  // Early error returns carry the FULL result shape (SPEC "JSON output": plan/out — and every
  // aggregate field — always present; consumers never branch on a field's absence). Before this,
  // the two config-error paths emitted a partial {ok,errors,drift,orphans,destinations} with no
  // warnings/count/written/unchanged (and no plan on build), breaking exactly that contract.
  // Zeroed/empty by construction: a refused config composed nothing and wrote nothing.
  const configErr = (msg) => ({
    ok: false, errors: [{ kind: "config", msg }], drift: 0, orphans: 0,
    warnings: [], count: 0, written: 0, unchanged: 0,
    plan: mode === "build" ? [] : undefined, // mirrors the happy path: plan is a build-only field
    destinations: cfg.outs.length,
  });
  // F-40 (part 2): a version pin is checked BEFORE anything is composed — a binary too old for the
  // recipes refuses up front (build/check both) rather than mis-generating. Same config-error shape.
  const vErr = minVersionError(cfg);
  if (vErr) return configErr(vErr);
  const overlap = roleOverlapError(root, cfg);
  if (overlap) return configErr(overlap);
  if (!existsSync(recipesAbs)) return configErr(`no recipes directory: ${cfg.recipes} — run \`npx nbp-skillforge init\` to scaffold a forge project`);

  const names = readdirSync(recipesAbs).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md"));
  const errors = [];
  const warnings = [];
  const plan = []; // build mode: [{ name, out, dest, built, status }] — status drives skip-if-unchanged
  let drift = 0;

  for (const name of names) {
    // Composed ONCE per recipe — content depends only on recipe/bricks/params, never on the
    // destination (the banner names the recipe, not the out dir) — then written to N places.
    const built = compose(name, cfg, root, errors, warnings); // always LF (compose normalizes its inputs)
    for (let i = 0; i < outsAbs.length; i++) {
      const outEntry = cfg.outs[i];
      const dest = join(outsAbs[i], name + ".md");
      // Fable B9: a DIRECTORY squatting the destination name used to crash raw (EISDIR) in both
      // modes — an environment problem, not a programming error, so it must be a structured,
      // blocking error (nothing written project-wide, like any build error), not a stack trace.
      let raw = null;
      if (existsSync(dest)) {
        try { raw = readFileSync(dest, "utf8"); }
        catch (e) {
          errors.push({ kind: "build", skill: name, msg: `build error: [${name}] cannot read destination ${outEntry}/${name}.md (${e.code ?? e.message}) — is it a directory?` });
          continue;
        }
      }
      if (mode === "check") {
        // Drift in ANY destination fails the gate; each drifted destination is reported by name.
        if (raw === null) { drift++; errors.push({ kind: "drift", skill: name, msg: `drift: ${outEntry}/${name}.md is missing (run \`npx nbp-skillforge build\`)` }); continue; }
        // Drift-gate is CR-insensitive: a CRLF checkout (git autocrlf) is NOT a false positive.
        const cur = raw.replace(/\r\n?/g, "\n");
        if (cur !== built) { drift++; errors.push({ kind: "drift", skill: name, msg: `drift: ${outEntry}/${name}.md is out of sync with its recipe${firstDiffSuffix(built, cur)}` }); }
      } else {
        // Build compares RAW bytes so it stays the source of the "output is always LF" guarantee:
        // a CRLF-on-disk output differs from the LF `built`, so it is rewritten (healed), not skipped.
        // Only a byte-identical (LF) file is "same" → the skip-if-unchanged no-op. PER DESTINATION:
        // a recipe already correct in out[0] but stale/missing in out[1] writes only out[1].
        plan.push({ name, out: outEntry, dest, built, status: raw === null ? "create" : raw !== built ? "change" : "same" });
      }
    }
  }

  let orphans = 0;
  if (cfg.enforceGenerated) {
    const recipeNames = new Set(names);
    // F-26: every out dir is scanned independently — an orphan in out[1] alone is still an orphan.
    // A recipe never built to a newly-added out entry is NOT an orphan there (nothing extra sits
    // on disk); that case is check's "missing" drift above — orphan = extra un-owned file.
    for (let i = 0; i < outsAbs.length; i++) {
      if (!existsSync(outsAbs[i])) continue;
      for (const f of readdirSync(outsAbs[i]).filter((f) => f.endsWith(".md"))) {
        const n = basename(f, ".md");
        if (recipeNames.has(n)) continue;
        // F-31: a file carrying the forge-role marker is nbp-skillforge's OWN tooling (e.g. the
        // ephemeral forge-onboard agent skill) — package tooling is never an orphan, so strict
        // mode and an installed tool can coexist. Read only the rare orphan CANDIDATES (never
        // every governed file), so the cost is negligible.
        try { if (hasForgeRole(splitFm(readFileSync(join(outsAbs[i], f), "utf8").replace(/\r\n?/g, "\n")).fm)) continue; } catch {}
        orphans++; errors.push({ kind: "orphan", skill: n, msg: `orphan: ${cfg.outs[i]}/${n}.md has no recipe (enforceGenerated)` });
      }
    }
  }

  // Blocking errors (missing brick/param, or a conformance violation) → write nothing
  // (never emit a corrupt or non-standard output). All-or-nothing, like the existing build.
  // Classified by `kind`, not by string prefix (F-12) — a new error kind that forgets to opt in
  // stays non-blocking by default, instead of silently escaping this check.
  const blocking = errors.some((e) => e.kind === "build" || e.kind === "conformance");
  let written = 0;
  if (mode === "build" && !blocking && !dryRun) {
    // Skip-if-unchanged: only touch a file whose content actually differs. An identical re-build
    // leaves the working tree clean (no spurious mtime churn) and makes `written` an honest count.
    // Fable B8: a write failure (read-only file, EPERM/EACCES) is an ENVIRONMENT error — it
    // becomes a structured build error (ok:false, counted honestly) instead of a raw stack trace
    // that aborts mid-loop with no report; consumers like onboard then take their normal
    // "build failed" path (report written, backup preserved).
    // Deliberately BEST-EFFORT across destinations: the remaining writes still run (a broken
    // out[0] must not leave out[1] stale too). All-or-nothing applies to CONTENT errors (the
    // `blocking` gate above, before any write) — not to per-destination I/O failures.
    for (const p of plan) {
      if (p.status === "same") continue;
      try {
        mkdirSync(dirname(p.dest), { recursive: true });
        writeFileSync(p.dest, p.built);
        written++;
      } catch (e) {
        errors.push({ kind: "build", skill: p.name, msg: `build error: [${p.name}] cannot write ${p.out}/${p.name}.md (${e.code ?? e.message}) — read-only file or permissions?` });
      }
    }
  }

  const unchanged = mode === "build" ? plan.filter((p) => p.status === "same").length : 0;
  return {
    ok: errors.length === 0, drift, orphans, errors, warnings, count: names.length, written, unchanged,
    // F-26 (DECISION 2): plan entries are { name, out, status } — one per (recipe × out) pair,
    // `out` ALWAYS present (even N=1) so --json consumers never branch on config shape. This is
    // the one documented breaking change to the --json build output.
    plan: mode === "build" ? plan.map(({ name, out, status }) => ({ name, out, status })) : undefined,
    // DECISION 6: the CLI appends "across N destination(s)" to the build summary only when N > 1.
    destinations: cfg.outs.length,
  };
}

// F-43: read-only preview — compose WITHOUT writing anything to disk, so a param-heavy include can
// be inspected before `build` + `git diff`. Two modes on ONE verb:
//   • recipe mode (`forge expand <recipe>`): the full generated skill (banner + expanded body),
//     exactly what build would write — routed through compose(), so the F-40 residual guard and
//     every build error surface here too.
//   • brick mode (`forge expand <brick> --params k=v; …`): a single brick expanded with the given
//     params, via the SAME expandBrick() build uses — so the preview shows the real substitution
//     (G1 collapsed whitespace, G2 `{single}` left literal) with no divergence from build.
// Resolution when the caller doesn't force a mode: `--params` given → brick; else an existing
// recipe wins; else an existing brick; else an error. Returns { ok, text?, mode, name, errors,
// warnings, msg? } — `text` is the composed output (absent only when the name resolved to nothing).
export function expand({ root = process.cwd(), name, paramsRaw, mode } = {}) {
  const cfg = loadConfig(root);
  const errors = [], warnings = [];
  // `name` here is USER input (unlike build, which only ever sees names from readdirSync of the
  // role dirs) — so it must be contained. Reject an absolute path or one that climbs out with `..`
  // before it can resolve `recipes/../../secret` and preview a file outside the project. (Brick
  // mode is also guarded again inside expandBrick, but recipe mode routes straight to compose(),
  // which trusts its name — so the gate lives here, covering both.) A nested name (`core/run`) is
  // fine: it normalizes without a leading `../`.
  const npath = typeof name === "string" ? posix.normalize(name.replace(/\\/g, "/")) : "";
  if (!npath || isAbsolute(name) || npath === ".." || npath.startsWith("../")) {
    return { ok: false, name, errors, warnings, msg: `expand: invalid name "${name}" (must stay inside the project)` };
  }
  const recipeFile = join(root, cfg.recipes, name + ".md");
  const brickFile = join(root, cfg.bricks, name + ".md");
  let resolved = mode;
  if (!resolved) resolved = paramsRaw !== undefined ? "brick" : existsSync(recipeFile) ? "recipe" : existsSync(brickFile) ? "brick" : null;
  if (resolved === "recipe") {
    if (!existsSync(recipeFile)) return { ok: false, mode: "recipe", name, errors, warnings, msg: `expand: no recipe "${name}" in ${cfg.recipes}/` };
    let text;
    try { text = compose(name, cfg, root, errors, warnings); }
    catch (e) { return { ok: false, mode: "recipe", name, errors, warnings, msg: `expand: cannot read recipe "${name}" (${e.code ?? e.message})` }; }
    const ok = !errors.some((e) => e.kind === "build" || e.kind === "conformance");
    return { ok, text, mode: "recipe", name, errors, warnings };
  }
  if (resolved === "brick") {
    if (!existsSync(brickFile)) return { ok: false, mode: "brick", name, errors, warnings, msg: `expand: no brick "${name}" in ${cfg.bricks}/` };
    const bricksAbs = join(root, cfg.bricks);
    const text = expandBrick(bricksAbs, name, paramsRaw ?? "", name, errors, warnings);
    const ok = !errors.some((e) => e.kind === "build");
    return { ok, text: text + "\n", mode: "brick", name, errors, warnings };
  }
  return { ok: false, name, errors, warnings, msg: `expand: no recipe or brick named "${name}"` };
}
