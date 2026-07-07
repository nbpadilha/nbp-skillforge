# ONBOARD-SPEC — Fase B: assisted canonicalization (harness-neutral)

> Audience: **any capable coding agent** (Claude Code, Codex, Cursor, …). This file is the
> logic; a harness wrapper (e.g. `claude-code/forge-onboard.md`) only points here. The
> deterministic engine (`forge onboard --apply --factor`) already migrated the library and
> factored the byte-identical parts — **your job is ONLY the similar-but-divergent parts.**

## Contract (non-negotiable)
1. **You propose → the human approves → the deterministic engine enforces.** Never write a brick
   or recipe the human hasn't approved (group by group, see §3).
2. **Never edit generated output** (`<out>/<skill>.md`, marked `GENERATED`). You edit recipes and
   bricks only; `forge build` produces the output.
3. **Verify by execution, never by opinion.** After every applied group: `forge build`, then
   `forge check`, then diff the rebuilt output against the run's backup (see §4). The engine's
   verdict wins over your own reading, always.
4. **Never touch** files under `.claude/plugins/**` (third-party), the forge's own tooling
   (frontmatter `forge-role: nbp-skillforge/onboard`), or skills the report lists as skipped
   without first resolving the reason for the skip WITH the human.

## 0 · Preconditions
- `forge onboard --apply --factor` has run: read the newest `_onboard-backup-*/onboard-report.md`
  (dispositions, fidelity gate, factored bricks, kept-verbatim list).
- `forge check` is green. If not, stop and surface that to the human first.

## 1 · Find the dedup groups (the divergent siblings)
**Primary input — existing variant families.** If the mechanical pass ran with `--variants`,
the near-duplicates were already materialized as bricks named `bricks/onboarded/<slug>_NN.md`
(frontmatter `variant-group: <slug>`; the onboard report lists each family under
`materialized as:`). **Each family IS a dedup group, pre-assembled for you**: the `_NN` bricks
are the variants (kept verbatim), and the consumers of each brick are the skills it serves.
Process these families FIRST — elect one canonical version + `{{param}}`s per family (§2), get
the per-group approval (§3), and verify by execution (§4), exactly as for any other group. After
a family is unified, its recipes include the new unified brick instead of the `_NN` members —
retire the `_NN` bricks by the normal means (they are now orphans: `forge gc` archives them, or
`remove`/archive explicitly). Never hand-merge `_NN` bricks outside this protocol.

Then scan the RECIPES (`forge list` for the map; then read each recipe body). Look for sections
that are **similar but not identical** across ≥2 skills — same intent, drifted wording: setup
steps, closing checklists, result contracts, folder conventions. The mechanical pass already took
the byte-identical ones; whatever similarity remains is by definition divergent.

**A dedup group = 1 candidate brick + the N skills it would serve** (a `<slug>_NN` variant
family = 1 group whose variants are already on disk).

## 2 · Elect the canonical version (per group)
Judge candidates on: completeness (covers the most cases), freshness (matches the CURRENT
conventions of the project), and precision (imperative, testable steps). Propose ONE canonical
text. Anything that legitimately varies per skill becomes a `{{param}}` — **variation is a
parameter the recipe passes, never a forked copy** (the golden rule).
- A param VALUE cannot contain the byte sequence `-->`; a param KEY is `[\w-]` only.
- Harness-specific idioms (e.g. `$ARGUMENTS`, tool names peculiar to one platform) stay in the
  recipe's residual body — never inside a shared brick.

## 3 · Approval unit = the GROUP (not the whole batch, not line-by-line)
Present to the human, per group: the skills touched, the canonical text, the params per skill,
and a **consolidated diff** of what each rebuilt skill would gain/lose vs today. Ask for ONE
approve/reject per group. Reject → the group stays as-is (recipes keep their divergent text);
record the rejection in your summary. Never proceed on silence.

## 4 · Apply + verify (per approved group)
1. Write the brick (`bricks/<name>.md`, body only carries what every consumer shares; heading
   lives inside the brick). Edit each recipe: replace the divergent section with
   `<!-- include: <brick> | k=v -->`.
2. `forge build` → `forge check` — both must pass; a build error means your edit broke an
   invariant (missing param, nested include): fix or revert before anything else.
3. Diff each touched skill's rebuilt output against the backup copy. **Drift here is EXPECTED**
   (canonicalization changes N−1 of N by design) — show the human the drift ONLY if it differs
   from the diff they already approved in §3; otherwise proceed.
4. Move to the next group. One group in flight at a time.

## 5 · Done
- Summarize: groups proposed / approved / rejected, bricks created, params introduced.
- Leave `forge check` green. If every skill in the project is governed and `enforceGenerated`
  is still off, remind the human it can be enabled (the engine auto-enables only on the
  mechanical pass's 100% condition).
- This skill is package tooling: suggest removing it (`rm` the installed copy) or leave it —
  the `forge-role` marker keeps it out of every onboarding scan AND out of `enforceGenerated`'s
  orphan scan (the engine treats marked files as package tooling, never as user skills), so
  leaving it in place is safe even under strict mode. Removing is optional tidiness.
