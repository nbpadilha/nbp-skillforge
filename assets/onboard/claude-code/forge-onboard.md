---
name: forge-onboard
description: Assisted onboarding (Fase B) — canonicalize the similar-but-divergent sections of an already-migrated skill library into shared bricks, one human-approved group at a time. Run AFTER `forge onboard --apply --factor`.
forge-role: nbp-skillforge/onboard
---
# forge-onboard — assisted canonicalization (reference wrapper: Claude Code)

You are running nbp-skillforge's **Fase B**. The deterministic engine already migrated this
project's skills into recipes and factored the byte-identical shared sections into bricks.
What remains is semantic judgment: sections that are **similar but divergent** across skills.

**The full harness-neutral protocol (ONBOARD-SPEC) is embedded below in this same file** — the
installer inlines it so this skill is self-contained wherever it lands. Read it FIRST and follow
it exactly — the contract (you propose → human approves per group → engine verifies by
execution) is non-negotiable.

Quick orientation before you start:
1. Read the newest `_onboard-backup-*/onboard-report.md` (dispositions, gate verdicts, factored
   bricks, kept-verbatim list) and run `forge check` — it must be green.
2. Build the dedup groups (§1 of the SPEC), elect canonicals (§2), and present ONE consolidated
   diff per group for approval (§3).
3. Apply approved groups one at a time; verify each with `forge build` + `forge check` + a diff
   against the backup (§4). The engine's verdict always wins.

Never edit generated output (files with the `GENERATED` banner) — recipes and bricks only.
