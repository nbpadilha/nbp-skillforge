# nbp-forge 🧱

Componha as "skills" / comandos de agentes de IA a partir de **peças reutilizáveis** —
com um **gate anti-drift**. Editou uma peça, todas as skills que a usam ficam atuais.
A saída é um arquivo self-contained e portátil (Claude Code, Codex, Cursor, …).

> **O problema:** o mesmo passo copiado em N skills envelhece em silêncio — corrige numa,
> esquece nas outras. **A solução:** a skill **aponta** (não copia); um build determinístico
> monta o arquivo final; um gate bloqueia qualquer cópia fora de sincronia.

## Como funciona
```
forge/
├─ bricks/     tijolos reutilizáveis (fragmentos compartilhados)
└─ recipes/    uma receita por skill: conteúdo local + <!-- include: <brick> -->
        ↓  forge build
<out>/<skill>.md   ← gerado (banner "GENERATED"), é o que o agente lê
```

## Uso
```bash
node bin/cli.mjs build [--root <dir>]   # gera os arquivos das recipes+bricks
node bin/cli.mjs check [--root <dir>]   # drift-gate: exit 1 se divergir / órfão (CI, pre-commit)
```
Veja `examples/` para um projeto completo rodável (`node bin/cli.mjs build --root examples`).

## Include + parâmetros
```
<!-- include: doc-checklist -->
<!-- include: run-dir | skill=fix; flags=--prefix fix --track -->   → {{skill}}, {{flags}} no tijolo
```
Parâmetros após `|`, separados por `;` (valor pode ter espaços).

### Regra de ouro
> A variância entre skills é um **parâmetro** que a receita passa — nunca um trecho copiado e
> modificado dentro do tijolo. Editou o tijolo → todas as skills herdam ao regenerar.

## Config (`forge.config.json` na raiz)
```json
{ "bricks": ".claude/forge/bricks", "recipes": ".claude/forge/recipes",
  "out": ".claude/commands", "enforceGenerated": false }
```
- **`enforceGenerated`** (default `false`): quando `true`, o `check` exige que **todo** arquivo
  de saída tenha recipe — proíbe arquivo gerado editado "na mão". Ligue para a garantia forge-only.

## Por que isto existe
O padrão aberto [agentskills](https://github.com/agentskills/agentskills) define o formato
`SKILL.md` portátil — mas **sem** composição/include. Os linters validam spec, não drift de
conteúdo entre fragmento e skill. `nbp-forge` preenche esse vão: composição determinística +
drift-gate sobre o standard. Ver `SETUP.md` (pitfalls) e `SECURITY.md` (blast radius de tijolos).

## Licença
MIT.
