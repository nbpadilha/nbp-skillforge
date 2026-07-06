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
  carries the directive) — same as any HTML comment. Use a placeholder in the brick if you need one.
- `<brick-path>` is **case-sensitive** and must match the on-disk file exactly, even on a
  case-insensitive filesystem (Windows/macOS) — a mismatched case is a **build error**
  (`include path case mismatch`), not a silently-succeeding include.
- A **brick's body must not itself contain an include directive** — bricks do not include bricks
  (composition lives in the recipe). A nested include is a **build error**; inline the content into
  the brick, or include both bricks from the recipe instead. An include directive inside a *brick's
  own* frontmatter is not affected (that block is dropped entirely — see Frontmatter).
- An include directive on a line **inside a fenced code block** (```` ``` ```` or `~~~`, up to 3
  leading spaces of indentation — CommonMark basics) is **left verbatim, not expanded**, and is
  **not ref-counted** (a brick cited only inside such a fence is an orphan to `gc`) — so a
  recipe/brick can document the include syntax itself as a fenced example. An unterminated fence
  (opened, never closed) masks everything after it to the end of the file. Only block fences are
  recognized; an inline single-backtick code span (`` `<!-- include: … -->` ``) does **not** mask a
  directive — it still expands.

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
  (only a recipe's `name`/`description` are validated — see Conformance). Recommended fields:

  | field | meaning |
  |---|---|
  | `piece` | the brick's stable id (usually equals its path/filename) |
  | `summary` | one line: what this brick contributes when included |
  | `kind` | optional tag for how it's used (e.g. `step`, `checklist`, `contract`) |
  | `guarantees-not` | optional: limits the brick explicitly does **not** promise (so a recipe author doesn't assume more than it delivers) |

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
output is left untouched.) A `.gitattributes` with `eol=lf` for `forge/**` and the output dir is recommended.

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
`forge build`/`check`/`list`/`gc` accept `--json`: stdout becomes **only**
`JSON.stringify(result, null, 2)` — no `✔`/`✗`/`  • ` decorated lines — for scripting/CI. The exit
code is unchanged (`0` on success, `1`/`2` on failure). Error paths are covered: an invalid
`forge.config.json` or an unknown flag on one of these four commands prints
`{ "ok": false, "error": "..." }` on stdout. Lifecycle commands that mutate the tree
(`new`/`import`/`remove`/`restore`/`rename`) are **out of scope** for `--json` today; the flag is
accepted but has no effect on their output.

| Command | Result shape (`JSON.parse`-able) |
|---|---|
| `build` / `build --dry-run` | `{ ok, drift, orphans, errors, warnings, count, written, unchanged, plan, destinations }` — `plan` is `[{ name, out, status }]`, one entry per (recipe × out) pair (`status`: `"create"` \| `"change"` \| `"same"`); `out` is **always present**, even single-destination, so consumers never branch on config shape. `destinations` = number of out entries. No `msg` field. |
| `check` | `{ ok, drift, orphans, errors, warnings, count, written, unchanged, destinations }`. No `msg` field. |
| `list` | `{ ok, skills, bricks, msg }` — `skills` is `[{ skill, bricks: [name, ...] }]`; `bricks` is `[{ brick, refCount, usedBy: [skill, ...] }]`. |
| `gc` | `{ ok, orphans, applied, msg }` — `orphans` is `[brick, ...]`; `applied` is `true` only with `--apply`. |

`errors` entries are `{ kind, skill, msg }` (`kind` ∈ `"build"` \| `"conformance"` \| `"drift"` \|
`"orphan"` \| `"config"`); `msg` is the same full text the non-json CLI prints.

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
- `deletePolicy: "soft" | "hard"` controls archive-vs-delete; `remove`/`gc` also take `--hard` to force
  a permanent delete for that one call.
- `init` scaffolds a project: it writes `forge.config.json` only if absent, then seeds a sample
  skill **only** when there are no recipes yet, the bricks/recipes/out roles are three distinct
  dirs, and none of the sample's targets already exist — so it is idempotent and never overwrites.
  It also installs the pre-commit hook best-effort (drift-gate + secret scan; non-fatal, never
  clobbers an existing hook, and only into the repo whose root is `root`); opt out with `--no-hooks`.
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
- `excluded-generated` — carries a GENERATED banner (old `nbp-forge` or new `nbp-skillforge`
  signature; detected AFTER frontmatter split). `excluded-has-recipe` — already governed.
  `excluded-forge-role` — nbp-skillforge's own tooling (frontmatter marker).
- `skip-nested` (subfolders are v1 out of scope) · `skip-non-utf8` · `skip-include-like` (a
  directive outside a fence would be expanded by the engine — no safe verbatim path) ·
  `skip-nonconformant` (a rename is PROPOSED, never applied — renaming changes the invocation
  name) · `skip-collision` (case-fold aware). Skipped originals are never touched.

**`--apply` pipeline:** (1) **snapshot** every eligible original, byte-faithful (CRLF/BOM
preserved), to `_onboard-backup-<ts>/` beside the archive dir — the first build overwrites the
originals in place, so this is the rollback; (2) verbatim `import` per skill; (3) ONE full build;
(4) **fidelity gate**: normalized round-trip diff (banner/CRLF/EOF-whitespace are the only
normalized axes) between each original and its rebuilt output — zero diff required; (5)
`onboard-report.md` inside the backup dir maps every file → disposition → gate verdict, with
rollback instructions. Re-running is a clean no-op (everything is then `excluded-*`).

**`--factor` (mechanical factoring, Fase A):** after the verbatim gate passes, byte-identical
**heading sections** (a heading up to the next heading/EOF, fence-aware, ≥3 lines, containing no
`{{param}}`) shared by ≥2 skills are extracted as `bricks/onboarded/<slug>-<sha8>.md` (name is
deterministic: same content → same brick) and each recipe's section is swapped for the include —
surrounding blank lines stay in the recipe, so the round-trip stays byte-identical. Every touched
skill is re-gated; a failure **reverts that skill to verbatim** and drops a consumer-less brick.
Factoring never fails the run — worst case everything stays verbatim, reported as kept.
Near-identical blocks are deliberately NOT factored (that semantic judgment is the assisted
Fase B's job, human-approved).

**enforceGenerated auto-enable:** when the run ends 100% migrated (zero skips, zero gate
failures, no forge-role tool file in the out dir) and `enforceGenerated` was off, it is flipped
to `true` automatically and announced loudly — from then on a hand-made skill in the out dir
fails `check`. Any skip downgrades this to a printed suggestion.

## Safety & boundaries
- Skill names (`new`/`rename`/`remove`/`restore`/`import`) and include paths must be a single
  filesystem-safe segment inside their root — `..`, separators, absolute paths, reserved device
  names, and control chars are rejected, so a recipe or argument can't read or delete files outside
  the configured `bricks`/`recipes` dirs. `remove` additionally realpath-checks a brick before
  deleting it.
- The `bricks`/`recipes`/`archive` roles and **every `out` entry** must be **pairwise distinct,
  non-nested** directories (checked, case-insensitive on Windows/macOS, symlink-resolved when they
  exist). With multiple out entries the error message names the offending literal path.
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
