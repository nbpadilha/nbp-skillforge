# nbp-skillforge 🧱

[![npm version](https://img.shields.io/npm/v/nbp-skillforge.svg)](https://www.npmjs.com/package/nbp-skillforge)
[![CI](https://github.com/nbpadilha/nbp-skillforge/actions/workflows/ci.yml/badge.svg)](https://github.com/nbpadilha/nbp-skillforge/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/nbp-skillforge.svg)](LICENSE)
[![node >=18](https://img.shields.io/node/v/nbp-skillforge.svg)](package.json)

![nbp-skillforge — raw bricks forged into one verified skill](https://raw.githubusercontent.com/nbpadilha/nbp-skillforge/main/assets/social-card.png)

**Your agent's skills are prompts copy-pasted across a dozen files, quietly rotting out of sync. Forge them from shared bricks instead: write a step once, reuse it everywhere, and a gate guarantees nothing ever drifts.**

Once you run more than a couple of agent skills, keeping them consistent by hand stops being possible. The same "set up a run folder", the same closing checklist, the same result contract — pasted everywhere, edited in one place, forgotten in six. `nbp-skillforge` makes a library of agent skills as maintainable as real code: **one source of truth, a deterministic build, and a drift-gate that makes consistency a guarantee instead of a hope.**

> Battle-tested in a real codebase where a **single brick is reused by 7 skills** — one edit instead of seven, ~85% fewer copies. The bigger your skill library gets, the less you can live without this.

---

## Why you'll want it

- **One edit, every skill current.** Change the brick; every skill that uses it is up to date on the next build. No hunting copies.
- **It never ships a drifted skill.** `forge check` fails the moment a generated skill diverges from its source — in CI, in your pre-commit hook. "Which copy is right?" stops being a question.
- **Portable, zero lock-in.** Output is a standard, self-contained `SKILL.md`/command file — works with Claude Code, Codex, Cursor, and anything that reads the format. No proprietary syntax leaks into it. One recipe set can even build to **several destinations at once** (`"out": [".claude/commands", ".codex/prompts"]`) — same skills, N agent platforms, one source of truth.
- **Zero runtime dependencies.** One small CLI, Node ≥ 18. Nothing to audit, nothing to break.

## Adopt in minutes, leave in seconds

The reason it's safe to try: **you're never locked in, in either direction.**

- **Migrating in is incremental and non-destructive.** Onboard one skill you already have, build it, done — skills you haven't touched are left exactly as they are. No big-bang rewrite, no flag day. You move at your own pace and stop whenever you like.
- **Rolling back is easier still — you do nothing.** Every skill the forge builds is a complete, standalone file sitting in your normal `.claude/commands/` path. Delete the forge folder (plus its small config file at the repo root) and uninstall the package, and **every skill keeps working, untouched and ready** — there's no runtime, no format to unwind, nothing to migrate back. The only trace left behind is one harmless comment line at the top of each file.

> Install is easy. Uninstall is easier — your skills were never hostages.

> **Migrating a whole library? One command.** `forge onboard` reads your existing skills in one pass and shows exactly what it would do — nothing is written until you say `--apply`. Then it snapshots every original (byte-faithful backup + rollback instructions), migrates them, and a **fidelity gate** proves each migrated skill rebuilds identical to its original. Add `--factor` and the sections that are **byte-identical across skills become shared bricks automatically** — still gate-verified, still reverting to verbatim if fidelity would break. Skills it can't migrate safely are skipped and reported, never touched. When 100% of your library is governed, strict mode turns on by itself.
>
> And for the parts that are similar-but-divergent across skills, there's the **assisted step**: `forge onboard --install-skill` drops a `forge-onboard` agent skill into your commands — run it in your agent and it proposes a unified version per group, **you approve group by group**, and the engine verifies every applied group by execution. The skill is package tooling (marked, ignored by scans, removed automatically when strict mode turns on) — its harness-neutral protocol ships in the package as `ONBOARD-SPEC.md`, so any capable agent can run it.

---

## The idea in one picture

A skill stops being a wall of copied text and becomes a **recipe** that *points* to shared **bricks**. A deterministic build assembles the final file your agent actually reads.

![Pipeline: recipe, then bricks aggregated by forge/build, then SKILL.md, then a verified gate](https://raw.githubusercontent.com/nbpadilha/nbp-skillforge/main/assets/how-it-works-compact.png)

```
forge/
├─ bricks/     reusable pieces, shared across skills
└─ recipes/    one per skill: its own content + <!-- include: <brick> -->
        ↓  forge build
<out>/<skill>.md   ← generated, self-contained; this is what the agent reads
```

**The golden rule —** variation between skills is a *parameter* the recipe passes, never a forked copy of the brick:

```
<!-- include: run-dir | skill=fix; flags=--prefix fix -->   →  {{skill}} / {{flags}} in the brick
```

Two skills, the same brick, different parameters. One source of truth.

## See it in 60 seconds

One "set up a run folder" step, shared by two skills — written once, built into both, and the drift-gate catching a hand-edit before it reaches anyone.

```bash
# one brick (bricks/run-dir.md), included by two recipes with different params:
#   recipes/fix.md      →  <!-- include: run-dir | skill=fix -->
#   recipes/feature.md  →  <!-- include: run-dir | skill=feature -->

$ npx nbp-skillforge build
✔ build: 2 written, 0 unchanged.     # both skills now carry the same step, parameterized

$ echo "rogue tweak" >> .claude/commands/fix.md   # someone hand-edits a generated file…
$ npx nbp-skillforge check
✗ check failed (1 drift, 0 orphans).
  • drift: .claude/commands/fix.md is out of sync with its recipe (first difference at line 9: expected "", found "rogue tweak")   # ← your CI fails right here
```

Fix it the right way — edit the **brick**, run `build`, and **both** skills update at once.

> Try the runnable version: `npx nbp-skillforge build --root examples` then `npx nbp-skillforge check --root examples`.

## Quick start

```bash
npx nbp-skillforge init          # scaffold config + dirs + a sample skill, install the pre-commit hook
npx nbp-skillforge build         # generate skills from recipes + bricks
npx nbp-skillforge check         # drift-gate: exit 1 if any output diverged (for CI / pre-commit)
npx nbp-skillforge onboard       # migrate an existing skill library: dry-run report; --apply executes
npx nbp-skillforge import <file> # onboard a single existing SKILL.md/command as a recipe, then `build`
npx nbp-skillforge help          # every command; `help <command>` for one
# prefer a global install? npm i -g nbp-skillforge  →  then just `nbp-skillforge build`
```

A complete runnable project lives in [`examples/`](examples/). Setting it up with an AI agent? Hand it [`AGENTS-SETUP.md`](AGENTS-SETUP.md) — an idempotent, verify-as-you-go runbook that runs the whole adoption autonomously.

> 🇧🇷 **Fala português?** Guia passo a passo simples (instalar, migrar, manter, remover): [`docs/GUIA-PT.md`](docs/GUIA-PT.md).

> **CLI-only.** It's a command-line tool, not a library — no public API, no shipped types. Drive it with the commands above (or your `package.json` scripts / CI).

## Safe by default

- **Generated files are never hand-edited** — you manage skills through the forge, and the drift-gate enforces it.
- **Removing a skill never deletes a shared brick.** Ownership is by reference count; a brick used by several skills belongs to none and is never touched.
- **Soft-delete by default.** `remove`/`gc` archive to `_archive/` (recoverable via `forge restore` or plain git); opt into hard deletes only if you want them.
- **A pre-commit hook** (installed by `init`, best-effort, never clobbers an existing hook) runs the drift-gate *and* a basic secret scan before every commit.

The full command lifecycle, `forge.config.json` options, conformance rules, `--json` output shapes, and the safety/boundary model are documented in **[`SPEC.md`](SPEC.md)**. Common adoption pitfall and the shared-brick blast radius: [`SETUP.md`](SETUP.md) · [`SECURITY.md`](SECURITY.md). Visual overview: [`docs/architecture.html`](docs/architecture.html).

## Why this exists

The open [agentskills](https://github.com/agentskills/agentskills) standard defines the portable `SKILL.md` format — but has **no composition/includes**, and linters validate the spec, not content drift between a fragment and the skill. Prompt-templating tools (Jinja, LangChain) compose prompts, not skills. `nbp-skillforge` fills the gap: **deterministic composition + a drift-gate, on top of the standard.**

## License

MIT © Nikolas Padilha
