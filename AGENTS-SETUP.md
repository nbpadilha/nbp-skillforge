# AGENTS-SETUP.md — autonomous end-to-end setup runbook

A **master prompt** for an AI agent to adopt `nbp-forge` in a project end-to-end, with **no human
in the loop**. Hand an agent this file (or paste the [Master prompt](#master-prompt) block) and it
can install, scaffold, author, build, gate, and verify — stopping only if a gate fails.

> This is the *adopt-it-in-your-project* runbook. For *contributing to this repo*, see
> [`AGENTS.md`](AGENTS.md); for the format, [`SPEC.md`](SPEC.md); for the #1 pitfall, [`SETUP.md`](SETUP.md).

`forge` below = `npx nbp-forge` (or `nbp-forge` if installed globally; `node bin/cli.mjs` from a clone
of this repo).

---

## Operating rules (non-negotiable — read first)
These hold for **every** step. They are the guards that make autonomy safe.

1. **Never hand-edit generated output.** Files under the configured `out/` dir carry a `GENERATED`
   banner — they are build artifacts. To change one, edit the **recipe** or **brick** and `forge build`.
2. **Verify by execution, not assumption.** After any change run the gate (`forge check`) and, in a
   clone, `node --test`. A green deterministic gate outranks any belief that "it should work".
3. **Inspect before you overwrite or delete.** Never clobber a file you haven't read. If a file's
   content contradicts what you expected, **stop and surface it** instead of proceeding.
4. **Soft-delete by default.** `remove`/`gc` archive to `_archive/` (recoverable). Use `--hard` only
   when explicitly intended. Before any mass operation, ensure the tree is committed (a backup).
5. **Idempotent steps only.** Every command below is safe to re-run; if a step already holds, it is a
   no-op. Re-running the whole runbook must not corrupt an existing setup.
6. **Pin and cool-down dependencies.** Install an exact version (`--save-exact`), never `latest`. Do
   not delete lockfiles. Prefer `npm ci` in CI.

---

## Preconditions (gate 0)
Run these; do not proceed until all pass.

```bash
node -v                 # must be >= 18 (engine uses readdirSync recursive, ??=)
git rev-parse --is-inside-work-tree   # must print "true" — a git repo (the gate guards commits)
git status --porcelain  # prefer a clean tree before you start (so every later diff is yours)
```
If not a git repo: `git init` first (the drift-gate and pre-commit hook need it). If the tree is
dirty, commit or stash existing work so the setup's diff is reviewable in isolation.

---

## The setup sequence
Each step is **Do** then **Verify**. A failed Verify halts the run — diagnose, fix, re-run the step.

### 1 — Install (pinned)
**Do:** add nbp-forge as a dev dependency at an exact version (look up the latest stable that is at
least a few days old; substitute below):
```bash
npm i -D nbp-forge@<X.Y.Z> --save-exact
```
(Or use `npx nbp-forge@<X.Y.Z> <cmd>` with no install.)
**Verify:**
```bash
npx nbp-forge --version    # prints "nbp-forge <X.Y.Z>"
```

### 2 — Scaffold (idempotent)
**Do:**
```bash
forge init
```
This writes `forge.config.json` only if absent, then seeds a sample skill **only** when there are no
recipes yet and the role dirs are distinct and unused — so it never overwrites. It also installs the
pre-commit hook best-effort (skip with `forge init --no-hooks`; it never fails init or clobbers an
existing hook). In a git repo, step 6 below is already done for you.
**Verify:** `forge.config.json` exists and the `bricks` / `recipes` / `out` / `archive` dirs were created.

### 3 — Configure paths
**Do:** open `forge.config.json` and point the roles at this project's convention. Defaults:
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
- Set `out` to where your agent platform reads skills (e.g. `.claude/commands`, `.codex/…`).
- The four roles **must be distinct, non-nested** dirs (the engine rejects overlap — build/gc would
  clobber source).
- Keep `conformance: true` (validates `name`/`description` against the SKILL.md standard).
- Consider `enforceGenerated: true` later, once every output has a recipe (forbids hand-made skills).
- Recommended: a `.gitattributes` line `<<out>>/** eol=lf` and `forge/** eol=lf` (output is LF;
  `build` heals CRLF→LF, `check` tolerates CRLF, but pinning EOL avoids noise).
**Verify:** `forge check` runs without a `config error:` about nested/equal roles.

### 4 — Author or onboard skills
Two paths; use either or both.

**4a — Onboard existing skills (deterministic, no LLM guesswork):** for each skill file you already
have, run:
```bash
forge import path/to/existing-skill.md      # writes a recipe verbatim; strips a prior GENERATED banner
```
Then `forge build` (import does not auto-build).

**4b — Factor out duplication into bricks:** find a step copy-pasted across several skills (a run-folder
setup, a closing checklist, a result contract). Extract it once, parameterize the variation:
- Create the brick: drop `bricks/<path>.md`; its **body** is what gets inlined. The brick **owns its
  own heading** — start the body with the heading you want in the output; recipes must not wrap it.
- Put per-skill variation behind `{{params}}`, never a forked copy (the golden rule).
- Reference it from each recipe: `<!-- include: <path> | k=v; k2=v2 -->`.

See [SPEC.md → Authoring a brick](SPEC.md#authoring-a-brick) for the full walkthrough.
**Verify (preview before writing):**
```bash
forge build --dry-run    # shows + create / ~ change / = unchanged per skill, writes NOTHING
```
Confirm the plan matches your intent before the real build.

### 5 — Build
**Do:**
```bash
forge build              # writes only files whose content changed (skip-if-unchanged)
```
**Verify:** reports `N written, M unchanged` and exits 0. A blocking error (missing brick/param,
non-conformant name) writes nothing — fix the recipe/brick and re-run.

### 6 — Gate (the whole point)
**Do:**
```bash
forge check              # drift-gate: exit 1 if any output diverged from its recipe
forge list               # review each skill → its bricks, and per-brick ref-count (blast radius)
```
**Verify:** `check` prints `N in sync` (exit 0). If it reports drift, a generated file was hand-edited
or a recipe changed without a rebuild — **edit the recipe/brick, never the output**, then `forge build`.

### 7 — Wire the gate into the workflow
**Do:** `forge init` (step 2) already installed the pre-commit hook. If you ran `--no-hooks`, or this
isn't the dir you `init`ed, install it explicitly:
```bash
forge install-hooks      # pre-commit: drift-gate + a basic secret scan (thin shim, logic is versioned)
```
Add CI that runs the gate on every push — copy
[`examples/.github/workflows/forge-check.yml`](examples/.github/workflows/forge-check.yml) and adjust
the install/run lines to this project.
**Verify:** make a deliberate hand-edit to a generated file, `git add` it, and confirm the commit is
**blocked**; then revert. Confirm CI runs `nbp-forge check`.

### 8 — Redirect agent instructions (close the #1 pitfall)
**Do:** grep this project's `CLAUDE.md` / `AGENTS.md` / `README` for instructions that tell an agent to
"edit the skill at `<out>/<name>.md`" (or `.codex/…`, `.cursor/…`). Rewrite each to point at the
**recipe** instead. This is the most common adoption failure: an agent edits the generated file and
the gate blocks it.
**Verify:** no remaining doc instructs editing a file under `out/`; the banner in each generated file
already says "do not edit here — edit the recipe/brick and run `forge build`".

---

## Done criteria (the run is complete when ALL hold)
- [ ] `npx nbp-forge --version` prints the pinned version.
- [ ] `forge check` exits 0 (`N in sync`), with `N` = number of recipes.
- [ ] `forge list` shows every intended skill mapping to its bricks; no unexpected orphan bricks.
- [ ] The pre-commit hook blocks a hand-edit of a generated file (verified, then reverted).
- [ ] CI runs the drift-gate on push.
- [ ] No doc tells an agent (or human) to edit a file under `out/`.
- [ ] In a clone: `node --test` is green.

If any box is unchecked, the setup is **not** done — report which gate failed and stop.

---

## Failure handling
- **`config error: '<role>' must not be inside or equal to '<role>'`** — two role dirs overlap; fix
  `forge.config.json` so `bricks`/`recipes`/`out`/`archive` are four distinct, non-nested dirs.
- **`build error: include of missing brick: <path>`** — a recipe includes a brick that doesn't exist;
  create `bricks/<path>.md` or fix the include path (relative to `bricks/`, no `.md`, no `..`).
- **`build error: brick <p> requires {{k}}, not provided`** — add `k=…` to the include's params.
- **`conformance: [skill] name …`** — the recipe's `name` isn't a lowercase-hyphen segment ≤64 chars; fix it.
- **`drift: <out>/<name>.md is out of sync`** — output was hand-edited or a recipe changed without a
  rebuild. **Do not edit the output.** Edit the recipe/brick, `forge build`, re-check.
- **Accidental removal** — `forge restore <skill>` brings back a soft-deleted skill and its owned
  bricks from `_archive/`; or recover from git.

---

## Master prompt
Paste this to an agent to run the whole thing autonomously:

> You are setting up `nbp-forge` in this repository end-to-end and autonomously. Follow
> `AGENTS-SETUP.md` exactly. Obey its Operating rules at every step: never hand-edit a generated file
> under the configured `out/` dir (edit the recipe/brick and run `forge build`); verify every step by
> **executing** the stated Verify command, not by assumption; inspect any file before overwriting or
> deleting it; deletes are soft (archive) unless explicitly told otherwise; every step must be
> idempotent. Work through the setup sequence (steps 1–8), running each Verify gate before moving on.
> If a gate fails, stop, diagnose against the command's actual output, fix the recipe/brick (never the
> output), and re-run that step. When finished, report the Done-criteria checklist with each box
> checked and the exact `forge check` / `forge list` output as evidence. If any box cannot be checked,
> stop and report which gate failed and why — do not declare success.
