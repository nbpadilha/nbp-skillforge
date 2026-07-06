# 🧱 Guia rápido do nbp-skillforge (pra passar pros amigos)

> **O que é, em uma frase:** se você usa skills/comandos de IA (Claude Code, Codex, Cursor…),
> você provavelmente tem o MESMO texto copiado e colado em vários arquivos. O skillforge
> transforma isso em peças de LEGO: o trecho repetido vira **um brick só**, cada skill vira uma
> **receita** que aponta pros bricks, e uma ferramenta monta os arquivos finais pra você.
> Editou o brick uma vez → todas as skills atualizam juntas. E um "fiscal" avisa se alguém
> editou o arquivo errado.

---

## 1️⃣ Instalar (2 minutos)

Precisa só do Node.js (versão 18 ou mais nova). Na pasta do seu projeto:

```bash
npm i -D nbp-skillforge
npx nbp-skillforge init
```

Pronto. O `init` cria:
- `forge.config.json` — a configuração (pode deixar como está)
- `.claude/forge/bricks/` — onde moram as peças reutilizáveis
- `.claude/forge/recipes/` — onde mora a receita de cada skill
- uma skill de exemplo, já montada, pra você ver funcionando
- um verificador automático que roda antes de cada commit do git

---

## 2️⃣ Já tem skills? Migre tudo com UM comando

Se você já tem skills em `.claude/commands/`, não precisa refazer nada na mão:

```bash
npx nbp-skillforge onboard
```

Esse comando **só mostra um relatório** — não mexe em NADA. Ele lista o que vai migrar e o que
vai pular (e por quê). Gostou do plano? Execute de verdade:

```bash
npx nbp-skillforge onboard --apply --factor
```

O que acontece:
- 📦 **Backup primeiro**: toda skill original é copiada byte a byte pra uma pasta de backup
  (com instruções de como desfazer)
- ✅ **Prova de fidelidade**: pra cada skill migrada, ele PROVA que o arquivo remontado fica
  idêntico ao original — se não ficar, ele desfaz sozinho
- 🧱 **`--factor`**: os trechos que são EXATAMENTE iguais entre duas ou mais skills viram
  bricks compartilhados automaticamente
- 🙅 O que ele não conseguir migrar com segurança, ele **pula e explica** — nunca estraga

---

## 3️⃣ O dia a dia (a única regra que importa)

> ⚠️ **Nunca edite o arquivo final** (ele tem um aviso `GENERATED` no topo).
> **Edite a receita ou o brick**, e mande montar de novo.

```bash
# editar uma skill → mexa em .claude/forge/recipes/<nome>.md
# editar um trecho compartilhado → mexa em .claude/forge/bricks/<nome>.md

npx nbp-skillforge build    # remonta tudo que mudou
npx nbp-skillforge check    # o fiscal: acusa se algum arquivo final foi editado na mão
```

Outros comandos úteis:

```bash
npx nbp-skillforge new minha-skill     # criar skill nova
npx nbp-skillforge list                # ver quais skills usam quais bricks
npx nbp-skillforge remove minha-skill  # remover (vai pra uma lixeira recuperável, não some)
npx nbp-skillforge restore minha-skill # arrependeu? volta do jeito que estava
```

💡 O truque dos bricks: o que varia entre skills vira parâmetro, nunca cópia. Ex.:
`<!-- include: pasta-de-trabalho | skill=corrigir -->` — duas skills, o mesmo brick, cada uma
com seu valor.

---

## 4️⃣ Não gostou? Remover é AINDA mais fácil que instalar

Aqui está a melhor parte: **as suas skills nunca ficam reféns.** Os arquivos finais são
markdown normal, completos, na pasta de sempre. Pra desinstalar:

```bash
rm -rf .claude/forge        # apaga bricks, receitas e a lixeira
rm forge.config.json        # apaga a configuração
npm rm nbp-skillforge       # remove a ferramenta
```

E as skills? **Continuam todas lá, funcionando exatamente como antes.** Não tem formato
proprietário, não tem programa rodando, não tem nada pra converter de volta. O único vestígio
é uma linha de comentário no topo de cada arquivo (que a IA ignora).

> Instalar é fácil. Sair é mais fácil ainda. Por isso vale experimentar. 😉

---

**Links:** repositório e documentação completa em
[github.com/nbpadilha/nbp-skillforge](https://github.com/nbpadilha/nbp-skillforge) ·
pacote: [npmjs.com/package/nbp-skillforge](https://www.npmjs.com/package/nbp-skillforge)
