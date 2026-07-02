# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Breaking (behavior change):** a **symlinked brick** whose target resolves **outside `bricks/`** is
  now a **build error** (`include resolves outside bricks/ (symlink?)`) instead of being silently
  followed and inlined (the pre-0.5.0 behavior). The on-disk identity check that detects a case
  mismatch also distinguishes a symlink-escape from a real case mismatch, so the message is accurate
  for each. SPEC's "out of scope" note updated to match.
- `--json` now stays machine-readable on error paths too: an invalid `forge.config.json` or an
  unknown flag on `build`/`check`/`list`/`gc` prints `{ "ok": false, "error": "..." }` on stdout
  (nothing decorated on stderr), instead of a `✗`-prefixed stderr line a JSON consumer couldn't parse.
- `build`/`build --dry-run` on a blocking error now say "build aborted (see errors below)." — the
  error bullets print after the summary, not "above" it.
- `check` on an output that was never built now says `` is missing (run `npx nbp-forge build`) ``
  instead of the misleading `is out of sync with its recipe`.
- `check`'s drift message now points at the **first diverging line** (`(first difference at line
  N: expected "...", found "...")`, each side truncated to 60 chars) instead of a bare "is out of
  sync with its recipe" — a CI failure now shows what changed without a manual diff. Symmetric for
  a hand-edit that added a trailing line (`found "..."` past the recipe's end) or removed one
  (`found end-of-file`); computed on the same CRLF-normalized text the drift check already uses, so
  a CRLF checkout still isn't a false positive. The "missing" case (above) is unaffected.
- `no recipes directory` errors (`build`/`check`/`list`) now suggest `npx nbp-forge init` — a fresh
  clone's first command no longer dies with an unexplained path.
- README's "See it in 60 seconds" demo now quotes the real `build`/`check` CLI output
  (`N written, M unchanged`, not the retired `N file(s) generated.`).
- **Breaking (bug fix):** a brick body containing an `<!-- include: ... -->` directive is now a
  **build error** ("bricks must not include bricks"), instead of leaking the raw directive verbatim
  into the generated file with no error — and silently confusing `gc`'s ref-count (the "included"
  brick was invisible to ref-counting, so `gc --apply` could archive a brick still referenced,
  unexpanded, inside another brick).
- **Breaking (bug fix):** an include whose case doesn't match the on-disk brick file exactly is now
  a **build error** (`include path case mismatch`), instead of silently succeeding on a
  case-insensitive filesystem (Windows/macOS) while `gc`/`remove`/`list` ref-count it under a
  different case, which could archive/delete a brick a live recipe still uses.
- **Breaking (bug fix):** an include directive on a line inside a fenced code block (```` ``` ````
  or `~~~`) is no longer expanded — it's left verbatim, so a recipe/brick can finally document the
  include syntax as a fenced example. `gc`/`remove`/`list`'s ref-count (and the F-01 nested-include
  gate) now consult the same fence mask, so a brick cited only inside a fence is correctly an
  orphan, and a brick whose OWN fenced example shows the include syntax no longer trips the
  nested-include build error. Only block fences are recognized (up to 3 spaces indent, CommonMark
  basics); an inline single-backtick code span and 4-space-indented code blocks do NOT mask a
  directive — deliberate non-goals.
- An **empty frontmatter block** (`---\n---\n`, no fields) is now recognized as present-but-empty:
  the banner is emitted right after the closing `---` with no extra blank line. Previously it was
  treated as no-frontmatter-at-all and the banner was pushed above both dashes, leaving the inert
  `---`/`---` lines in the body. Fixed in `build` and in `forge import`'s recipe round-trip.
- **Breaking (bug fix):** ref-counting (`gc`/`remove`/`list`) now only scans a recipe's **body** for
  include directives, matching what `build` actually expands. An include directive placed inside a
  recipe's own frontmatter previously protected a brick from `gc` (a false "in use") while the
  directive itself leaked verbatim into the generated frontmatter block, unexpanded.
- `forge new`/`remove`/`restore`/`rename` no longer swallow the follow-up build's errors. When the
  action itself (write/move/delete) succeeds but the project-wide rebuild that follows then fails
  (e.g. an unrelated, already-broken recipe), the command now prints the real cause — the same error
  bullets `build`/`check` already show — instead of a bare `✗ <success-shaped message>` with no
  explanation. The composed message distinguishes "the action itself succeeded, but the follow-up
  build failed" from a genuine action failure (a bad name, a not-found skill, a conflict, …), which
  still fails with its own unchanged message and never runs the follow-up build.
- `forge rename` now pre-validates the new name against the same conformance gate `build` enforces
  **before touching disk**, when the recipe has frontmatter with a `name:` field. Renaming to a
  non-conformant name (e.g. uppercase) previously deleted the old generated command and moved the
  recipe, only for the follow-up build to then refuse to generate the new one — leaving `out/`
  empty and a misleading "old command removed, new one generated" message on an exit-1 run. It now
  refuses up front (`rename blocked: "<name>" is not a conformant skill name …`) with **nothing**
  touched; a recipe with no frontmatter (e.g. a plain slash-command) is unaffected.
- `forge import --name <n>` (or an imported source whose frontmatter `name:` differs from the final
  skill name once `--name`/frontmatter/basename precedence is applied) now rewrites the recipe's own
  `name:` field to match. Previously the recipe/generated output would publish a `name:` that
  disagreed with its own file identity — invisible to the conformance gate, which never compares the
  fm value to the filename.
- `forge remove`/`gc --apply` (soft **and** `--hard`) of a nested brick (e.g. `core/sub/deep.md`) no
  longer leaves the now-empty parent directories (`core/`, `core/sub/`) behind under `bricks/`; a
  sibling brick under the same parent still keeps its dir. Cosmetic only (`check`/`list`/`build`
  already ignored the leftover empty dirs) — fixed for filesystem tidiness.
- **Data loss:** a recipe/brick whose frontmatter block is genuinely empty (`---\n---\n`) AND whose
  body's very first line also starts with `---` (e.g. `---\n---literal body line\n`) no longer has
  that leading `---` silently eaten. The frontmatter-splitter's closing-fence pattern required only
  an *optional* newline before the body, so `---literal…` on the closing fence's own line was
  wrongly treated as the closer, swallowing the body's own `---`. The closer must now be followed by
  a real newline or end-of-input; a text shaped like this now correctly has **no** recognized
  frontmatter at all (not an empty one) and round-trips byte-for-byte. The genuine empty-fm case
  (`---\n---\n#x`, banner directly after the second `---`, no blank line) is unaffected.
- An include directive on a line inside a fenced code block could still be wrongly **expanded** if a
  later line merely started with a fence run followed by more text on the same line (e.g.
  ` ````not-a-close`, 4+ backticks immediately followed by text) — that line was treated as closing
  the fence early, unmasking an include still visually inside the block. A closing fence now must
  have nothing but the fence run (+ optional trailing whitespace) on its line, matching CommonMark.
- `forge rename` now rewrites the frontmatter `name:` field **scoped to the frontmatter block only**,
  using the recipe's *actual* fm `name:` value — never the whole raw file. Previously the rewrite
  searched the whole file for a line matching `name: <old-filename>`, which had two bugs: (a) a
  recipe with **no frontmatter at all**, whose *body* happened to contain a `name: <old>`-shaped line
  (e.g. inside a fenced YAML example), had that body line silently corrupted; (b) a recipe whose fm
  `name:` value already **diverged from its filename** (e.g. never matched `<old>` in the first
  place) kept a stale name after rename, since the old-filename-based search never matched it.
  **Behavior change:** `rename` now *always* rewrites fm `name:` to the new name whenever the recipe
  has one — even if it never matched the old filename — consistent with `import`'s "the recipe must
  never disagree with its own identity" rule; a no-frontmatter recipe (or fm with no `name:` field)
  is now written back **byte-for-byte unchanged** (only moved).
- `forge init`'s pre-seed check (are `bricks`/`recipes`/`out` three genuinely distinct dirs?) now
  case-folds on a case-insensitive filesystem (Windows/macOS) the same way `build`'s role-overlap
  check already does — a case-only collision (e.g. `bricks: "foo"` vs `out: "FOO"`) is caught
  consistently instead of only when realpath happens to resolve it for free.
- Two path-containment edge cases at a filesystem/drive root (`C:\` on Windows, `/` on POSIX): a
  child path directly under a drive root was wrongly rejected as "not inside" it (missing
  double-separator guard), and the include on-disk case-match check could drop the first character
  of the relative path it computed when the bricks dir itself was a drive root. Neither is reachable
  in a normal project layout; fixed for robustness.
- `forge new`/`remove`/`restore`/`rename` now surface the follow-up build's non-blocking **warnings**
  (e.g. an unused include param) on their own result, the same way they already surface its errors —
  previously a warning from the rebuild triggered by these commands was silently dropped.

### Added
- `--json` flag for `build`/`check`/`list`/`gc`: prints **only**
  `JSON.stringify(result, null, 2)` to stdout — no decorated `✔`/`✗`/`  • ` lines — for
  scripting/CI. Exit code is unchanged. Mutating lifecycle commands
  (`new`/`import`/`remove`/`restore`/`rename`) are out of scope (the flag is accepted, has no
  effect). README documents the result shape per command.
- `forge new <skill> --description "<text>"` — fill the scaffold's `description:` at creation time
  (default is still `TODO`).
- An include param passed by the recipe but never referenced by any `{{k}}` in the brick now prints
  a non-blocking `warning: [<skill>] include <brick>: unused param(s): <k1>, <k2>` — `build`/`check`
  still succeed and the file is still written; catches a typo'd param key.

### Changed
- CI (`ci.yml`) now runs the test suite and drift-gate on `ubuntu-latest` **and**
  `windows-latest` for every supported Node version, plus `macos-latest` on Node 22. Previously
  Ubuntu was the only OS exercised, so the Windows/macOS-specific code paths (role-dir case-folding
  in `src/compose.mjs`, backslash normalization in `src/lifecycle.mjs`'s `mdFiles()`) — and the
  case-insensitive-filesystem regression test they enable — never actually ran in CI.
- Internal refactor, no CLI-visible change (this project has no public programmatic API):
  `run()`'s `errors` array now holds structured `{ kind, skill, msg }` objects instead of bare
  prefixed strings — a new error category no longer has to remember an exact `"foo:"` prefix to be
  classified as blocking. Path canonicalization (realpath + resolve()-fallback, with a case-fold
  variant) is unified into a new `src/paths.mjs` (`canon`/`canonFold`/`isInside`), replacing three
  near-duplicate hand-rolled closures. `create`/`remove`/`restore`/`rename` (and `init`'s
  conditional sample build) now also return a `command: { ok, msg }` field alongside `build`,
  separating the lifecycle action's own result from the full-project rebuild that follows it.

### Removed
- `src/check.mjs` — a dead re-export with zero consumers (the CLI calls `run()` from
  `src/compose.mjs` directly). CLI-only tool, no programmatic API, so nothing depended on it.

### Docs
- SPEC's **Known limitations** section replaced the stale "None currently tracked" with the real
  list: nested includes are rejected as a build error (a rule, cross-referenced from the Include
  directive section); a param value can't contain `-->`; a `{{param}}` key outside `[\w-]` (e.g. a
  dot) is silently left unexpanded — no build error, no warning; and an include path is
  case-sensitive and must match the on-disk brick exactly. (The fenced-code-block item that was
  briefly listed here is now fixed — see the fence-masking entry above — and removed from Known
  limitations.) AGENTS.md's "bricks do not include other bricks" now says "(enforced at build)". A
  regression test locks the `{{param}}` charset silent-no-op behavior (`test/compose.test.mjs`) so
  this can't drift from the doc again.
- `docs/architecture.html`'s "Safe lifecycle" table now lists all 11 current commands (was 5):
  `init`, `build`/`--dry-run`, `check`, `list`, `new`, `import`, `rename`, `remove`, `restore`,
  `gc`, `install-hooks` — plus a mention of skip-if-unchanged and the pre-commit hook. README now
  links it (previously orphaned, referenced by no tracked file).

## [0.5.0] - 2026-07-01

### Added
- **`AGENTS-SETUP.md`** — an autonomous end-to-end setup runbook (master prompt) for an AI agent to
  adopt nbp-forge in a project: install → init → configure → author/import → build → drift-gate →
  hooks/CI, with a verify-by-execution gate after each step, embedded anti-destruction guards, and an
  explicit done-criteria checklist. Linked from the README and `AGENTS.md`.
- `forge build --dry-run` — composes every skill and prints a per-skill plan
  (`+ create` / `~ change` / `= unchanged`) **without writing anything**, so you can preview a
  recipe/brick edit's blast radius before it touches the tree. A blocking build error still fails.

### Changed
- `build` is now **skip-if-unchanged**: a file is rewritten only when its composed content actually
  differs. An identical re-build leaves the working tree clean (no mtime churn) and `written` is an
  honest count. Build reports `N written, M unchanged`. `run()` returns `{ written, unchanged, plan }`.
- **`init` now installs the pre-commit hook** (drift-gate + secret scan) so a fresh npm consumer gets
  it in one step instead of a separate `install-hooks` call. Best-effort by design: it never fails
  `init` and never clobbers an existing hook (a foreign or non-git case is just reported); opt out with
  `init --no-hooks`. `installHooks()` is now idempotent — an identical shim already in place is left
  untouched (no mtime churn), mirroring `build`'s skip-if-unchanged, and reports `already: true`.

### Fixed
- **Generated banner** now points at a command that actually exists: `run \`npx nbp-forge build\``
  (was `run \`forge build\``, which only works if the bin is on `PATH`/globally linked). The banner is
  the first line of every generated skill and its core instruction — it must be copy-pasteable from a
  plain `devDependency` install.
- **`gc` no longer flags repo meta / community-health docs under `bricks/` as orphans.** A file whose
  basename is `README`, `CHANGELOG`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, or `LICENSE`/`LICENCE` (any
  case, any depth) is documentation, never a brick — so `gc`/`gc --apply` never reports or archives it.
  The set is kept deliberately tight: ambiguous names that are plausible brick *content* (`SECURITY`,
  `NOTICE`, `AUTHORS`, `FUNDING`, …) are **not** reserved, so a genuinely-unused `security.md` is still
  detected. Regression tests cover nested/lowercase docs and prove content-named bricks aren't
  over-reserved.
- **`--help` / `--version` now win over an unknown flag.** `nbp-forge --help --bogus` prints help and
  exits 0 (was exit 2 "unknown option"); an unknown flag still fails when help/version isn't requested.
- **Invalid `forge.config.json` fails cleanly.** `loadConfig` now throws a user-facing
  `forge.config.json: invalid JSON (…)` (surfaced by the CLI as `✗ …`, exit 1) instead of dumping a raw
  `SyntaxError` + stack trace.

### Docs
- README gained a **60-second demo** quickstart section.
- Doc-drift swept and fixed: README lifecycle table now shows `remove`/`gc` `--hard` and `new`'s
  auto-build and a `forge` = `npx nbp-forge` shorthand note; SPEC documents the `gc` doc-reservation,
  the `init` hook install + `--no-hooks`, the `-->`-in-param limit, and the same shorthand note;
  `AGENTS-SETUP.md` replaces an invalid `<<out>>/**` gitattributes placeholder with concrete paths.
- SPEC gains an **Authoring a brick** walkthrough (create → own-your-heading → parameterize →
  reference) plus a **brick-frontmatter mini-schema** (`piece`/`summary`/`kind`/`guarantees-not` —
  advisory, dropped on expansion, never validated). Documents the heading convention (a brick owns
  its heading; the body is inlined verbatim/trimmed, recipes don't wrap it) and that bricks have no
  command (drop a `.md`, include it, ref-count tracks consumers). README points authors to it; the
  `examples/forge/run-dir.md` brick now demonstrates the full frontmatter as a live reference.

## [0.4.0] - 2026-06-29
Security & robustness hardening from a 4-reviewer adversarial gate (opus + sonnet + codex/gpt-5.5 + agy).

### Security
- Lifecycle commands (`new`/`rename`/`remove`/`restore`/`import`) now reject unsafe skill names —
  path traversal (`..`/separators), Windows-reserved & device names, control chars. Previously only
  `import` validated, so e.g. `forge remove ../x --hard` could delete a file outside the project.
- `deletePolicy` is **fail-closed**: only an explicit `--hard` or `deletePolicy: "hard"` deletes; any
  other/unknown value is treated as `soft`, so a typo can't silently destroy files.
- An `include` directive that escapes the bricks dir (`../`, absolute path) is now a build error;
  include paths are canonicalized (`core\run`, `sub/../foo`) so ref-counting can't be fooled into
  deleting a used brick. `remove` realpath-checks a brick before deleting it.
- The `bricks`/`recipes`/`out`/`archive` roles must be **distinct, non-nested** dirs (would
  otherwise let `build`/`gc` clobber source) — checked case-insensitively on Windows/macOS and
  symlink-resolved when the dirs exist.
- Pre-commit secret scan also flags GitHub fine-grained PATs (`github_pat_`) and hyphenated OpenAI
  keys (`sk-proj-`/`sk-ant-`/…).

### Fixed
- **Windows nested bricks**: backslash vs forward-slash paths mis-counted ref-counts, so `gc`/`remove`
  could archive/delete a brick still in use — separators are now normalized.
- `install-hooks` runs the hook via `sh`, so it works even when the hook file lacks the execute bit.
- `rename` escapes regex metacharacters in the old name and updates a quoted `name:` value.
- `remove` refuses to clobber an existing archive entry; `gc` versions a same-named orphan archive target.
- CLI rejects missing option values, unknown flags, and missing required positional args (no more `undefined.md`).

### Changed
- `engines` is now `>=18.17.0` (the true floor for recursive `readdirSync` / `realpathSync.native`);
  CI exercises 18.17.
- Docs: SETUP uses `npx nbp-forge`; `--help`/usage shows the real `nbp-forge` binary name.

## [0.3.1] - 2026-06-29

### Added
- `forge --version` / `-v` — print the installed version.

### Changed
- CI now runs the suite on Node 18, 20, and 22 (18 = the declared `engines` minimum).

## [0.3.0] - 2026-06-29

### Added
- **`forge install-hooks`**: install the pre-commit hook from the CLI — so it works for projects
  that depend on nbp-forge, not only from a clone. The installed shim delegates to the versioned
  hook **bundled with the package** (resolves the same from a clone or from `node_modules`),
  hardened against path-based shell injection and never crashing on filesystem errors.
- **`AGENTS.md`**: short, public guidance for agents/contributors (distinct from internal notes).

### Changed
- The published package now ships `scripts/` and `examples/`, so the pre-commit hook and the
  example CI workflow / Claude Code guard are available to consumers (not clone-only).

## [0.2.0] - 2026-06-29

### Added
- **Conformance gate**: `build`/`check` validate a recipe's frontmatter against the agentskills
  SKILL.md standard (`name` lowercase-hyphen ≤64; non-empty `description` ≤1024) — a non-standard
  skill fails here, not on the agent platform. On by default; `"conformance": false` to disable.
- **`forge import <file>`**: onboard an existing `SKILL.md`/command as a recipe (verbatim; strips a
  prior `GENERATED` banner so re-import never double-banners). `--name` / `--force`.
- **`forge init`**: scaffold `forge.config.json` + dirs + a sample skill (idempotent; never overwrites).
- **`forge list`**: per skill → bricks; per brick → ref-count + consumers (blast radius).
- **`forge --help` / `forge help <cmd>`**: usage overview and per-command detail.
- **Pre-commit hook**: `npm run hooks:install` writes a thin shim delegating to the versioned
  `scripts/hooks/pre-commit` — drift-gate + basic secret scan (env files, token-shaped strings).
  Respects `core.hooksPath`.
- A param value may contain a literal `;` via the backslash escape `\;` (and a literal `\` via `\\`).
- Examples to copy into your repo: a CI workflow (`examples/.github/workflows/forge-check.yml`) and
  an optional Claude Code guard hook (`examples/claude-code/`) that blocks editing generated files.
- OSS meta: `CONTRIBUTING.md`, this changelog, and `.github/` issue/PR templates.

### Changed
- Documented that nbp-forge is **CLI-only** (no programmatic API / no shipped TypeScript types).

## [0.1.0] - 2026-06-29
First public release (npm).

### Added
- **Composition engine** (`forge build`): recipes point to reusable **bricks** via
  `<!-- include: <brick> | k=v; k2=v2 -->`; output is a standard, self-contained
  `SKILL.md`/command file carrying a `GENERATED` banner.
- **Parameters & substitution**: `{{var}}` in a brick is replaced by the recipe's value;
  a missing brick or missing parameter is a **build error** (nothing is written).
- **Drift-gate** (`forge check`): fails if any generated file was hand-edited or diverged from
  its recipe; CR-insensitive (no false positives from CRLF). `enforceGenerated` flags orphan
  outputs that have no recipe.
- **Lifecycle**: `forge new`, `rename`, `remove` (ref-counted **soft-delete** of the recipe and
  the bricks a skill exclusively owns; shared bricks are kept), `restore`, and `gc` (orphan bricks).
- **Test suite** (`node --test`, zero deps) covering the engine, lifecycle, and ref-counting.
- Documentation: `README.md`, `SPEC.md`, `SETUP.md`, `SECURITY.md`, and a runnable [`examples/`](examples/) project.

[Unreleased]: https://github.com/nbpadilha/nbp-forge/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/nbpadilha/nbp-forge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nbpadilha/nbp-forge/releases/tag/v0.1.0
