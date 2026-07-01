# nbp-forge 🧱

[![npm version](https://img.shields.io/npm/v/nbp-forge.svg)](https://www.npmjs.com/package/nbp-forge)
[![CI](https://github.com/nbpadilha/nbp-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/nbpadilha/nbp-forge/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/nbp-forge.svg)](LICENSE)
[![node >=18](https://img.shields.io/node/v/nbp-forge.svg)](package.json)

**Stop maintaining the same agent instructions in ten places. Write a step once, reuse it everywhere, and let a gate guarantee nothing ever drifts.**

`nbp-forge` composes your AI-agent skills (`SKILL.md` / slash-command files) from **reusable bricks**. You edit the brick — every skill that uses it is current on the next build. A drift-gate makes it a guarantee, not a hope.

> Built for and battle-tested in a real codebase where a **single brick is reused by up to 7 skills**. That's **one edit instead of seven** — and a copy-paste step that lived in 7 files collapses to **one source of truth (~85% fewer copies)**. The bigger your skill library, the more it compounds.

---

## The problem
Agent "skills" (the playbooks your agent follows) accumulate the **same steps copy-pasted everywhere**: set up a run folder, a closing checklist, a result contract. Fix one copy, forget the other six — they diverge silently, and nobody knows which is right. Reviewing means hunting every copy.

## The fix
A skill becomes a **recipe** that *points* to **bricks** instead of copying them. A deterministic build assembles the final, self-contained file your agent reads. A gate blocks any output that drifts from its recipe.

```
forge/
├─ bricks/     reusable pieces (shared building blocks)
└─ recipes/    one per skill: local content + <!-- include: <brick> -->
        ↓  forge build
<out>/<skill>.md   ← generated (carries a "GENERATED" banner); this is what the agent reads
```

- **Portable.** Output is a standard self-contained file — works with Claude Code, Codex, Cursor, etc. (no proprietary pointer syntax leaks into it).
- **Deterministic.** Same recipes + bricks → same output, every time.
- **Drift-proof.** `forge check` fails if any generated file was hand-edited or diverges from its recipe.

## The golden rule
> Variation between skills is a **parameter** the recipe passes — never a modified copy of the brick.

```
<!-- include: run-dir | skill=fix; flags=--prefix fix --track -->   →  {{skill}} / {{flags}} in the brick
```
Two skills, the same brick, different parameters. One source of truth.

---

## See it in 60 seconds
One "set up a run folder" step, shared by two skills — written once, built into both, and the
drift-gate catching a hand-edit before it reaches anyone.

```bash
# 1) one brick, reused by both skills — bricks/run-dir.md
#    "Create runs/{{skill}}/ and write progress there as you go."

# 2) two recipes include it with different params
#    recipes/fix.md      →  <!-- include: run-dir | skill=fix -->
#    recipes/feature.md  →  <!-- include: run-dir | skill=feature -->

$ npx nbp-forge build
✔ build: 2 file(s) generated.        # both skills now carry the same step, parameterized

# 3) someone hand-edits a GENERATED file…
$ echo "rogue tweak" >> .claude/commands/fix.md
$ npx nbp-forge check
✗ check failed (1 drift, 0 orphans).
  • drift: .claude/commands/fix.md is out of sync with its recipe   # ← your CI fails right here
```

Fix it the right way — edit the **brick**, run `build`, and **both** skills update at once. That's
the whole idea: one source of truth, and a gate that makes it stick.

> Try the runnable version now: `npx nbp-forge build --root examples` then `npx nbp-forge check --root examples`.

---

## Quick start
Installed from npm (zero runtime dependencies):
```bash
npx nbp-forge init                # scaffold forge.config.json + dirs + a sample skill, and install the pre-commit hook
npx nbp-forge build  --root .     # generate skills from recipes + bricks
npx nbp-forge check  --root .     # drift-gate: exit 1 if any output diverged from its recipe (CI, pre-commit)
npx nbp-forge help                # all commands; `help <command>` for one
# or install once: npm i -g nbp-forge  →  nbp-forge build / nbp-forge check
```
From a clone of this repo, the CLI is `node bin/cli.mjs <cmd>`. A complete runnable project lives in [`examples/`](examples/) — try `npx nbp-forge build --root examples`.

> **CLI-only.** nbp-forge is a command-line tool, not a library: there is no public programmatic API and **no TypeScript types are shipped**. Drive it with the `forge` commands above (or your `package.json` scripts / CI), not via `import`.

> **Setting it up with an agent?** Hand your AI agent [`AGENTS-SETUP.md`](AGENTS-SETUP.md) — an
> end-to-end, idempotent setup runbook (install → init → author → build → gate → CI) with a
> verify-by-execution gate after every step, so the whole adoption runs autonomously.

## Pre-commit hook
`forge init` **installs this hook for you** (best-effort — it never fails init and never clobbers an
existing hook; pass `--no-hooks` to skip). It runs the drift-gate **and** a basic secret scan before
every commit. To install it on its own (e.g. in a repo you didn't `init`, or after `--no-hooks`):
```bash
npx nbp-forge install-hooks   # in a project that depends on nbp-forge
npm run hooks:install         # equivalent, from a clone of this repo
```
It's a **thin shim** that delegates to the versioned [`scripts/hooks/pre-commit`](scripts/hooks/pre-commit) bundled with the package — so the logic is reviewed in git and never drifts from what runs, whether you're in a clone or using nbp-forge as a dependency. The hook blocks a commit that (a) stages an env file (`.env`, `.env.local`, `*.env` — templates like `*.example` are allowed), (b) adds a token-shaped string (`ghp_…`, `sk-…`, `npm_…`, AWS keys, private-key headers), or (c) leaves a generated file out of sync with its recipe. The drift-gate runs `forge:check` if your `package.json` defines it, else `npx nbp-forge check` when the repo root is a forge project. Respects `core.hooksPath`. Bypass (discouraged) with `git commit --no-verify`.

More examples to copy into your own repo: a CI workflow that runs the drift-gate ([`examples/.github/workflows/forge-check.yml`](examples/.github/workflows/forge-check.yml)) and an optional Claude Code hook that stops the agent from hand-editing a generated skill ([`examples/claude-code/`](examples/claude-code/)).

## Full lifecycle (safe by default)
Skills are generated, so you never hand-edit the output. Manage them through the forge:

| Command | What it does |
|---|---|
| `forge init` | scaffold `forge.config.json` + dirs + a sample skill, and install the pre-commit hook (idempotent; never overwrites; `--no-hooks` to skip) |
| `forge list` | show each skill → the bricks it uses, and per-brick ref-count (blast radius) |
| `forge new <skill>` | scaffold a new recipe |
| `forge import <file>` | onboard an existing `SKILL.md`/command as a recipe (verbatim; strips a prior GENERATED banner). `--name` overrides; `--force` overwrites. Run `forge build` after. |
| `forge rename <old> <new>` | rename a skill (regenerates, removes the stale output) |
| `forge remove <skill>` | **soft-delete** the recipe + the bricks **only that skill owns**; shared bricks stay (you're told which and why) |
| `forge restore <skill>` | bring a removed skill (and its bricks) back |
| `forge gc [--apply]` | find/archive **orphan bricks** (used by nobody) |

**Bricks aren't in this table** — they're plain files, not a managed command: create `bricks/<path>.md`, include it from a recipe, and the ref-count tracks consumers automatically (`forge gc` archives any nobody includes). See [**Authoring a brick**](SPEC.md#authoring-a-brick) for the body/heading convention and frontmatter fields.

**Removing a skill never deletes a shared brick.** Ownership is decided by reference count: a brick used by exactly one skill is *owned* by it; a brick used by several belongs to none and is never touched. Removed items are **soft-deleted to `_archive/`** (versioned, so `forge restore` — or plain git — gets them back). Set `"deletePolicy": "hard"` if you prefer permanent deletes.

## Config — `forge.config.json`
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
- **`deletePolicy`** — `soft` (move to `_archive/`, recoverable) or `hard` (delete).
- **`enforceGenerated`** — when `true`, `check` requires every output file to have a recipe, forbidding hand-made/edited skills (forge-only guarantee).
- **`conformance`** — when `true` (default), `build`/`check` also validate a recipe's frontmatter against the [agentskills](https://github.com/agentskills/agentskills) SKILL.md standard (`name` lowercase-with-hyphens ≤64 chars; non-empty `description` ≤1024) so a non-standard skill fails *here*, not when the agent platform rejects it. Only validates fields that are present; set `false` to disable.

## Why this exists
The open [agentskills](https://github.com/agentskills/agentskills) standard defines the portable `SKILL.md` format — but has **no composition/includes**. Linters validate the spec, not content drift between a fragment and the skill. Prompt-templating tools (Jinja, LangChain) compose prompts, not skills. `nbp-forge` fills the gap: **deterministic composition + a drift-gate on top of the standard.** See [`SETUP.md`](SETUP.md) for the #1 pitfall (tooling that tells you to edit the *generated* file) and [`SECURITY.md`](SECURITY.md) for the shared-brick blast radius.

## License
MIT © Nikolas Padilha
