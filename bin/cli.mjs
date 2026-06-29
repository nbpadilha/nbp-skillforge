#!/usr/bin/env node
// nbp-forge CLI.
//   forge build [--root <dir>]   → gera os arquivos a partir das recipes+bricks
//   forge check [--root <dir>]   → drift-gate: sai 1 se algo divergir / órfão (CI, pre-commit)
// Caminhos e opções: forge.config.json na raiz (ver src/compose.mjs DEFAULTS).

import { run } from "../src/compose.mjs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) || "build";
const ri = argv.indexOf("--root");
const root = resolve(ri >= 0 && argv[ri + 1] ? argv[ri + 1] : process.cwd());
const mode = cmd === "check" ? "check" : "build";

const r = run({ root, mode });

if (r.errors?.length) for (const e of r.errors) console.error("  • " + e);

if (mode === "check") {
  if (r.ok) { console.log(`✅ forge check: ${r.count} em sincronia${ /* enforce */ ""}.`); process.exit(0); }
  console.error(`❌ forge check falhou (${r.drift || 0} drift, ${r.orphans || 0} órfãos).`);
  process.exit(1);
} else {
  if (!r.ok) { console.error("❌ build abortado (erros acima)."); process.exit(1); }
  console.log(`✔ forge build: ${r.written} arquivo(s) gerado(s).`);
  process.exit(0);
}
