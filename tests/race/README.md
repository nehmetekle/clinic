# Food List PDF race tests

Concurrency tests for the "one current Food List PDF per visit" invariant and the
write-button gating around it. They exercise the real repositories/services
against a real Postgres, because the bugs they cover only appear when two writes
overlap — a single-click walkthrough passes either way.

| file | finding |
| --- | --- |
| `t1-save-during-pdf.ts` | Save/Close clicked while the PDF is still generating |
| `t2-concurrent-pdf.ts` | two generators racing on one visit |
| `t3-staleness-order.ts` | the close-time staleness check must read the newest file |
| `t5-double-close.ts` | "Close visit" double-clicked |

`t1` keeps its pre-fix mode: it re-runs the editor's flow with the old
`disabled={saving}` rule and asserts the bug still reproduces there, so the test
can't silently stop testing anything.

## Running

They need their own database — the runner refuses anything not named `*_test`,
so it can't be pointed at dev data.

```bash
docker exec nutriclinic-postgres psql -U nutriclinic -d postgres -c 'CREATE DATABASE nutriclinic_test;'
npm run test:race
```

Each test wipes that database before it runs.
