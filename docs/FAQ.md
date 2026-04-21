# FAQ

> Honest answers to the questions people actually ask — including the
> unflattering ones.

---

## "Isn't this just a vibe-coded wrapper around an LLM?"

Short answer: no, but I see why someone skimming would think that.

Long answer: the library implements a specific architectural pattern —
the 4-phase consolidation cycle with a two-model retrieval split —
that mirrors what production memory systems (including the one inside
Claude Code) do. The value isn't in the LLM call. It's in:

- Deciding *when* to call (scheduler gates, so you don't burn tokens on every turn).
- Deciding *what* to send (only headers to the scoring model, saves ~10× tokens per recall).
- Deciding *what to persist* (structured create/update/delete actions, not free-form notes).
- Defending the pipeline (prompt injection, path traversal, frontmatter injection, race conditions — all covered with tests).

If you strip the architecture away and just pass transcripts to an LLM,
you get back mush. The consolidator's prompt and phase structure is
doing real work.

---

## "Why an Ollama reference? Ollama is just a wrapper."

Because Ollama is the lowest-friction way for someone to try the
library without an API bill. That's the whole reason.

The library doesn't depend on Ollama. It speaks the OpenAI-compatible
`/chat/completions` dialect, which happens to be what Ollama, LM
Studio, LocalAI, vLLM, Together, OpenRouter, and everything else
implements. "Works with Ollama" is equivalent to "works with every
local-inference stack that ships a chat endpoint."

The README calls out Ollama by name because it's the example most
readers recognize. That's a docs choice, not an architectural one.

---

## "The default model is old."

It was. v0.1.2 bumped the Anthropic defaults:

- `model: 'claude-sonnet-4-20250514'`
- `scoringModel: 'claude-3-5-haiku-20241022'`

OpenAI defaults remain `gpt-4o-mini` for both — it's still the
price/performance sweet spot for this workload. You override any of
these via config:

```ts
new Dream({
  llm: {
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',     // if you want to pay for it
    scoringModel: 'claude-3-5-haiku-20241022',
  },
  // ...
})
```

---

## "Why would I use this instead of just a vector DB?"

Different tool, different job.

| | Vector DB | Dream Memory |
|---|---|---|
| Retrieval | Similarity search | LLM-scored relevance |
| Write strategy | Embed every chunk | Consolidate into named memories |
| Result shape | Top-K similar fragments | 1–5 curated, named facts |
| Best for | Large document corpora | Ongoing relationship with one user/agent |
| Latency | ~5ms per query | ~500–900ms per recall (LLM call) |
| Cost at scale | Storage + embedding tokens | Per-turn scoring model calls |

Use a vector DB when you have a static knowledge base. Use Dream
Memory when the "knowledge" is the evolving state of a conversation
and you need a model to decide what's worth keeping.

They compose fine — use the vector DB for your docs, Dream Memory
for the user's preferences and project state.

---

## "Why a scheduler? I want memory to update every turn."

Because consolidation is an LLM call. If you run it every turn you
pay 2× per message (the turn itself + consolidation) and most turns
don't have new signal worth persisting.

The scheduler's two gates (time + session count) keep the pipeline
cheap while ensuring memories stay fresh. Defaults (24h / 5 sessions)
are a starting point — tune them down to `{minHours: 1, minSessions: 2}`
in development, or up in production if your sessions are expensive.

You can always force immediate consolidation with `dream.dream(true)`.

---

## "I want to see the memory — where is it?"

Filesystem store: `.dream/memories/{id}.md` — one Markdown file per memory.

```bash
cat .dream/MEMORY.md                 # human-readable index
ls .dream/memories/                   # list all memories
cat .dream/memories/*.md | less       # read them all
```

Each file has YAML frontmatter (name, description, type, timestamps)
and Markdown content. You can edit them by hand. The consolidator
will respect your edits on the next pass (it reads before writing).

---

## "Can I use this without an LLM?"

Partially. `remember()` and `forget()` bypass the LLM entirely — you
can build your own consolidation logic and just use Dream Memory as
the storage + retrieval layer. You lose `dream()` and `recall()` (the
two LLM-dependent methods) but keep the file format, the adapter
interface, and the `onEvent` observability.

---

## "What about multi-user? Per-user memory?"

One Dream instance = one memory scope. For per-user memory:

```ts
const dreams = new Map<UserId, Dream>()

function getDream(userId: string) {
  let d = dreams.get(userId)
  if (!d) {
    d = new Dream({
      llm: sharedLlmConfig,
      store: {
        type: 'filesystem',
        path: `/var/lib/myapp/dream/${userId}`,
      },
    })
    dreams.set(userId, d)
  }
  return d
}
```

For thousands of users, use a Redis adapter (see
[USAGE_GUIDE §Scenario 3](./USAGE_GUIDE.md#scenario-3--anthropic-assistant-with-custom-redis-adapter))
and namespace by userId in the Redis keys.

---

## "Memories keep getting out of date. How do I fix that?"

Two answers:

1. **Let the consolidator do its job.** Phase 4 (Prune) specifically
   looks for contradicted memories and deletes them. If you're running
   `dream()` frequently enough, stale memories die naturally.

2. **Force a refresh.** Delete all memories and re-consolidate from
   session history:
   ```ts
   const memories = await (dream as any).store.list()
   for (const m of memories) await dream.forget(m.id)
   await dream.dream(true)
   ```

---

## "Why MIT? Why open source?"

Because memory is infrastructure, and infrastructure shouldn't be
locked up. Every agent framework needs this. I'd rather the pattern
be reusable than vendor-locked.

---

## "Is this production-ready?"

v0.1.x is **stable for single-process deployments with trusted input.**

Known limits:
- No cross-process locking in `FileSystemStore`.
- No built-in PII scrubbing.
- No authentication or authorization.

If your deployment is single-process, session transcripts come from
authenticated users, and you're OK with memories being plaintext on
disk, you're good.

For multi-process: implement a custom adapter with advisory locks.
See [USAGE_GUIDE §Scenario 3](./USAGE_GUIDE.md#scenario-3--anthropic-assistant-with-custom-redis-adapter).

For high-security: review [SECURITY.md](./SECURITY.md) before committing.

v1.0 will freeze the public API. Everything before that may change
between minor versions — read the changelog.

---

## "Where can I contribute?"

- Open issues for bugs or feature requests.
- PRs welcome — run `npm test` before submitting.
- Doc improvements are especially welcome. If something in this doc
  suite is unclear, that's a bug.

---

## "Who built this?"

One developer, scratching an itch. Not a startup, not a team, not
"AI-first"ᵀᴹ. The code is the code. Read it and decide for yourself.
