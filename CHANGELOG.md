# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/nbpadilha/nbp-forge/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/nbpadilha/nbp-forge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nbpadilha/nbp-forge/releases/tag/v0.1.0
