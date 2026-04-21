# Usage Guide

> Three end-to-end scenarios showing how Dream Memory fits into a real
> agent. Copy, paste, adapt.

Each scenario is self-contained. Pick the one that matches your stack.

- [Scenario 1 — Local Ollama, filesystem store](#scenario-1--local-ollama-filesystem-store)
- [Scenario 2 — OpenAI agent with event observability](#scenario-2--openai-agent-with-event-observability)
- [Scenario 3 — Anthropic assistant with custom Redis adapter](#scenario-3--anthropic-assistant-with-custom-redis-adapter)

---

## Install

```bash
npm install @dream-memory/core
```

Node ≥ 18. ESM only. Zero runtime deps.

Add `.dream/` to your `.gitignore`:

```
.dream/
```

---

## Scenario 1 — Local Ollama, filesystem store

Goal: zero-cost memory for a local dev agent. Uses Ollama's
OpenAI-compatible endpoint.

### Prerequisites

```bash
ollama pull llama3.1:8b        # heavy model
ollama pull llama3.2:3b         # cheap scoring model
ollama serve                    # starts on :11434
```

### Setup

```ts
import { Dream } from '@dream-memory/core'

const dream = new Dream({
  llm: {
    provider: 'openai',                      // OpenAI-compatible dialect
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',                        // Ollama ignores the key, but one must be set
    model: 'llama3.1:8b',
    scoringModel: 'llama3.2:3b',
  },
  store: {
    type: 'filesystem',
    path: '.dream',
  },
  schedule: {
    minHours: 1,          // relaxed for dev
    minSessions: 2,
  },
  debug: true,
})
```

### Per-turn loop

```ts
async function chat(userText: string) {
  const context = await dream.recallAsContext(userText)

  const response = await ollamaChat({
    system: `You are a helpful assistant.\n\n${context}`,
    user: userText,
  })

  await dream.logSession([
    { role: 'user', content: userText },
    { role: 'assistant', content: response },
  ])

  // Fire-and-forget dream — respects gates, won't run every turn
  dream.dream().catch(() => {})

  return response
}
```

### What happens on disk

After 5–10 turns you'll see files appearing in `.dream/memories/`:

```
.dream/
├── MEMORY.md
├── .sessions.json
└── memories/
    └── a7f3…md   # e.g. "user prefers concise responses"
```

No API bill. Everything stays local.

---

## Scenario 2 — OpenAI agent with event observability

Goal: production agent with observability. Track consolidation cost
and memory writes in real time.

### Setup

```ts
import { Dream } from '@dream-memory/core'
import { metrics } from './your-metrics-lib'

const dream = new Dream({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    scoringModel: 'gpt-4o-mini',              // same model, lower-cost path
  },
  store: {
    type: 'filesystem',
    path: '/var/lib/myapp/dream',
  },
  schedule: {
    minHours: 24,
    minSessions: 5,
  },
  consolidation: {
    maxMemories: 200,
    maxRelevantMemories: 5,
  },
})

// Wire events to your metrics system
dream.onEvent((event) => {
  switch (event.type) {
    case 'dream:start':
      metrics.increment('dream.start', { sessions: event.sessionCount })
      break
    case 'dream:memory:created':
      metrics.increment('dream.memory.created', { type: event.memory.type })
      break
    case 'dream:memory:updated':
      metrics.increment('dream.memory.updated')
      break
    case 'dream:memory:pruned':
      metrics.increment('dream.memory.pruned', { reason: event.reason })
      break
    case 'dream:complete':
      metrics.timing('dream.duration_ms', event.result.durationMs)
      metrics.gauge('dream.memories_total',
        event.result.memoriesScanned +
        event.result.memoriesCreated -
        event.result.memoriesPruned)
      break
    case 'dream:error':
      metrics.increment('dream.error')
      console.error('[dream]', event.error)
      break
  }
})
```

### Per-request handler (Express)

```ts
app.post('/chat', async (req, res) => {
  const { userId, message } = req.body

  const memories = await dream.recall(message)
  const context = memories
    .map((m) => `- ${m.name}: ${m.content}`)
    .join('\n')

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: `Relevant context:\n${context}` },
      { role: 'user', content: message },
    ],
  })

  const reply = response.choices[0].message.content ?? ''

  await dream.logSession([
    { role: 'user', content: message },
    { role: 'assistant', content: reply },
  ])

  res.json({ reply })
})

// Start the background dream loop (hourly ticks, consolidates when due)
dream.startAutoSchedule()

// Graceful shutdown
process.on('SIGTERM', () => dream.stopAutoSchedule())
```

### Cost profile

With 20 users × 30 sessions/day × 50-memory store:
- Consolidation: ~1 pass/user/day × $0.001 each = **~$0.60/day**
- Recall: 600 calls/day × $0.0001 each = **~$0.06/day**

---

## Scenario 3 — Anthropic assistant with custom Redis adapter

Goal: multi-process deployment. Memory lives in Redis so multiple
app instances can share it.

### Implement the adapter

```ts
import Redis from 'ioredis'
import type {
  MemoryStoreAdapter,
  Memory,
  MemoryHeader,
} from '@dream-memory/core'

export class RedisStore implements MemoryStoreAdapter {
  constructor(private redis: Redis, private prefix = 'dream:') {}

  private key(parts: string[]) { return `${this.prefix}${parts.join(':')}` }

  async get(id: string): Promise<Memory | null> {
    const raw = await this.redis.get(this.key(['memory', id]))
    return raw ? JSON.parse(raw) : null
  }

  async set(memory: Memory): Promise<void> {
    const json = JSON.stringify(memory)
    await this.redis
      .multi()
      .set(this.key(['memory', memory.id]), json)
      .hset(this.key(['headers']), memory.id, JSON.stringify({
        id: memory.id,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      }))
      .exec()
  }

  async delete(id: string): Promise<void> {
    await this.redis
      .multi()
      .del(this.key(['memory', id]))
      .hdel(this.key(['headers']), id)
      .exec()
  }

  async listHeaders(): Promise<MemoryHeader[]> {
    const all = await this.redis.hvals(this.key(['headers']))
    return all.map((s) => JSON.parse(s))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async list(): Promise<Memory[]> {
    const headers = await this.listHeaders()
    const results = await Promise.all(headers.map((h) => this.get(h.id)))
    return results.filter((m): m is Memory => m !== null)
  }

  async getLastConsolidatedAt(): Promise<number> {
    const v = await this.redis.get(this.key(['lastConsolidatedAt']))
    return v ? Number(v) : 0
  }

  async setLastConsolidatedAt(ts: number): Promise<void> {
    await this.redis.set(this.key(['lastConsolidatedAt']), String(ts))
  }

  async logSession(id: string): Promise<void> {
    await this.redis.zadd(this.key(['sessions']), Date.now(), id)
    // keep last 1000
    await this.redis.zremrangebyrank(this.key(['sessions']), 0, -1001)
  }

  async countSessionsSince(ts: number): Promise<number> {
    return this.redis.zcount(this.key(['sessions']), ts, '+inf')
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`)
    if (keys.length > 0) await this.redis.del(...keys)
  }
}
```

### Wire it up

```ts
import { Dream } from '@dream-memory/core'
import Redis from 'ioredis'
import { RedisStore } from './RedisStore'

const redis = new Redis(process.env.REDIS_URL!)

const dream = new Dream({
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-20250514',
    scoringModel: 'claude-3-5-haiku-20241022',
  },
  store: {
    type: 'custom',
    adapter: new RedisStore(redis, 'myapp:dream:'),
  },
})
```

### Distributed `dream()` — elect a single worker

Multiple processes, one consolidator. Use Redis as a lock:

```ts
async function tryDream() {
  // 60-second lock. Only one process wins.
  const ok = await redis.set('myapp:dream:lock', process.pid, 'NX', 'EX', 60)
  if (!ok) return

  try {
    await dream.dream()
  } finally {
    await redis.del('myapp:dream:lock')
  }
}

setInterval(tryDream, 60 * 60 * 1000)   // hourly tick, guarded
```

Alternative: designate one `DREAM_WORKER=1` env var and only start
`startAutoSchedule()` in that pod.

---

## Patterns worth knowing

### Bypassing the LLM with `remember()`

You already know the fact. Don't pay for consolidation:

```ts
await dream.remember({
  name: 'User timezone',
  description: 'User is in Asia/Kolkata (UTC+5:30)',
  type: 'user',
  content: 'User lives in Pune, India. Timezone: Asia/Kolkata. Assume IST for all time references.',
})
```

### Forcing a dream immediately

```ts
const result = await dream.dream(true)    // bypasses gates
console.log(result.summary)
```

Useful for tests, or after an explicit "save what you've learned" user action.

### Preformatted context injection

```ts
const context = await dream.recallAsContext(userMessage)
// context is already wrapped in "## Relevant Memories" Markdown —
// drop it directly into your system prompt
```

### Clearing everything

```ts
await dream.forget(id)                    // one memory
// No built-in nuke. Call store.clear() if you really need:
await (dream as any).store.clear()
```

---

## Debugging checklist

Something isn't working? In order:

1. **Set `debug: true`** in the config. Every phase is logged.
2. **Subscribe to events.** `dream.onEvent(console.log)` tells you exactly what the consolidator did.
3. **Check `.dream/.sessions.json`** — is your session being logged?
4. **Check `.dream/memories/`** — are files appearing? With the right frontmatter?
5. **Run `dream.shouldDream()`** — are the gates blocking you? Pass `force=true` to skip.
6. **Tail your LLM provider's logs** — is the consolidation prompt even being sent?

Common gotcha: you called `logSession` 3 times but `minSessions: 5`, so
`dream()` silently no-ops. Either lower the gate or pass `force=true`.

---

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the pieces fit
- [`DATA_FLOW.md`](./DATA_FLOW.md) — what happens when you call each method
- [`SECURITY.md`](./SECURITY.md) — don't skip this if you ingest untrusted sessions
- [`FAQ.md`](./FAQ.md) — answers to common questions and critiques
