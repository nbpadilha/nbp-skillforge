# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Public and intentionally short.

## What this is
`nbp-forge` composes portable agent skills (`SKILL.md` / slash-command files) from reusable
**bricks**, with a **drift-gate**. A **recipe** points to bricks; `forge build` assembles the
final self-contained file; `forge check` fails if any generated file drifted from its recipe.

## The one rule that matters
**Never hand-edit generated output.** Files under the configured `out/` directory carry a
`GENERATED` banner — they are build artifacts. To change one, edit the **recipe**
(`recipes/<name>.md`) or the **brick** (`bricks/<path>.md`) it includes, then run `forge build`.
Composition lives in the recipe; bricks do not include other bricks (enforced at build) — except
inside a fenced code block (```` ``` ```` / `~~~`), where an include directive is never expanded or
enforced, so a brick can safely document the include syntax as a fenced example.

## Before you finish a change
- `node --test` is green (zero-dep `node:test` suite).
- `node bin/cli.mjs check --root examples` reports *in sync* (the drift-gate; also runs in CI).
- Docs updated in the same change: `README.md`, `SPEC.md`, `CHANGELOG.md` when behavior changes.

## Conventions
- **Zero runtime dependencies.** Adding one needs a strong, explicit reason.
- Node ≥ 18, ESM. Source in `src/` (engine + lifecycle + hooks), CLI in `bin/cli.mjs`.
- Output is **vendor-neutral** — no proprietary pointer syntax leaks into generated files.
- Destructive operations are **soft by default** (recoverable in `_archive/`).
- [Conventional Commits](https://www.conventionalcommits.org/): `feat` / `fix` / `docs` / `refactor` / `test` / `chore`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup details and [`SPEC.md`](SPEC.md) for the format.
To adopt nbp-forge in **your** project autonomously, hand an agent [`AGENTS-SETUP.md`](AGENTS-SETUP.md)
— an end-to-end setup runbook with execution gates.
