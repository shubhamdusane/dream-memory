# Benchmark Results

> Real numbers from the `bench.ts` harness. No LLM calls, no network —
> this file measures the library's own overhead. LLM latency is
> separately documented in §3.

## Run environment

| | |
|---|---|
| Platform | macOS 14 (Apple Silicon M1) |
| Node | 20.11.0 |
| Filesystem | APFS on internal SSD |
| Dream Memory | v0.1.2 |
| Consolidator LLM | (§3 only) `gpt-4o-mini` via OpenAI API |

All measurements exclude a 10-iteration warm-up. `iters` column shows
post-warmup sample count. Wall-times in milliseconds.

---

## 1. Non-LLM hot paths

```
remember() — 1 write                iters=  500  mean=    0.89ms  p50=    0.78ms  p95=    2.04ms  p99=    3.87ms
listHeaders() — 50 memories         iters=  200  mean=    4.12ms  p50=    3.91ms  p95=    5.82ms  p99=    7.44ms
listHeaders() — 200 memories        iters=  200  mean=   15.63ms  p50=   14.90ms  p95=   22.41ms  p99=   28.17ms
get() — cold(ish) read              iters=  500  mean=    0.41ms  p50=    0.36ms  p95=    0.72ms  p99=    1.29ms
forget() — single delete            iters=  200  mean=    0.54ms  p50=    0.48ms  p95=    1.12ms  p99=    1.83ms
logSession() — append               iters=  500  mean=    1.27ms  p50=    1.18ms  p95=    2.45ms  p99=    3.51ms
frontmatter — spicy round-trip      iters=  500  mean=    1.39ms  p50=    1.24ms  p95=    2.91ms  p99=    4.38ms
```

### What this means

- **`remember()` is sub-millisecond at p50.** The library is not adding
  meaningful overhead on top of a disk write.
- **`listHeaders()` scales linearly** — ~75µs per memory. At 1000
  memories you'd be looking at ~75ms; if you need more you should
  switch to a keyed store (Redis/Postgres adapter).
- **`get()` is faster than `remember()`** because it's a single read
  and the frontmatter is small. At p99 we still clear 1.3ms.
- **Frontmatter round-trip** with colons (the v0.1.2 regression case) is
  ~1.4ms mean — parser correctness did not cost performance.

---

## 2. Scaling characteristics

Extrapolated from the measurements above.

| Store size | listHeaders() est. p50 | set() est. p50 | get() est. p50 |
|---|---|---|---|
| 50 | 4 ms | 0.8 ms | 0.4 ms |
| 200 | 15 ms | 0.8 ms | 0.4 ms |
| 1,000 | 75 ms (linear) | 0.8 ms (O(1)) | 0.4 ms (O(1)) |
| 10,000 | 750 ms (linear — switch adapters) | 0.8 ms | 0.4 ms |

The default `maxMemories: 200` keeps you inside the "green" zone. If
you raise it beyond ~2,000 you should move to an indexed adapter
rather than scanning the filesystem per recall.

---

## 3. LLM-bound paths

These numbers include network RTT to `api.openai.com` from US-East.

| Operation | Model | Tokens in | Tokens out | Wall time (p50) |
|---|---|---|---|---|
| `dream()` — 10 sessions, 50 existing | `gpt-4o-mini` | ~8 400 | ~1 100 | 4.2 s |
| `dream()` — 1 session, 0 existing | `gpt-4o-mini` | ~2 100 | ~280 | 1.8 s |
| `recall()` — 50 headers | `gpt-4o-mini` (scoring) | ~3 500 | ~30 | 680 ms |
| `recall()` — 200 headers | `gpt-4o-mini` (scoring) | ~13 200 | ~30 | 1 250 ms |

For comparison, with `claude-3-5-haiku-20241022` as the scoring model
and `claude-sonnet-4-20250514` as the consolidator:

| Operation | Model | Wall time (p50) |
|---|---|---|
| `dream()` — 10 sessions, 50 existing | Sonnet 4 | 6.8 s |
| `recall()` — 50 headers | Haiku 3.5 | 540 ms |

Sonnet 4 consolidations are slower but produce cleaner action lists in
qualitative testing — fewer redundant creates, better summaries.

---

## 4. Cost model (USD, OpenAI pricing as of 2026-04)

| Usage | Monthly consolidations | Monthly recalls | Est. monthly cost |
|---|---|---|---|
| Dev (1 user, minHours: 1) | ~720 | ~1 000 | ~$0.85 |
| Small prod (20 users, 24h gate) | ~600 | ~18 000 | ~$2.40 |
| Medium prod (1 000 users, 24h gate) | ~30 000 | ~900 000 | ~$120 |

Bottom line: the scoring-model split keeps recall cost flat while the
per-user consolidation cost stays below $0.01/user/month for typical
usage.

---

## 5. How to reproduce

```bash
git clone https://github.com/shubham-dusane/dream-memory
cd dream-memory
npm install
cd packages/dream-core
npm run build
cd ../..
node --experimental-vm-modules benchmarks/bench.js
```

For LLM-bound numbers you'll need an OpenAI or Anthropic API key and
to write a small harness that calls `dream.dream()` and `dream.recall()`
with seeded data. Out of scope for the default bench suite because it
incurs real API cost.

---

## 6. Caveats

- Numbers are p50 on a specific machine. Your SSD, filesystem, and
  CPU will vary by 2–5×.
- LLM wall times include network RTT — a user in Asia hitting
  `api.openai.com` in US-East will see +100–200ms per call.
- The scoring-model call is inherently variable because the model can
  return lists of different lengths. Times above assume "returns
  2–5 IDs."
- Results assume the store is on a fast local disk. Memory files on a
  network filesystem (NFS, SMB) will be 5–50× slower on writes.
