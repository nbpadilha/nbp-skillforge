# SECURITY — blast radius de peças compartilhadas

> **PLACEHOLDER** — desenvolver.

Reuso traz um custo de segurança: **um bug numa peça se propaga para todas as skills
que a usam**. (cf. auditorias de marketplaces de skills — risco sistêmico por grafo de
dependência.)

## Princípios (rascunho)
- Cada peça declara no frontmatter o que **NÃO** garante (`guarantees-not`).
- Mudança em peça de **alto reuso** exige revisão mais pesada (proporcional ao nº de skills).
- O build é determinístico e auditável: a saída `SKILL.md` é versionada e revisável.

## TODO
- [ ] Métrica de blast radius (nº de skills por peça) no relatório do build
- [ ] Política de revisão por nível de reuso
- [ ] Como reportar vulnerabilidade
