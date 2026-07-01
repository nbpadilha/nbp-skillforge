# SPEC — skill composition

## Model
A skill is a **recipe** (`recipes/<name>.md`) that points to **bricks**
(`bricks/<path>.md`). `build` resolves the pointers and emits `<out>/<name>.md`
(a standard, self-contained SKILL.md/command file with a "GENERATED" banner).

The forge only governs skills that **have a recipe**. Migration is incremental: anything
without a recipe is left untouched (and, with `enforceGenerated`, flagged as an orphan).

> `forge` below = `npx nbp-forge` (or `nbp-forge` if installed globally; `node bin/cli.mjs` from a clone).

## Include directive
```
<!-- include: <brick-path> [| k=v; k2=v2 ...] -->
```
- `<brick-path>` is relative to `bricks/`, without `.md` (can be nested: `core/run-dir`).
- Parameters after `|`, separated by `;` (a value may contain spaces).
- A value may contain a **literal `;`** by escaping it as `\;`; a literal backslash is `\\`.
  (Any other `\x` is left untouched, so Windows-style paths usually need no escaping.)
- In the brick body, `{{k}}` is replaced by the value. Missing parameter → **build error**
  (nothing is written). Missing brick → **build error**.
- A parameter value cannot contain the literal sequence `-->` (it closes the HTML comment that
  carries the directive) — same as any HTML comment. Use a placeholder in the brick if you need one.

## Frontmatter
- **Recipe:** the frontmatter (`name`, `description`, …) is passed verbatim to the generated
  file (compatible with the agentskills standard). The banner goes right after the closing `---`.
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
  chars). It does **not** auto-build (an external skill may not build yet); run `forge build` next.

## Safety & boundaries
- Skill names (`new`/`rename`/`remove`/`restore`/`import`) and include paths must be a single
  filesystem-safe segment inside their root — `..`, separators, absolute paths, reserved device
  names, and control chars are rejected, so a recipe or argument can't read or delete files outside
  the configured `bricks`/`recipes` dirs. `remove` additionally realpath-checks a brick before
  deleting it.
- The `bricks`/`recipes`/`out`/`archive` roles must be **distinct, non-nested** directories
  (checked, case-insensitive on Windows/macOS, symlink-resolved when they exist).
- **Out of scope (by design):** nbp-forge runs with your own privileges on your own files. If you
  deliberately place a **symlink inside `bricks/`** that points outside the tree, `build` will
  follow it when inlining content (a content read, not a deletion) — same as any file tool. Don't
  do that; it isn't a privilege boundary nbp-forge tries to enforce.

## The golden rule
> Variation between skills is a **parameter** the recipe passes — never a modified copy of the brick.

## Known limitations
- None currently tracked. (A literal `;` in a value is supported via `\;` — see Include directive.)
