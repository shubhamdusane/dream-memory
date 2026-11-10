# Benchmark Results

> Output of `benchmarks/bench.ts` (non-LLM filesystem paths only). No LLM or network calls were measured. An earlier version of this file claimed macOS/M1 numbers and LLM latency/cost tables; those were not reproducible and have been removed.

## Run environment (measured 2026-11-10/11)

| | |
|---|---|
| OS | Windows 11 Pro |
| CPU / RAM | Intel Core i5-7300U (2 cores / 4 threads), 7.8 GB |
| Disk | SSD, NTFS (Windows temp dir; real-time antivirus active, other processes running) |
| Node | v22.12.0 |
| Package | @dream-memory/core 0.1.2 |

**These numbers are slow and noisy**: per-file filesystem operations on this laptop (with antivirus scanning) cost 100s of ms. Do not read them as a property of the library on typical hardware; run `npm run bench` yourself.

## Run A: BENCH_SCALE=0.2 (complete; iteration counts are 20% of default, min 20)

```
remember() — 1 write              iters=  100  mean=  197.26ms  p50=  181.97ms  p95=  440.68ms  p99=  542.65ms
listHeaders() — 50 memories       iters=   40  mean=  241.08ms  p50=  230.70ms  p95=  482.89ms  p99=  509.11ms
listHeaders() — 200 memories      iters=   40  mean=  367.47ms  p50=  377.83ms  p95=  653.78ms  p99=  915.75ms
get() — cold(ish) read            iters=  100  mean=   12.99ms  p50=    0.71ms  p95=   63.57ms  p99=  151.45ms
forget() — single delete          iters=   40  mean=  628.42ms  p50=  609.20ms  p95= 1077.14ms  p99= 1217.76ms
logSession() — append             iters=  100  mean=   42.97ms  p50=   35.25ms  p95=   96.41ms  p99=  193.86ms
frontmatter — spicy round-trip    iters=  100  mean=  520.85ms  p50=  451.34ms  p95=  999.16ms  p99= 1324.22ms
```

## Run B: full iteration counts (interrupted after 4 of 7 benchmarks)

```
remember() — 1 write              iters=  500  mean=  238.87ms  p50=  157.01ms  p95=  617.51ms  p99=  897.90ms
listHeaders() — 50 memories       iters=  200  mean=  445.10ms  p50=  433.49ms  p95=  735.77ms  p99=  946.72ms
listHeaders() — 200 memories      iters=  200  mean=  538.23ms  p50=  421.02ms  p95= 1210.28ms  p99= 1826.37ms
get() — cold(ish) read            iters=  500  mean=    5.86ms  p50=    0.69ms  p95=   39.59ms  p99=   90.54ms
```

## Reading the numbers honestly

- `remember()`/`forget()`/frontmatter round-trip are one or more file writes; on this machine each costs roughly 0.2-0.6 s at the mean. Reads of an already-cached file (`get()`) are sub-ms at p50 but have a heavy tail.
- `listHeaders()` reads every memory file, so it grows with store size (about 0.24 s at 50 memories, 0.37-0.54 s at 200 here).
- No claim is made about "sub-millisecond overhead"; on this hardware that was not observed for writes.
- LLM-bound operations (`dream()`, scored `recall()`) and cost estimates are not measured in this repo.

## Reproduce

```bash
git clone https://github.com/shubhamdusane/dream-memory
cd dream-memory
npm ci --ignore-scripts
npm run bench                  # Node >= 22.6; BENCH_SCALE=0.2 npm run bench for a quicker run
```
