# SPEC — skill composition

## Model
A skill is a **recipe** (`recipes/<name>.md`) that points to **bricks**
(`bricks/<path>.md`). `build` resolves the pointers and emits `<out>/<name>.md`
(a standard, self-contained SKILL.md/command file with a "GENERATED" banner).

The forge only governs skills that **have a recipe**. Migration is incremental: anything
without a recipe is left untouched (and, with `enforceGenerated`, flagged as an orphan).

> `forge` below = `npx nbp-skillforge` (or `nbp-skillforge` if installed globally; `node bin/cli.mjs` from a clone).

## Include directive
```
<!-- include: <brick-path> [| k=v; k2=v2 ...] -->
```
- `<brick-path>` is relative to `bricks/`, without `.md` (can be nested: `core/run-dir`).
- Parameters after `|`, separated by `;` (a value may contain spaces).
- A value may contain a **literal `;`** by escaping it as `\;`; a literal backslash is `\\`.
  (Any other `\x` is left untouched, so Windows-style paths usually need no escaping.)
- In the brick body, `{{k}}` is replaced by the value. Missing parameter → **build error**
  (nothing is written). Missing brick → **build error**. A parameter passed by the recipe but not
  referenced by any `{{k}}` in the brick is a non-blocking **warning** (`build`/`check` still
  succeed, the file is still written) — printed as `warning: [<skill>] include <brick>: unused
  param(s): <k1>, <k2>`; useful for catching a typo'd key.
- A parameter value cannot contain the literal sequence `-->` (it closes the HTML comment that
  carries the directive) — same as any HTML comment. Precisely: the directive's parameters end at
  the **first** `-->` on the line; whatever follows it lands **verbatim in the output body** — no
  error, no warning (the engine cannot tell it from ordinary text after a comment). Use a
  placeholder in the brick if you need the sequence itself.
- `<brick-path>` is **case-sensitive** and must match the on-disk file exactly, even on a
  case-insensitive filesystem (Windows/macOS) — a mismatched case is a **build error**
  (`include path case mismatch`), not a silently-succeeding include.
- A **brick's body must not itself contain an include directive** — bricks do not include bricks
  (composition lives in the recipe). A nested include is a **build error**; inline the content into
  the brick, or include both bricks from the recipe instead. An include directive inside a *brick's
  own* frontmatter is not affected (that block is dropped entirely — see Frontmatter).
- A **plain** include directive on a line **inside a fenced code block** (```` ``` ```` or `~~~`,
  up to 3 leading spaces of indentation — CommonMark basics) is **left verbatim, not expanded**,
  and is **not ref-counted** (a brick cited only inside such a fence is an orphan to `gc`) — so a
  recipe/brick can document the include syntax itself as a fenced example. An unterminated fence
  (opened, never closed) masks everything after it to the end of the file. Only block fences are
  recognized; an inline single-backtick code span (`` `<!-- include: … -->` ``) does **not** mask a
  directive — it still expands. The **bang form** (next bullet) is the deliberate exception.
- **Bang form:** `<!-- include!: <brick-path> [| k=v ...] -->` expands **always — inside or
  outside a fenced code block** (```` ``` ```` and `~~~` alike). It is the escape hatch for
  factoring duplicated fence content (e.g. a subagent prompt embedded in a code block). The opt-in
  is **per directive, at the point of use — never per fence**: a bang and a plain `include:` on
  lines of the *same* fence behave independently (the bang expands, the plain one stays verbatim).
  Outside a fence the bang is inert: the directive behaves **byte-identically** to a plain
  `include:` (same parameters, same path-escape/symlink/case-match checks, same errors). A bang
  directive is always **ref-counted**, even inside a fence — a brick consumed only via
  bang-in-fence is *not* an orphan to `gc`, and `remove`'s exclusive sweep sees the consumer. A
  bang directive inside a fence in a **brick's** body *would* be expanded, so it is a **real
  nested include** → the same build error as the unfenced case, nothing written (a bang-less
  fenced directive in a brick remains allowed — that's documentation). Syntax is strict: the `!`
  must sit hard against `include` (`include!:`) — `include !:` is **not** a directive. Because the
  bang expands even inside fences, the literal token cannot be written in a governed file — see
  Known limitations.

## Frontmatter
- **Recipe:** the frontmatter (`name`, `description`, …) is passed verbatim to the generated
  file (compatible with the agentskills standard). The banner goes right after the closing `---`.
  An **empty** frontmatter block (`---\n---\n`, no fields) is valid — distinct from no frontmatter
  at all — and passes conformance vacuously (no `name`/`description` to validate); the banner still
  goes right after the closing `---`, with no blank line inserted.
- Only an include directive in the recipe's **body** is expanded and ref-counted; one placed inside
  the recipe's own frontmatter is passed through verbatim (frontmatter is never scanned) and does
  **not** count toward a brick's reference count for `gc`/`remove`/`list`.
- **Brick:** its own frontmatter is **dropped** on expansion — only the body is inlined. The fields
  are **advisory metadata for humans/agents reading the brick; the engine never validates them**
  (only a recipe's `name`/`description` are validated — see Conformance). One field is *read* by
  the lifecycle commands (`keep`, below) — but like every other field it is dropped on build and
  never reaches the generated output. Recommended fields:

  | field | meaning |
  |---|---|
  | `piece` | the brick's stable id (usually equals its path/filename) |
  | `summary` | one line: what this brick contributes when included |
  | `kind` | optional tag for how it's used (e.g. `step`, `checklist`, `contract`) |
  | `guarantees-not` | optional: limits the brick explicitly does **not** promise (so a recipe author doesn't assume more than it delivers) |
  | `keep` | `keep: true` **pins** the brick against auto-archival: exempt from `gc`'s orphan sweep and `remove`'s exclusive-brick sweep, even with `--hard` (see Lifecycle & ownership). For an intentionally-orphan brick, e.g. staging content not yet wired into a recipe. **Fail-closed:** only a well-formed `true` pins (unquoted, or quoted with *matching* quotes); any other value (`false`, `yes`, `"maybe"`, mismatched quotes), a missing field, no frontmatter at all, or an unreadable brick = **not pinned**. A `keep` field that is **present but malformed** on a sweep candidate is never silently swept: `gc`/`remove` append `warning: keep field present but not well-formed (NOT pinned): <bricks> — only \`keep: true\` pins (see SPEC).` and list the bricks in the additive `suspectKeep` array of their results. |

  Unknown fields are allowed and ignored. Since the whole block is dropped, nothing here reaches the
  generated file.

## Authoring a brick
You don't need to read the engine to author. A brick is just a Markdown file whose **body** gets
inlined where a recipe includes it.

1. **Create it** — there is no `forge new-brick`; drop a file at `bricks/<path>.md` (nested is fine:
   `bricks/core/run-dir.md` → include as `core/run-dir`). Its ref-count starts at 0 until a recipe
   includes it; `forge list` shows consumers and `forge gc` archives bricks nobody includes.
2. **Own your heading.** The body is inlined **verbatim** (trimmed of surrounding blank lines), with
   **no wrapper added** — the brick is responsible for its own heading and structure. If a section
   heading belongs in the output, put it *inside the brick* (e.g. start the body with `### Working
   folder`); recipes must **not** wrap or re-number the include. This keeps the same brick rendering
   identically across every skill that includes it.
3. **Parameterize variation.** Anything that differs per skill is a `{{param}}` the recipe passes —
   never a forked copy of the brick (the golden rule). A `{{param}}` with no value from the recipe is
   a build error.
4. **Reference it** from a recipe and build:
   ```md
   <!-- recipes/fix.md -->
   <!-- include: core/run-dir | skill=fix; flags=--prefix fix -->
   ```
   ```bash
   forge build --dry-run   # preview which skills this brick edit would change
   forge build             # write them
   ```
A complete worked example ships in [`examples/forge/`](examples/forge/): the brick
`bricks/run-dir.md` (which carries its own `### Working folder` heading) is included by both
`recipes/feature.md` and `recipes/fix.md` with different parameters.

## Conformance (SKILL.md standard)
When `conformance` is on (default), `build`/`check` validate a recipe's frontmatter against the
agentskills SKILL.md standard — but only the fields that are **present** (a recipe without
frontmatter, e.g. a slash-command, is never flagged):
- `name`: lowercase `a-z`/`0-9` segments joined by single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`),
  1–64 chars — no leading/trailing or doubled `-`, no spaces/uppercase.
- `description`: present means non-empty and ≤1024 chars.
A violation is a **build error** (nothing is written, like a missing brick) and fails `check`.
Set `"conformance": false` to disable. Optional fields (`license`, `metadata`, `allowed-tools`, …)
pass through untouched. The reader is minimal (zero-dep, not a YAML parser): it validates single-line
scalars (quotes are stripped); multi-line block scalars (`|`/`>`) are not length-checked.

## EOL
Output is always LF. The two gates treat line endings differently **by design**: `build` compares
raw bytes, so a generated file that drifted to CRLF (a Windows checkout/editor) is **rewritten back
to LF** — `build` is what upholds the LF guarantee. `check` is CR-insensitive, so that same CRLF
file is **not** a false drift positive in CI. (Skip-if-unchanged still applies: a byte-identical LF
output is left untouched.) Every engine read normalizes `\r\n` **and lone `\r`** (a partially
converted CR-mac source) to LF — a stray CR converges in one build instead of producing a
permanent build/check disagreement. A `.gitattributes` with `eol=lf` for `forge/**` and the output
dir is recommended.

## Config — `forge.config.json`
Optional; every field falls back to the default below when the file is absent or a key is omitted.
```json
{
  "bricks": ".claude/forge/bricks",
  "recipes": ".claude/forge/recipes",
  "out": ".claude/commands",
  "archive": ".claude/forge/_archive",
  "deletePolicy": "soft",
  "enforceGenerated": false,
  "conformance": true
}
```
- **`bricks` / `recipes` / `out` / `archive`** — the role dirs. Must be **distinct, non-nested**
  (see Safety & boundaries).
- **`out` accepts `string | string[]`** (non-empty array of non-empty strings). With an array,
  `build` composes each recipe **once** and writes it to **every** destination (skip-if-unchanged
  is per destination); `check` fails on drift in **any** destination, naming the drifted one;
  `enforceGenerated` scans every destination; `remove`/`rename` clean the skill's output from every
  destination. Exact-duplicate entries are rejected (`duplicate "out" entry`); nested/equal entries
  are a `config error`. A malformed shape is a clean error, never a crash. A single string stays
  byte-identical to the historical behavior — `init` always scaffolds the string form.
- **`deletePolicy`** — `soft` (move to `_archive/`, recoverable) or `hard` (delete permanently).
  Fails closed: any value other than `hard` is treated as `soft`.
- **`enforceGenerated`** — when `true`, `check` requires every output file to have a recipe,
  forbidding hand-made/edited skills (a forge-only guarantee). Default `false` (incremental adoption:
  non-recipe skills are left untouched).
- **`conformance`** — when `true` (default), `build`/`check` validate a recipe's frontmatter against
  the agentskills SKILL.md standard (see Conformance). Set `false` to disable.

## JSON output (`--json`)
`forge build`/`check`/`list`/`gc`/`onboard` accept `--json`: stdout becomes **only**
`JSON.stringify(result, null, 2)` — no `✔`/`✗`/`  • ` decorated lines — for scripting/CI. The exit
code is unchanged (`0` on success, `1`/`2` on failure). Error paths are covered: an invalid
`forge.config.json` or an unknown flag on one of these five commands prints
`{ "ok": false, "error": "..." }` on stdout. A build/check result refused by a **config error**
(role overlap, missing recipes dir) still carries the **full** result shape below — every
aggregate field present and zeroed, `plan: []` on build — so a consumer never branches on a
field's absence. Lifecycle commands that mutate the tree
(`new`/`import`/`remove`/`restore`/`rename`) are **out of scope** for `--json` today; the flag is
accepted but has no effect on their output.

| Command | Result shape (`JSON.parse`-able) |
|---|---|
| `build` / `build --dry-run` | `{ ok, drift, orphans, errors, warnings, count, written, unchanged, plan, destinations }` — `plan` is `[{ name, out, status }]`, one entry per (recipe × out) pair (`status`: `"create"` \| `"change"` \| `"same"`); `out` is **always present**, even single-destination, so consumers never branch on config shape. `destinations` = number of out entries. No `msg` field. |
| `check` | `{ ok, drift, orphans, errors, warnings, count, written, unchanged, destinations }`. No `msg` field. |
| `list` | `{ ok, skills, bricks, msg }` — `skills` is `[{ skill, bricks: [name, ...] }]`; `bricks` is `[{ brick, refCount, usedBy: [skill, ...] }]`. |
| `gc` | `{ ok, orphans, pinned, suspectKeep, applied, msg }` — `orphans` is `[brick, ...]`; `pinned` is `[brick, ...]` (pinned orphans left untouched — always present, `[]` when none; additive, no pre-existing field changed); `suspectKeep` is `[brick, ...]` (sweep candidates whose `keep` field is present but malformed — warned, NOT pinned; always present, `[]` when none); `applied` is `true` only with `--apply`. |
| `onboard` (dry-run) | `{ ok, applied: false, root, entries, msg }` — `entries` is one object per scanned file with its disposition (`status`, `reason`, optional `proposal`); entries also carry internal scan fields beyond the disposition (informative, not contractual). |
| `onboard --apply` | `{ ok, applied, root, entries, backupDir, gate, enforced, factoring, warnings, msg }` — `gate` is the per-skill fidelity verdict; `factoring` is `{ factored, kept, nearDups, variants }` (present only with `--factor`); `enforced` is `true` when the run auto-enabled `enforceGenerated`. |

`errors` entries are `{ kind, skill, msg }` (`kind` ∈ `"build"` \| `"conformance"` \| `"drift"` \|
`"orphan"` \| `"config"`); `msg` is the same full text the non-json CLI prints.

`remove`'s result also carries the additive `pinned` and `suspectKeep` arrays (same semantics as
`gc`'s) — but `remove` itself remains out of `--json` scope, so they surface programmatically and
via the appended message text, not as JSON on stdout.

## Lifecycle & ownership
- `build` writes each generated file **only when its composed content changed** (skip-if-unchanged):
  an identical re-build leaves the tree clean and reports `N written, M unchanged`. `build --dry-run`
  composes and prints the plan (`+ create` / `~ change` / `= unchanged`) **without writing** — a
  preview of a recipe/brick edit before it touches disk. `check` is the read-only drift-gate.
- A brick's **owner** is decided by reference count: used by exactly one skill → owned by it;
  used by several → owned by none (never touched on removal).
- `remove` soft-deletes the recipe + the skill's exclusively-owned bricks to `archive/`.
  `restore` brings them back. `gc` archives orphan bricks (ref-count 0) — except a file whose
  basename is a repo meta doc (`README`/`CHANGELOG`/`CONTRIBUTING`/`CODE_OF_CONDUCT`/`LICENSE`, any
  case, any depth under `bricks/`), which is documentation and is never flagged or archived.
- **Pinned bricks** (`keep: true` in the brick's own frontmatter — see Frontmatter) are exempt
  from **both** sweeps, even with `--hard`:
  - `gc` never archives or deletes a pinned brick, even under `--apply --hard`. The pin is never
    silent: `N pinned brick(s) kept: a, b` is appended to the message, and the `--json` result
    gains an additive `pinned` array (existing fields and message text are unchanged when nothing
    is pinned).
  - `remove` keeps a pinned **exclusive** brick in the live tree (soft and `--hard` alike),
    reporting it as `Kept (pinned): x.` in the message; the result gains an additive `pinned`
    array. The brick then becomes a pinned *orphan*, which `gc` also keeps — coherent end to end:
    `remove --hard` of a recipe does **not** delete its pinned bricks. A **shared** brick that
    happens to be pinned is untouched by this: it is kept by the existing ref-count rule and
    listed under `Kept (shared)`, not under pinned.
- `deletePolicy: "soft" | "hard"` controls archive-vs-delete; `remove`/`gc` also take `--hard` to force
  a permanent delete for that one call.
- `init` scaffolds a project: it writes `forge.config.json` only if absent, then seeds a sample
  skill **only** when there are no recipes yet, the bricks/recipes/out roles are three distinct
  dirs, and none of the sample's targets already exist — so it is idempotent and never overwrites.
  It also installs the pre-commit hook best-effort (drift-gate + secret scan; non-fatal, never
  clobbers an existing hook, and only into the repo whose root is `root`); opt out with `--no-hooks`.
  When `install-hooks` (no `--force`) refuses to touch an existing **foreign** pre-commit and that
  hook invokes the forge **via `npx`** (either package name — the pre-rename `npx nbp-forge` is
  matched too), a non-fatal hint is appended to the refusal message pointing at the LOCAL-ONLY
  resolution pattern (see README "Pre-commit hook"): `npx --no-install` is silently ignored on
  npm ≥ 9, so an npx-calling hook can hit the registry on every commit. The refusal itself, exit
  behavior, and `--force` semantics are unchanged.
- `list` is read-only: per skill, the bricks it includes; per brick, its ref-count and consumers.
- `import <file>` onboards an existing skill **deterministically** (no LLM): it writes a recipe
  from the file's frontmatter + body verbatim, stripping a leading GENERATED banner so a re-import
  never double-banners. Name = `--name` › frontmatter `name:` › source basename; it must be a
  single filesystem-safe path segment (no separators, `..`, reserved device names, or control
  chars). When the resolved name differs from the source's own frontmatter `name:`, that field is
  rewritten to match, so the recipe never declares a name that disagrees with its own identity. It
  does **not** auto-build (an external skill may not build yet); run `forge build` next.
  A source whose frontmatter carries the `forge-role: nbp-skillforge/onboard` marker (nbp-skillforge's
  own tooling, e.g. the ephemeral onboarding skill) imports with a non-blocking **warning** —
  importing it turns a package tool into a user recipe, which is rarely intended.
- `rename <old> <new>` moves the recipe, regenerates the output under the new name, and removes the
  stale old one. When the recipe has frontmatter with a `name:` field, that field is ALWAYS
  rewritten to `<new>` — even if it never matched the old filename — scoped to the frontmatter
  block only, exactly like `import`'s rewrite (the body is never touched). A recipe with no
  frontmatter, or frontmatter with no `name:` field, is written back byte-for-byte unchanged (only
  moved) — a plain slash-command has no SKILL.md identity to rewrite. If the recipe has frontmatter
  with a `name:` field and `conformance` is enabled, the new name is pre-validated against the same
  gate `build` enforces **before anything is touched** — a non-conformant new name is refused up
  front (nothing deleted, moved, or rewritten); a recipe with no frontmatter is not gated.
- `new`/`remove`/`restore`/`rename` each run a full-project build after their own action. If that
  action itself succeeds but the follow-up build then fails (e.g. an unrelated, already-broken
  recipe elsewhere in the project), the command's message says so explicitly and the same build
  error bullets `build`/`check` print are shown — it never exits 1 with an unexplained success-shaped
  message.

## Onboarding (`forge onboard`)
Migrates an existing skill library into the forge. **Dry-run by default** — running it bare only
prints a classification of every file in the scanned root (nothing is written); `--apply` executes.
The scanned root is the configured out dir (`cfg.outs[0]`), announced in the output; `--from <dir>`
scans another folder. `--json` supported.

**Discovery & exclusion (all deterministic, no LLM):** first-level `*.md` files of the scanned
root. Every file gets an explicit disposition — nothing is silently dropped:
- `eligible` — user-authored, will be onboarded.
- `excluded-generated` — carries the GENERATED banner (old `nbp-forge` or new `nbp-skillforge`
  signature; detected AFTER frontmatter split): output files are never onboarded — edit the
  recipe instead (the banner alone decides; the recipe may even have been deleted since).
  `excluded-has-recipe` — already governed.
  `excluded-forge-role` — nbp-skillforge's own tooling (frontmatter marker).
- `skip-nested` (subfolders are v1 out of scope) · `skip-non-utf8` · `skip-symlink` (symlinked
  skills are not onboarded — mirrors the engine's symlink stance) · `skip-unreadable` (broken
  link, directory masquerading as `.md`, permissions) · `skip-include-like` (a
  directive the engine WOULD expand — a plain one outside a fence, or a bang `include!:` directive
  **anywhere**, even inside a fence — no safe verbatim path; fencing no longer proves a file is
  safe to onboard verbatim when the directive carries the bang) ·
  `skip-name-mismatch` (the frontmatter `name:` diverges from the filename — importing would mint
  a recipe under a different name than the scanned file; a proposal to align the two is included) ·
  `skip-nonconformant` (a rename is PROPOSED, never applied — renaming changes the invocation
  name) · `skip-collision` (case-fold aware; also raised when a **byte-divergent** file with the
  same name already exists in another out dir — the build would overwrite it without a snapshot;
  a byte-identical copy is allowed). Skipped originals are never touched.

**`--apply` pipeline:** (1) **snapshot** every eligible original, byte-faithful (CRLF/BOM
preserved), to `_onboard-backup-<ts>/` beside the archive dir — the first build overwrites the
originals in place, so this is the rollback; (2) verbatim `import` per skill; (3) ONE full build;
(4) **fidelity gate**: normalized round-trip diff (banner/CRLF/EOF-whitespace are the only
normalized axes) between each original and its rebuilt output — zero diff required; (5)
`onboard-report.md` inside the backup dir maps every file → disposition → gate verdict, with
rollback instructions. Re-running is a clean no-op (everything is then `excluded-*`).

**`--factor` (mechanical factoring, Fase A):** after the verbatim gate passes, factoring runs at
**two granularities**. First the section pass: byte-identical **heading sections** (a heading up
to the next heading/EOF, fence-aware, ≥3 lines, containing no `{{param}}`) shared by ≥2 skills are
extracted as `bricks/onboarded/<slug-of-heading>-<sha8-of-section>.md` (name is deterministic:
same content → same brick) and each recipe's section is swapped for the include — surrounding
blank lines stay in the recipe, so the round-trip stays byte-identical. A second **block pass**
then factors the residuals the section pass left behind, at block granularity: blocks are
blank-line-delimited AND fence-aware (a ```` ``` ````/`~~~` marker line delimits exactly like a
blank line, so a block never crosses a fence boundary); a candidate block has ≥3 lines, no
`{{param}}`, and **no include-like directive at all** — not even one only *documented* inside a
fence (extracting it into a brick would strip the fence context and trip the engine's
nested-include gate) — and must be byte-identical in ≥2 skills, or reuse a byte-identical
pre-existing `onboarded/<slug>-<sha8>` brick. The swap emits ONE directive line that keeps the
block's first-line indent: a plain `include:` outside a fence, the **bang** (`include!:`) inside
one — so duplicated content **inside code fences** (e.g. subagent prompts) factors too. The brick
stores the block verbatim (first-line indent included) and is named
`onboarded/<slug-of-the-block's-first-line>-<sha8-of-block-bytes>.md`. Same safety story at both
granularities: every touched skill is re-gated; a failure **reverts that skill to verbatim** and
drops a consumer-less brick (a known self-reverting case: trailing whitespace on a block's LAST
line — expansion trims the brick body). A squatted/unwritable brick path skips only THAT group —
other groups (including blocks inside a squatted section) still factor at their own paths.
When a group **reuses** a pre-existing byte-identical brick instead of writing a fresh one
(an idempotent re-run, or a later batch joining an earlier extraction), the summary's
`N shared brick(s) extracted` gains an appended `(M reused)` clause and the report's factoring
table marks those rows `(reused)` — both absent when everything was freshly written.
Factoring never fails the run — worst case everything stays verbatim, reported as kept.

**Near-duplicate report (report-only):** under `--factor`, block groups whose FIRST line is
byte-identical across ≥2 skills but whose bodies diverge are listed in a dedicated
`onboard-report.md` section — `## near-duplicates (report-only — candidates for a {{param}}
brick)`: the skills involved, a per-skill diff of **only the differing lines**, a mechanical
`{{param}}` suggestion (longest common prefix/suffix of the variant lines; no suggestion when a
variant lacks the line), and a note when the variants differ in line count. The scan covers ALL
blocks (including ones inside sections the section pass factored — a third skill's variant of an
already-factored section still surfaces) and the ordering is fully deterministic (groups by slug
then first line, variants by body text, skills lexicographic). **Grouping gotcha:** blocks are
blank-line-delimited, so a blank line between a heading and its body makes the block — and the
near-dup group/family — start at the **body's first line**: e.g. `### Checklist` followed by a
blank line then `- step one` groups (and names its family) by `- step one`, not the heading; to
group by the heading, keep it attached to the body (no blank line between them). **Nothing is written besides the
report** — near-identical blocks are deliberately NOT auto-parameterized (that semantic judgment
is the assisted Fase B's job, human-approved, via `forge-onboard`). The onboard summary appends
`; N near-duplicate group(s) reported (report-only — see the report)` only when N > 0 (otherwise
byte-identical to before), and `--json` gains an additive `result.factoring.nearDups` array
(`[{ slug, firstLine, skills, variants: [{ skills, lines }] }]`).

**`--variants` (materialize near-duplicates as variant families):** opt-in on top of `--factor`
(`--variants` without `--factor` is a usage error, exit 1; like `--factor` it only takes effect
together with `--apply` — the dry-run says so). Each near-duplicate group above stops being
report-only and is **materialized as a named variant family**: ONE brick **per variant** —
`bricks/onboarded/<slug-of-first-line>_NN.md` (NN zero-padded to 2 digits, ≥100 grows unpadded),
numbered in the report's deterministic variant order (by body text, code-unit) — every version
kept **verbatim**; a variant shared by N skills is one brick with N consumers. This `<base>_NN`
convention is the forge's **standard staging shape for human unification**: variant families are
a deliberately **temporary, assumed state** — the golden rule ("variation is a parameter, never a
forked copy") remains the target, and the `_NN` family is simply the governed, visible form of
"not yet unified" (Fase B collapses each family into ONE `{{param}}` brick, human-approved). Each
occurrence is swapped for an include exactly like the block pass (plain `include:` outside a
fence, `include!:` inside; first-line indent preserved) and judged by the **same byte-identical
fidelity gate** — a failing skill self-reverts to verbatim. The brick's frontmatter is advisory
(`piece:`, `variant-group:`, `summary:` — dropped at build, so the round trip only sees the
verbatim body). Families **grow across batches**: a new skill whose block is byte-identical to an
existing member reuses that member's brick (any NN — reuse requires the on-disk name to match
`<slug>_NN` in **exact case** and the body to be byte-identical, since the engine's include
case-match would reject anything else); a divergent one takes the next free NN; a single new
skill with no in-batch group is still **adopted** by an existing on-disk family (surfaced in the
report as a cross-batch join). The family namespace is the slug alone — groups whose first lines
slugify identically share one NN sequence. An **occupied `<slug>_NN` slot is never overwritten**:
a pre-existing file there (any case, any content — checked with the filesystem's own semantics,
so a case-insensitive FS counts `Deploy_01.md` as occupying `deploy_01`) makes the family
allocate the next free NN instead, and post-gate cleanup only ever removes files this run created
from scratch. Text claimed by a variant family is **never extracted by the byte-identical passes**
(section or block): a version shared by several skills becomes one family member with those
consumers — never a `<slug>-<sha8>` brick — so Fase B always sees the whole family. With
`--variants` the report's
near-duplicate header becomes `## near-duplicates (materialized as variant families — unify each
into ONE {{param}} brick in Fase B)` and each group gains a `- materialized as: <slug>_01
(skillA), …` line (without the flag the section stays byte-identical to before). `--json` gains
an additive, post-gate `result.factoring.variants` array (`[{ group, firstLine, bricks:
[{ brick, skills }] }]` — present under `--factor`, `[]` without `--variants`), and the summary
appends `; N variant group(s) materialized (M variant brick(s))` only when N > 0 (the near-dup
clause then reads `found (see the report)` — the `report-only` wording would be false once
materialized; without `--variants` it stays byte-identical to before). Same safety
story as all factoring: a write error degrades **per group** (kept verbatim, orphan writes swept),
a gate mismatch reverts only that skill, and `--variants` never fails the run.

**enforceGenerated auto-enable:** when the run ends 100% migrated (zero skips, zero gate
failures, no un-governed stray in ANY out dir) and `enforceGenerated` was off, it is flipped to
`true` automatically and announced loudly — from then on a hand-made skill in the out dir fails
`check`. In the same step, an installed `forge-onboard` tool skill (identified by its marker) is
**removed** so strict mode never sees it as an orphan — `forge onboard --install-skill` brings it
back on demand. Any skip downgrades all of this to a printed suggestion (and the tool stays).

**Assisted step (Fase B) — `forge onboard --install-skill`:** materializes the `forge-onboard`
agent skill (frontmatter marker `forge-role: nbp-skillforge/onboard`; idempotent; never
overwrites a same-named file without the marker) into the first out dir. Its logic is the
**harness-neutral** protocol shipped as `assets/onboard/ONBOARD-SPEC.md` (the Claude Code file is
a thin reference wrapper): the agent groups the similar-but-divergent sections across skills
(dedup group = 1 candidate brick + N skills; an existing `onboarded/<slug>_NN` variant family —
frontmatter `variant-group:` — is a **pre-assembled group**, its primary input), proposes one
canonical version + `{{param}}`s per group, the human approves **per group**, and every applied
group is verified by execution
(`build` + `check` + diff vs the run's backup). The engine never lets the LLM's output through
unverified — the deterministic gates stay the judge. **Sequencing note:** an `--apply` run that
ends 100% migrated **removes** an installed `forge-onboard` skill as part of the
`enforceGenerated` auto-enable (see above) — install it **after** the `--apply` run, or just
re-run `--install-skill` (idempotent) to bring it back on demand.

## Safety & boundaries
- Skill names (`new`/`rename`/`remove`/`restore`/`import`) and include paths must be a single
  filesystem-safe segment inside their root — `..`, separators, absolute paths, reserved device
  names, and control chars are rejected, so a recipe or argument can't read or delete files outside
  the configured `bricks`/`recipes` dirs. `remove` additionally realpath-checks a brick before
  deleting it.
- The `bricks`/`recipes`/`archive` roles and **every `out` entry** must be **pairwise distinct,
  non-nested** directories (checked, case-insensitive on Windows/macOS, symlink-resolved when they
  exist). With multiple out entries the error message names the offending literal path.
- **Only regular files under `bricks/` are governable.** Directory junctions/symlinks inside
  `bricks/` (and the archive) are out of governance: the lifecycle sweeps (`gc`, `remove`,
  `restore`) realpath-check every candidate, so a file reachable only THROUGH a linked directory
  is never listed (not as an orphan, not as a restore conflict) and never touched. Likewise a
  **directory** named `<brick>.md` is never a brick: lifecycle scans are file-only (stat-verified)
  and `remove`'s exclusive sweep skips a non-file target, leaving it untouched and reported in the
  Kept bucket.
- **Symlinked bricks are rejected at build.** A **symlink inside `bricks/`** whose target resolves
  outside the tree is a **build error** (`include resolves outside bricks/ (symlink?)`), not followed
  — the on-disk identity check (added with case-mismatch detection) `realpath`-resolves each brick and
  requires it to stay inside `bricks/`. (Up to 0.5.0 such a symlink was followed and its content
  inlined.) This keeps `build` deterministic and consistent with the lifecycle's `insideBricks`
  guard. Note this is a **consistency/robustness** choice, **not** a privilege boundary: nbp-skillforge
  runs with your own privileges on your own files and does not try to sandbox what you deliberately
  place in your own tree.

## The golden rule
> Variation between skills is a **parameter** the recipe passes — never a modified copy of the brick.

## Known limitations
- **Bricks cannot include other bricks** — a nested include is rejected as a **build error**, not
  silently expanded or ignored (enforced at build; see Include directive above). Not really an
  open "limitation" so much as a documented boundary of the composition model — listed here for
  discoverability alongside the others.
- A parameter value cannot contain the literal sequence `-->` — see Include directive above.
- A `{{param}}` **key** is limited to `[\w-]` (letters, digits, underscore, hyphen). A key using any
  other character (e.g. a dot in `{{my.key}}`) is never recognized as a placeholder: it is left
  **verbatim** in the output — no build error, no warning. This is a silent no-op, not a validated
  restriction, so name your params accordingly.
- `<brick-path>` is case-sensitive and must match the on-disk file exactly — see Include directive above.
- A literal `;` in a param value is supported via `\;` — see Include directive above.
- Fence masking (see Include directive above) recognizes only ```` ``` ```` / `~~~` **block**
  fences. A 4-space-**indented** code block does not mask a directive (it still expands), and an
  inline single-backtick code span never masked one either — deliberate non-goals, not planned.
- The literal token `include!:` **cannot be written in any governed file** (a recipe or a brick) —
  not even inside a code fence, since the bang form expands there too (and inside a *brick* it
  trips the nested-include gate instead). To document the bang syntax inside a governed file,
  break the token — e.g. write `include<!>:` or split it across formatting. This SPEC and the
  README are **not** governed files, which is why they can show the literal syntax.
