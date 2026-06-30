---
piece: run-dir
kind: step
summary: Creates the run's working folder. Variation = a parameter, not a copy.
guarantees-not: does not provide the `run-dir` script itself — assumes it is on PATH.
---
### Working folder

At the start, create this run's folder:

```bash
RUN_DIR=$(run-dir {{skill}} "$DESC" {{flags}})
```

The logic (slug, timestamp, tracking) lives in the script — the skill does **not** restate it.
