/**
 * Dream Memory — micro-benchmark harness.
 *
 * Measures the non-LLM hot paths:
 *   - remember()           : write one memory (disk I/O + serialize)
 *   - recall scoring prep  : listHeaders() + prompt build (no network)
 *   - forget()             : path validation + unlink
 *   - logSession()         : append to .sessions.json
 *   - frontmatter parse    : serialize + deserialize round-trip
 *
 * LLM-bound paths (dream, recall-with-network) are NOT benchmarked here.
 * Run (Node >= 22.6, from the repo root):
 *   npm ci --ignore-scripts
 *   npm run bench
 *
 * Paste the output, plus your machine details, into benchmarks/results.md.
 */

import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'

import { FileSystemStore } from '../packages/dream-core/dist/store/filesystem.js'
import type { Memory } from '../packages/dream-core/dist/types/index.js'

interface Stats {
  p50: number
  p95: number
  p99: number
  mean: number
  min: number
  max: number
  iters: number
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    iters: sorted.length,
  }
}

function fmt(s: Stats): string {
  const f = (n: number) => n.toFixed(2).padStart(8)
  return `iters=${String(s.iters).padStart(5)}  mean=${f(s.mean)}ms  p50=${f(s.p50)}ms  p95=${f(s.p95)}ms  p99=${f(s.p99)}ms`
}

const SCALE = Number(process.env.BENCH_SCALE ?? '1')

async function bench(name: string, itersFull: number, fn: () => Promise<void>): Promise<Stats> {
  // BENCH_SCALE (e.g. 0.2) shrinks iteration counts on slow filesystems
  const iters = Math.max(20, Math.round(itersFull * SCALE))
  // Warm-up — exclude from stats
  for (let i = 0; i < Math.min(10, iters); i++) await fn()

  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  const s = stats(samples)
  console.log(`${name.padEnd(32)}  ${fmt(s)}`)
  return s
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now()
  return {
    id: randomUUID(),
    name: 'User prefers TypeScript over JavaScript',
    description: 'Repeated preference across 4 sessions',
    type: 'user',
    content:
      'User consistently chose TypeScript when asked. Reason: type safety and tooling. ' +
      'How to apply: default to TypeScript in all new projects unless explicitly requested otherwise.',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'dream-bench-'))
  const store = new FileSystemStore(tmp)

  console.log('─'.repeat(90))
  console.log(`Dream Memory — non-LLM micro-benchmarks`)
  console.log(`Node: ${process.version}  Platform: ${process.platform}  BENCH_SCALE=${SCALE}`)
  console.log('─'.repeat(90))

  // ── 1. remember() — single write ───────────────────────────────────────────
  await bench('remember() — 1 write', 500, async () => {
    await store.set(makeMemory())
  })

  // ── 2. listHeaders() at 50 memories ────────────────────────────────────────
  const bulk50Ids: string[] = []
  for (let i = 0; i < 50; i++) {
    const m = makeMemory({ name: `Memory ${i}` })
    bulk50Ids.push(m.id)
    await store.set(m)
  }
  await bench('listHeaders() — 50 memories', 200, async () => {
    await store.listHeaders()
  })

  // ── 3. listHeaders() at 200 memories ───────────────────────────────────────
  const bulk200Ids: string[] = [...bulk50Ids]
  for (let i = 50; i < 200; i++) {
    const m = makeMemory({ name: `Memory ${i}` })
    bulk200Ids.push(m.id)
    await store.set(m)
  }
  await bench('listHeaders() — 200 memories', 200, async () => {
    await store.listHeaders()
  })

  // ── 4. get() — single read ─────────────────────────────────────────────────
  const readTarget = bulk200Ids[100]
  await bench('get() — cold(ish) read', 500, async () => {
    await store.get(readTarget)
  })

  // ── 5. forget() — single delete ────────────────────────────────────────────
  // Pre-populate a pool to delete
  const delPool: string[] = []
  for (let i = 0; i < 500; i++) {
    const m = makeMemory({ name: `Del ${i}` })
    delPool.push(m.id)
    await store.set(m)
  }
  let delIdx = 0
  await bench('forget() — single delete', 200, async () => {
    await store.delete(delPool[delIdx++])
  })

  // ── 6. logSession() — append to sessions.json ──────────────────────────────
  await bench('logSession() — append', 500, async () => {
    await store.logSession(randomUUID())
  })

  // ── 7. Frontmatter round-trip with colons ──────────────────────────────────
  const spicyMemory = makeMemory({
    name: 'API reference: https://api.example.com/v1',
    description: 'Payment API: v2 docs',
    content: 'Auth: Bearer token. Rate: 1000/min. See: docs.',
  })
  await store.set(spicyMemory)
  await bench('frontmatter — spicy round-trip', 500, async () => {
    await store.set(spicyMemory)
    await store.get(spicyMemory.id)
  })

  console.log('─'.repeat(90))

  // Cleanup
  rmSync(tmp, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
