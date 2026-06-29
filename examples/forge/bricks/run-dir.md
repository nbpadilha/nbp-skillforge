---
piece: run-dir
summary: Cria a pasta de trabalho da execução. Variância = parâmetro, não cópia.
---
### Pasta de trabalho

No início, crie a pasta desta execução:

```bash
RUN_DIR=$(run-dir {{skill}} "$DESC" {{flags}})
```

A lógica (slug, timestamp, rastreio) mora no script — a skill **não** a redescreve.
