// Test helpers — build a throwaway project root with fixtures, run, assert, clean up.
// Zero deps: node:test + node:fs only. Each test owns its own mkdtemp root.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Simple, flat layout so tests read cleanly: bricks/, recipes/, out/, _archive/.
const CONFIG = {
  bricks: "bricks",
  recipes: "recipes",
  out: "out",
  archive: "_archive",
};

// makeRoot({ config?, recipes?: {name: text}, bricks?: {name: text}, out?: {name: text} })
// Returns an absolute root path with forge.config.json + the given fixtures laid down.
export function makeRoot({ config = {}, recipes = {}, bricks = {}, out = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-test-"));
  const cfg = { ...CONFIG, ...config };
  writeFileSync(join(root, "forge.config.json"), JSON.stringify(cfg, null, 2));
  for (const [name, text] of Object.entries(recipes)) write(join(root, cfg.recipes, name + ".md"), text);
  for (const [name, text] of Object.entries(bricks)) write(join(root, cfg.bricks, name + ".md"), text);
  // F-26: cfg.out may be an array — out fixtures land in the FIRST destination (tests that need
  // a file in out[1..] write it explicitly with write()).
  const outDir = Array.isArray(cfg.out) ? cfg.out[0] : cfg.out;
  for (const [name, text] of Object.entries(out)) write(join(root, outDir, name + ".md"), text);
  return root;
}

// A bare temp root with NO forge.config.json (to exercise default paths / init from scratch).
export function bareRoot() {
  return mkdtempSync(join(tmpdir(), "forge-bare-"));
}

// Write a file, creating parent dirs. Supports nested names like "sub/brick".
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
export { write };

export const read = (path) => readFileSync(path, "utf8");
export const readRaw = (path) => readFileSync(path); // Buffer — to inspect raw bytes (EOL).
export const has = (path) => existsSync(path);
export const cleanup = (root) => rmSync(root, { recursive: true, force: true });

// Path builders relative to a root, mirroring the flat CONFIG above.
export const recipe = (root, name) => join(root, CONFIG.recipes, name + ".md");
export const brick = (root, name) => join(root, CONFIG.bricks, name + ".md");
export const outFile = (root, name) => join(root, CONFIG.out, name + ".md");
export const archived = (root, ...parts) => join(root, CONFIG.archive, ...parts);
