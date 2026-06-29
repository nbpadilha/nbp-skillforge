# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/nbpadilha/nbp-forge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nbpadilha/nbp-forge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nbpadilha/nbp-forge/releases/tag/v0.1.0
