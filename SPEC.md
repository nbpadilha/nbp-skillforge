# SPEC — composição de skills

## Modelo
Uma skill é uma **recipe** (`recipes/<name>.md`) que aponta para **bricks**
(`bricks/<path>.md`). O `build` resolve os apontamentos e emite `<out>/<name>.md`
(SKILL.md/command padrão, self-contained, com banner "GENERATED").

A forja só governa skills que **têm recipe**. Migração incremental: o que não tem recipe
fica intacto (e, com `enforceGenerated`, é sinalizado como órfão).

## Diretiva de include
```
<!-- include: <brick-path> [| k=v; k2=v2 ...] -->
```
- `<brick-path>` é relativo a `bricks/`, sem `.md` (pode ser aninhado: `core/run-dir`).
- Parâmetros após `|`, separados por `;` (valor pode conter espaços).
- No corpo do brick, `{{k}}` é substituído pelo valor. Parâmetro faltando → **erro de build**
  (não grava nada). Brick inexistente → **erro de build**.

## Frontmatter
- **Recipe:** o frontmatter (`name`, `description`, …) é repassado verbatim ao arquivo gerado
  (compatível com o standard agentskills). O banner entra logo após o `---` de fechamento.
- **Brick:** frontmatter próprio (`piece`, `summary`, `guarantees-not` recomendados) é
  **descartado** na expansão — só o corpo entra.

## EOL
Saída sempre LF. O `check` é CR-insensitive (sem falso-positivo por CRLF no Windows).
Recomenda-se `.gitattributes` com `eol=lf` para `forge/**` e o diretório de saída.

## Regra de ouro
> A variância entre skills é um **parâmetro** passado pela recipe — nunca uma cópia modificada
> do tijolo.

## Limitações conhecidas
- O parser de parâmetros separa por `;`; um valor que contenha `;` literal seria truncado.
  (TODO: escape/aspas se algum caso real surgir.)
