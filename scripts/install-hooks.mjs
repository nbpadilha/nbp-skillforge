#!/usr/bin/env node
// Thin wrapper around installHooks() — kept so `npm run hooks:install` works in a clone.
// npm consumers should prefer `npx nbp-skillforge install-hooks` (same logic via the CLI).
import { installHooks } from "../src/hooks.mjs";

const r = installHooks({ force: process.argv.includes("--force") });
console[r.ok ? "log" : "error"]((r.ok ? "✔ " : "✗ ") + r.msg);
process.exit(r.ok ? 0 : 1);
