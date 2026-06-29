// nbp-forge — ciclo de vida de skills: new / remove / restore / gc / rename.
// Soft-delete por ref-count: remover uma skill arquiva a recipe + os bricks EXCLUSIVOS dela
// (ref-count cairia a 0); bricks compartilhados ficam. Tudo recuperável (versionado).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { loadConfig, run, includesOf, brickConsumers } from "./compose.mjs";

const mdFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md")).map(String) : [];
const move = (src, dest) => { mkdirSync(dirname(dest), { recursive: true }); renameSync(src, dest); };
const uniq = (a) => [...new Set(a)];

function paths(root, cfg = loadConfig(root)) {
  return {
    cfg,
    recipes: join(root, cfg.recipes),
    bricks: join(root, cfg.bricks),
    out: join(root, cfg.out),
    archive: join(root, cfg.archive),
  };
}

// ── new ────────────────────────────────────────────────────────────────────
export function create(skill, { root = process.cwd() } = {}) {
  const P = paths(root);
  const dest = join(P.recipes, skill + ".md");
  if (existsSync(dest)) return { ok: false, msg: `recipe já existe: ${skill}` };
  mkdirSync(P.recipes, { recursive: true });
  writeFileSync(dest, `---\nname: ${skill}\ndescription: TODO\n---\n# ${skill}\n\nTODO — conteúdo da skill. Use <!-- include: <brick> --> para reaproveitar.\n`);
  const r = run({ root, mode: "build" });
  return { ok: r.ok, msg: `recipe criada: ${skill} (edite ${P.cfg.recipes}/${skill}.md e rode build)` , build: r };
}

// ── remove (soft por padrão) ────────────────────────────────────────────────
export function remove(skill, { root = process.cwd(), hard = false } = {}) {
  const P = paths(root);
  const policy = hard ? "hard" : P.cfg.deletePolicy;
  const recipePath = join(P.recipes, skill + ".md");
  if (!existsSync(recipePath)) return { ok: false, msg: `skill não encontrada: ${skill}` };

  const includes = uniq(includesOf(readFileSync(recipePath, "utf8")));
  const consumers = brickConsumers(root, P.cfg);
  const exclusive = includes.filter((b) => consumers[b] && consumers[b].size === 1 && consumers[b].has(skill));
  const shared = includes
    .filter((b) => !exclusive.includes(b))
    .map((b) => ({ brick: b, alsoUsedBy: [...(consumers[b] || [])].filter((s) => s !== skill) }));

  if (policy === "soft") {
    const dir = join(P.archive, skill);
    move(recipePath, join(dir, "recipe.md"));
    for (const b of exclusive) move(join(P.bricks, b + ".md"), join(dir, "bricks", b + ".md"));
  } else {
    rmSync(recipePath);
    for (const b of exclusive) rmSync(join(P.bricks, b + ".md"));
  }
  const cmd = join(P.out, skill + ".md");
  if (existsSync(cmd)) rmSync(cmd); // command é build output

  const r = run({ root, mode: "build" });
  return { ok: r.ok, policy, exclusive, shared, msg:
    `skill "${skill}" removida (${policy}). ` +
    `Arquivados: recipe${exclusive.length ? " + " + exclusive.length + " brick(s) exclusivo(s): " + exclusive.join(", ") : ""}. ` +
    (shared.length ? `Mantidos (compartilhados): ${shared.map((s) => `${s.brick} [${s.alsoUsedBy.join(",")}]`).join("; ")}.` : "Sem bricks compartilhados.") };
}

// ── restore ─────────────────────────────────────────────────────────────────
export function restore(skill, { root = process.cwd() } = {}) {
  const P = paths(root);
  const dir = join(P.archive, skill);
  if (!existsSync(dir)) return { ok: false, msg: `nada arquivado para: ${skill}` };
  const recDest = join(P.recipes, skill + ".md");
  if (existsSync(recDest)) return { ok: false, msg: `conflito: recipe ${skill} já existe (resolva antes de restaurar)` };

  const conflicts = [];
  for (const rel of mdFiles(join(dir, "bricks"))) {
    if (existsSync(join(P.bricks, rel))) conflicts.push(rel);
  }
  if (conflicts.length) return { ok: false, msg: `conflito: bricks já existem: ${conflicts.join(", ")}` };

  move(join(dir, "recipe.md"), recDest);
  const restored = [];
  for (const rel of mdFiles(join(dir, "bricks"))) { move(join(dir, "bricks", rel), join(P.bricks, rel)); restored.push(rel.replace(/\.md$/, "")); }
  rmSync(dir, { recursive: true, force: true });

  const r = run({ root, mode: "build" });
  return { ok: r.ok, restored, msg: `skill "${skill}" restaurada${restored.length ? " + bricks: " + restored.join(", ") : ""}.` };
}

// ── gc (bricks órfãos: ref-count 0) ──────────────────────────────────────────
export function gc(root = process.cwd(), { apply = false, hard = false } = {}) {
  const P = paths(root);
  const consumers = brickConsumers(root, P.cfg);
  const orphans = mdFiles(P.bricks).map((f) => String(f).replace(/\.md$/, "")).filter((b) => !consumers[b]);
  if (apply && orphans.length) {
    const policy = hard ? "hard" : P.cfg.deletePolicy;
    for (const b of orphans) {
      if (policy === "soft") move(join(P.bricks, b + ".md"), join(P.archive, "_orphans", b + ".md"));
      else rmSync(join(P.bricks, b + ".md"));
    }
  }
  return { ok: true, orphans, applied: apply,
    msg: orphans.length ? `${orphans.length} brick(s) órfão(s): ${orphans.join(", ")}${apply ? " — arquivados" : " (rode com --apply p/ arquivar)"}` : "nenhum brick órfão." };
}

// ── rename ───────────────────────────────────────────────────────────────────
export function rename(oldName, newName, { root = process.cwd() } = {}) {
  const P = paths(root);
  const src = join(P.recipes, oldName + ".md");
  const dest = join(P.recipes, newName + ".md");
  if (!existsSync(src)) return { ok: false, msg: `skill não encontrada: ${oldName}` };
  if (existsSync(dest)) return { ok: false, msg: `destino já existe: ${newName}` };
  let txt = readFileSync(src, "utf8").replace(new RegExp(`^(name:\\s*)${oldName}\\s*$`, "m"), `$1${newName}`);
  writeFileSync(src, txt);
  move(src, dest);
  const oldCmd = join(P.out, oldName + ".md");
  if (existsSync(oldCmd)) rmSync(oldCmd); // command antigo é órfão agora
  const r = run({ root, mode: "build" });
  return { ok: r.ok, msg: `skill "${oldName}" → "${newName}" (command antigo removido, novo gerado).` };
}
