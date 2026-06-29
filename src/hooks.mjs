// nbp-forge — git hook installer. Writes .git/hooks/pre-commit as a thin SHIM that delegates to
// the VERSIONED hook bundled with this package (scripts/hooks/pre-commit). The shim carries no
// logic, so the real hook (reviewed in git) can't drift from what runs — and because the shim
// points at the bundled file, it works the same from a clone OR from node_modules (npm consumer).
// Zero deps. Hooks run under git's bundled sh (incl. Git for Windows).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_MARK = "nbp-forge hook shim";

export function installHooks({ root = process.cwd(), force = false } = {}) {
  try {
    // The versioned hook shipped with this package; resolve relative to THIS file so it works
    // whether nbp-forge is a clone (./scripts/...) or an installed dep (node_modules/nbp-forge/...).
    // Forward slashes so the path is valid inside the /bin/sh shim on every platform (incl. Windows).
    const bundledHook = fileURLToPath(new URL("../scripts/hooks/pre-commit", import.meta.url)).replace(/\\/g, "/");
    if (!existsSync(bundledHook)) return { ok: false, msg: `bundled hook not found: ${bundledHook}` };

    let hooksRel;
    try { hooksRel = execSync("git rev-parse --git-path hooks", { cwd: root, encoding: "utf8" }).trim(); }
    catch { return { ok: false, msg: "not a git repository (run from inside the repo)" }; }
    const hooksDir = isAbsolute(hooksRel) ? hooksRel : join(root, hooksRel);
    mkdirSync(hooksDir, { recursive: true });

    const dest = join(hooksDir, "pre-commit");
    let backedUp = false;
    if (existsSync(dest)) {
      const cur = readFileSync(dest, "utf8");
      // Line-anchored marker (not a loose substring) so a foreign hook merely *mentioning* the
      // phrase isn't mistaken for ours and overwritten.
      if (!/^# nbp-forge hook shim/m.test(cur)) {
        if (!force) return { ok: false, msg: `a non-nbp-forge pre-commit already exists: ${dest} (re-run with --force to back it up → pre-commit.local.bak and replace it)` };
        const bak = dest + ".local.bak";
        if (existsSync(bak)) rmSync(bak); // make the backup rename deterministic across platforms
        renameSync(dest, bak);
        backedUp = true;
      }
    }

    // Single-quote the path so $, backticks and " in it stay literal (no expansion or command
    // injection when git runs the hook); escape any embedded single-quote with the POSIX '\'' idiom.
    const quoted = "'" + bundledHook.replace(/'/g, "'\\''") + "'";
    // Run the hook via `sh` (not a bare exec) so it works regardless of the hook file's execute
    // bit — a tracked 100644 hook would otherwise fail `exec` with "Permission denied" on POSIX.
    const shim = `#!/bin/sh
# ${SHIM_MARK} — delegates to nbp-forge's versioned hook; do not edit here.
exec sh ${quoted} "$@"
`;
    writeFileSync(dest, shim);
    try { chmodSync(dest, 0o755); } catch { /* no-op on Windows; sh runs it anyway */ }

    return { ok: true, dest, bundledHook, backedUp,
      msg: `installed pre-commit hook → ${dest}` +
        (backedUp ? " (existing hook backed up → pre-commit.local.bak)" : "") +
        `\n  delegates to ${bundledHook}` };
  } catch (e) {
    return { ok: false, msg: `install-hooks failed: ${e.message}` }; // never crash the caller
  }
}
