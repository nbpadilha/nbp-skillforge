# Setup & Pitfalls

> **PLACEHOLDER** — refinar quando o motor for portado.

## Instalação (pretendida)
```bash
npm i -D nbp-forge        # ou copie engine/ — zero dependências
node bin/cli.mjs build     # gera os SKILL.md a partir das recipes
node bin/cli.mjs check     # drift-gate (CI / pre-commit)
```

## ⚠️ Erro nº 1 (o mais comum) — editar o arquivo GERADO

Frameworks de agente (Claude Code, Codex, Cursor…) e a maioria dos `CLAUDE.md` /
`AGENTS.md` por aí instruem: **"edite a skill em `.claude/commands/<skill>.md`"** (ou
`.codex/`, etc.). Com a forja isso está **errado** — esse arquivo é **build output**.

- ✅ Edite a **recipe** (`recipes/<skill>.md`) ou o **brick** (`bricks/<brick>.md`) e rode `build`.
- ❌ Nunca edite o `SKILL.md`/`commands/` gerado — o `check` bloqueia (a edição diverge da recipe).

Cada arquivo gerado carrega um banner `<!-- GERADO … não editar aqui -->`. Se você (ou
um agente) for editar e ver o banner, **pare e vá para a recipe**.

> **Ao adotar a forja num projeto existente:** faça um *grep* no seu `CLAUDE.md`/`AGENTS.md`
> por "edit … commands" / "editar … `.md`" e redirecione para a recipe. Esse passo é fácil
> de esquecer e gera atrito (o agente tenta editar o gerado e o gate barra).

## Opções (config)
- `enforceGenerated` (default **off** no repo público): quando **on**, o `check` exige que
  todo `SKILL.md`/command tenha recipe — proíbe arquivo gerado "na mão". Ligue se você quer
  a garantia forge-only (é o modo usado no projeto de origem). TODO: formato do config.

## TODO
- [ ] Portar o motor validado (`compose` + `check` + `--enforce`)
- [ ] `forge.config.json` com `enforceGenerated`
- [ ] Exemplo end-to-end em `examples/`
