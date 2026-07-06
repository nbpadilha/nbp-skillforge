// nbp-skillforge — path canonicalization, unified (F-13).
// Three call sites (compose.mjs's role-dir-overlap check, lifecycle.mjs's distinctRoles check +
// insideBricks, hooks.mjs's git-toplevel compare) each hand-rolled their own realpath+fallback
// closure. This module is the single source of truth for the two variants that actually differ:
//   canon(p)      — realpath (resolves symlinks/junctions, canonical on-disk case) when `p`
//                    exists; falls back to resolve() (lexical, absolute) when it doesn't yet.
//                    Never folds case.
//   canonFold(p)  — canon(p) + lowercase on a case-insensitive filesystem (win32/darwin).
// Get the right one per call site: canonFold is ONLY needed where two role dirs are compared
// before both are guaranteed to exist (the realpath fallback then no longer folds case for you
// via the OS) — compose.mjs's role-overlap check is the one place that structurally needs it
// (out/archive can both be simultaneously nonexistent, pre-first-build). Everywhere else (a dir
// that's always mkdir'd immediately before the check) plain canon() preserves current behavior.
//
// Two `realpathSync` call sites deliberately stay OUTSIDE this module (not a coverage gap — a
// documented exception): compose.mjs's include on-disk CASE MATCH check (compares a resolved
// brick path's real on-disk case against the literal include text, not a containment/overlap
// check — canon()/isInside() don't model that) and lifecycle.mjs's `insideBricks` (its try/catch
// wraps TWO realpath calls jointly, with an intentionally asymmetric lexical fallback that has
// no equality case — folding it into canon()'s per-call fallback would change that asymmetry).
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

export function canon(p) {
  try { return realpathSync.native(resolve(p)); } catch { return resolve(p); }
}

export function canonFold(p) {
  const r = canon(p);
  return CASE_INSENSITIVE_FS ? r.toLowerCase() : r;
}

// Pure containment predicate on two ALREADY-canonicalized (or already-resolved) paths —
// `child === parent` counts as inside (exact-dir-match). Does not itself touch the filesystem;
// callers choose whether to canon()/canonFold() their arguments first, or compare purely
// lexically (e.g. compose.mjs's include-escape pre-filter, which must stay symlink-unaware).
export function isInside(child, parent) {
  // C3: at a filesystem/drive root, `parent` already ends with `sep` (`C:\` on win32, `/` on
  // POSIX) — naively appending `+ sep` produces `C:\\`/`//`, which no real child path starts
  // with, so every child of a root parent was wrongly rejected (false negative). Only append the
  // separator when `parent` doesn't already end with one.
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}
