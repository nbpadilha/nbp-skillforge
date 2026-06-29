# nbp-forge 🧱

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

## Quick start
```bash
node bin/cli.mjs build  --root .     # generate skills from recipes + bricks
node bin/cli.mjs check  --root .     # drift-gate: exit 1 if anything diverged / orphaned (CI, pre-commit)
```
A complete runnable project lives in [`examples/`](examples/) — try `node bin/cli.mjs build --root examples`.

## Full lifecycle (safe by default)
Skills are generated, so you never hand-edit the output. Manage them through the forge:

| Command | What it does |
|---|---|
| `forge new <skill>` | scaffold a new recipe |
| `forge rename <old> <new>` | rename a skill (regenerates, removes the stale output) |
| `forge remove <skill>` | **soft-delete** the recipe + the bricks **only that skill owns**; shared bricks stay (you're told which and why) |
| `forge restore <skill>` | bring a removed skill (and its bricks) back |
| `forge gc [--apply]` | find/archive **orphan bricks** (used by nobody) |

**Removing a skill never deletes a shared brick.** Ownership is decided by reference count: a brick used by exactly one skill is *owned* by it; a brick used by several belongs to none and is never touched. Removed items are **soft-deleted to `_archive/`** (versioned, so `forge restore` — or plain git — gets them back). Set `"deletePolicy": "hard"` if you prefer permanent deletes.

## Config — `forge.config.json`
```json
{
  "bricks": ".claude/forge/bricks",
  "recipes": ".claude/forge/recipes",
  "out": ".claude/commands",
  "archive": ".claude/forge/_archive",
  "deletePolicy": "soft",
  "enforceGenerated": false
}
```
- **`deletePolicy`** — `soft` (move to `_archive/`, recoverable) or `hard` (delete).
- **`enforceGenerated`** — when `true`, `check` requires every output file to have a recipe, forbidding hand-made/edited skills (forge-only guarantee).

## Why this exists
The open [agentskills](https://github.com/agentskills/agentskills) standard defines the portable `SKILL.md` format — but has **no composition/includes**. Linters validate the spec, not content drift between a fragment and the skill. Prompt-templating tools (Jinja, LangChain) compose prompts, not skills. `nbp-forge` fills the gap: **deterministic composition + a drift-gate on top of the standard.** See [`SETUP.md`](SETUP.md) for the #1 pitfall (tooling that tells you to edit the *generated* file) and [`SECURITY.md`](SECURITY.md) for the shared-brick blast radius.

## License
MIT © Nikolas Padilha
