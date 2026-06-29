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
- In the brick body, `{{k}}` is replaced by the value. Missing parameter → **build error**
  (nothing is written). Missing brick → **build error**.

## Frontmatter
- **Recipe:** the frontmatter (`name`, `description`, …) is passed verbatim to the generated
  file (compatible with the agentskills standard). The banner goes right after the closing `---`.
- **Brick:** its own frontmatter (`piece`, `summary`, `guarantees-not` recommended) is
  **dropped** on expansion — only the body is inlined.

## EOL
Output is always LF. `check` is CR-insensitive (no false positives from CRLF on Windows).
A `.gitattributes` with `eol=lf` for `forge/**` and the output dir is recommended.

## Lifecycle & ownership
- A brick's **owner** is decided by reference count: used by exactly one skill → owned by it;
  used by several → owned by none (never touched on removal).
- `remove` soft-deletes the recipe + the skill's exclusively-owned bricks to `archive/`.
  `restore` brings them back. `gc` archives orphan bricks (ref-count 0).
- `deletePolicy: "soft" | "hard"` controls archive-vs-delete.

## The golden rule
> Variation between skills is a **parameter** the recipe passes — never a modified copy of the brick.

## Known limitations
- The parameter parser splits on `;`; a value containing a literal `;` would be truncated.
  (TODO: quoting/escaping if a real case appears.)
