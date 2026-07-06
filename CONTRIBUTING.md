# Contributing to nbp-skillforge

Thanks for your interest! nbp-skillforge is a small, **zero-runtime-dependency** ESM tool. The bar is: keep it tiny, deterministic, and safe with users' files.

## Dev setup
- Node **≥ 18** (uses `readdirSync(.., {recursive:true})`, `??=`). No install step — there are no runtime deps.
- Clone, then:
  ```bash
  node --test                          # run the test suite
  node bin/cli.mjs build --root examples
  node bin/cli.mjs check --root examples   # the drift-gate
  npm run hooks:install                 # optional: drift-gate + secret scan on commit
  ```

## The golden rule (this repo eats its own dog food)
Skills/commands are **generated**. Never hand-edit a file under an `out/` directory — edit the **recipe** (`recipes/<name>.md`) or the **brick** (`bricks/<path>.md`) and run `forge build`. The drift-gate (`forge check`) fails any output that diverges from its recipe, and it runs in CI.

## Making a change
1. Write or update tests in `test/` (`node:test`, zero deps). New engine/lifecycle behavior needs a test.
2. `node --test` must be green, and `node bin/cli.mjs check --root examples` must report *in sync*.
3. Update the docs **in the same change**: `README.md`, `SPEC.md`, and `CHANGELOG.md`.
4. For **load-bearing** changes (the compose/lifecycle engine, the CLI, hooks — anything that could corrupt or mis-generate a user's file), explain in the PR how you verified by **execution**, not assumption.

## Commits
[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Keep messages tight and factual.

## Scope & philosophy
- **Zero runtime dependencies** — a PR that adds one needs a strong, explicit justification.
- **Soft-delete by default** — destructive operations stay recoverable unless `hard` is requested.
- **Portable output** — generated files are standard self-contained `SKILL.md`/command files; no proprietary pointer syntax leaks into them.

## Reporting bugs / requesting features
Open an issue using the templates. For anything security-related, see [`SECURITY.md`](SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
