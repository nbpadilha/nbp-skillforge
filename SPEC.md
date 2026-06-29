# SPEC — skill composition

## Model
A skill is a **recipe** (`recipes/<name>.md`) that points to **bricks**
(`bricks/<path>.md`). `build` resolves the pointers and emits `<out>/<name>.md`
(a standard, self-contained SKILL.md/command file with a "GENERATED" banner).

The forge only governs skills that **have a recipe**. Migration is incremental: anything
without a recipe is left untouched (and, with `enforceGenerated`, flagged as an orphan).

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

## Frontmatter
- **Recipe:** the frontmatter (`name`, `description`, …) is passed verbatim to the generated
  file (compatible with the agentskills standard). The banner goes right after the closing `---`.
- **Brick:** its own frontmatter (`piece`, `summary`, `guarantees-not` recommended) is
  **dropped** on expansion — only the body is inlined.

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
Output is always LF. `check` is CR-insensitive (no false positives from CRLF on Windows).
A `.gitattributes` with `eol=lf` for `forge/**` and the output dir is recommended.

## Lifecycle & ownership
- A brick's **owner** is decided by reference count: used by exactly one skill → owned by it;
  used by several → owned by none (never touched on removal).
- `remove` soft-deletes the recipe + the skill's exclusively-owned bricks to `archive/`.
  `restore` brings them back. `gc` archives orphan bricks (ref-count 0).
- `deletePolicy: "soft" | "hard"` controls archive-vs-delete.
- `init` scaffolds a project: it writes `forge.config.json` only if absent, then seeds a sample
  skill **only** when there are no recipes yet, the bricks/recipes/out roles are three distinct
  dirs, and none of the sample's targets already exist — so it is idempotent and never overwrites.
- `list` is read-only: per skill, the bricks it includes; per brick, its ref-count and consumers.
- `import <file>` onboards an existing skill **deterministically** (no LLM): it writes a recipe
  from the file's frontmatter + body verbatim, stripping a leading GENERATED banner so a re-import
  never double-banners. Name = `--name` › frontmatter `name:` › source basename; it must be a
  single filesystem-safe path segment (no separators, `..`, reserved device names, or control
  chars). It does **not** auto-build (an external skill may not build yet); run `forge build` next.

## The golden rule
> Variation between skills is a **parameter** the recipe passes — never a modified copy of the brick.

## Known limitations
- None currently tracked. (A literal `;` in a value is supported via `\;` — see Include directive.)
