import { randomUUID } from 'crypto'
import type {
  DreamConfig,
  DreamResult,
  Memory,
  MemoryType,
  Session,
  SessionMessage,
  DreamEvent,
  MemoryStoreAdapter,
} from './types/index.js'
import { FileSystemStore, InMemoryStore } from './store/filesystem.js'
import { LLMClient } from './utils/llm.js'
import { Consolidator } from './consolidator/consolidator.js'
import { Scheduler } from './scheduler/scheduler.js'

/**
 * Dream Memory — open source memory consolidation for AI systems.
 *
 * Inspired by Anthropic's internal memory architecture (Claude Code, 2026).
 *
 * @example
 * ```typescript
 * import { Dream } from '@dream-memory/core'
 *
 * const dream = new Dream({
 *   llm: { model: 'gpt-4o-mini', provider: 'openai' }
 * })
 *
 * // Log a session
 * await dream.logSession([
 *   { role: 'user', content: 'I prefer TypeScript over JavaScript' },
 *   { role: 'assistant', content: 'Got it, I will use TypeScript.' }
 * ])
 *
 * // Trigger a dream pass (consolidates memories)
 * const result = await dream.dream()
 * console.log(result.summary)
 *
 * // Later: find relevant memories for a query
 * const memories = await dream.recall('What does the user prefer?')
 * ```
 */
export class Dream {
  private readonly store: MemoryStoreAdapter
  private readonly llm: LLMClient
  private readonly consolidator: Consolidator
  private readonly scheduler: Scheduler
  private currentSession: Session | null = null

  constructor(config: DreamConfig) {
    // Initialize storage
    if (config.store?.type === 'memory') {
      this.store = new InMemoryStore()
    } else if (config.store?.type === 'custom' && config.store.adapter) {
      this.store = config.store.adapter
    } else {
      this.store = new FileSystemStore(config.store?.path ?? '.dream')
    }

    // Initialize LLM client
    this.llm = new LLMClient(config.llm)

    // Initialize consolidator
    this.consolidator = new Consolidator({
      llm: this.llm,
      store: this.store,
      config: config.consolidation,
      debug: config.debug,
    })

    // Initialize scheduler
    this.scheduler = new Scheduler(this.store, config.schedule)
  }

  // ─── Session Management ──────────────────────────────────────────────────

  /**
   * Start a new session. Returns a session ID.
   * All subsequent addMessage() calls go to this session.
   */
  startSession(metadata?: Record<string, unknown>): string {
    const sessionId = randomUUID()
    this.currentSession = {
      id: sessionId,
      messages: [],
      startedAt: Date.now(),
      metadata,
    }
    return sessionId
  }

  /**
   * Add a message to the current session.
   */
  addMessage(message: SessionMessage): void {
    if (!this.currentSession) {
      this.startSession()
    }
    this.currentSession!.messages.push(message)
  }

  /**
   * End the current session and log it to the store.
   * This increments the session count used by the dream gate.
   */
  async endSession(): Promise<string> {
    if (!this.currentSession) {
      throw new Error('No active session. Call startSession() first.')
    }

    const session = this.currentSession
    session.endedAt = Date.now()
    this.currentSession = null

    await this.store.logSession(session.id)
    // Queue message content for the next dream pass.
    // Fix for silent data loss bug where endSession() counted the session
    // but never queued its messages for consolidation.
    this._pendingSessions.push(session)
    return session.id
  }

  /**
   * Log a complete session at once (shorthand for start + messages + end).
   *
   * @param messages - The conversation messages to log
   * @param metadata - Optional metadata about the session
   * @returns The session ID
   */
  async logSession(
    messages: SessionMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const sessionId = randomUUID()
    await this.store.logSession(sessionId)

    // Store the session for potential dreaming
    const session: Session = {
      id: sessionId,
      messages,
      startedAt: Date.now(),
      endedAt: Date.now(),
      metadata,
    }

    // Keep in memory for the next dream pass
    this._pendingSessions.push(session)

    return sessionId
  }

  // Pending sessions waiting for consolidation
  private _pendingSessions: Session[] = []

  // ─── Dream Pass ─────────────────────────────────────────────────────────

  /**
   * Trigger a dream consolidation pass.
   *
   * The dream pass runs the 4-phase cycle:
   * 1. Orient  — understand existing memories
   * 2. Gather  — identify new signal in sessions
   * 3. Consolidate — create/update memories
   * 4. Prune   — remove stale memories
   *
   * @param force - Skip time/session gates and dream immediately
   * @returns DreamResult with stats and LLM summary
   */
  async dream(force = false): Promise<DreamResult> {
    if (!force) {
      const gate = await this.scheduler.shouldTrigger()
      if (!gate.shouldDream) {
        return {
          success: true,
          phase: 'orient',
          memoriesScanned: 0,
          memoriesCreated: 0,
          memoriesUpdated: 0,
          memoriesPruned: 0,
          durationMs: 0,
          summary: `Dream skipped: ${gate.reason}`,
          completedAt: Date.now(),
        }
      }
    }

    // Snapshot pending sessions but DO NOT clear yet.
    // If the consolidator throws (network failure, rate limit, etc.),
    // we must keep the sessions so the next dream() can retry them.
    const sessions = [...this._pendingSessions]

    let result: DreamResult
    try {
      result = await this.consolidator.run(sessions)
    } catch (err) {
      // Propagate — sessions remain in _pendingSessions for retry.
      throw err
    }

    if (result.success) {
      // Only drain pending after successful consolidation.
      // Remove exactly the sessions we snapshot-ed (preserves any new
      // sessions that arrived mid-consolidation).
      const consumed = new Set(sessions.map((s) => s.id))
      this._pendingSessions = this._pendingSessions.filter(
        (s) => !consumed.has(s.id),
      )
      await this.scheduler.recordConsolidation()
    }

    return result
  }

  /**
   * Check whether a dream pass should be triggered based on current gates.
   */
  async shouldDream(): Promise<{
    should: boolean
    reason: string
    hoursSinceLastDream: number
    sessionsSinceLastDream: number
  }> {
    const gate = await this.scheduler.shouldTrigger()
    return {
      should: gate.shouldDream,
      reason: gate.reason,
      hoursSinceLastDream: gate.hoursSinceLastDream,
      sessionsSinceLastDream: gate.sessionsSinceLastDream,
    }
  }

  // ─── Memory Retrieval ────────────────────────────────────────────────────

  /**
   * Find memories relevant to a query.
   *
   * Uses the two-model pattern: a lightweight scoring model
   * filters which memories to load before the main model sees them.
   *
   * @param query - Natural language query
   * @param opts.recentTools - Tools recently used (avoids surfacing usage docs)
   * @returns Up to 5 relevant memories, scored by relevance
   */
  async recall(
    query: string,
    opts?: { recentTools?: string[] },
  ): Promise<Memory[]> {
    return this.consolidator.findRelevant(query, opts)
  }

  /**
   * Format memories as a context block for injection into LLM prompts.
   *
   * @example
   * ```typescript
   * const context = await dream.recallAsContext('How should I format code?')
   * const response = await openai.chat.completions.create({
   *   messages: [
   *     { role: 'system', content: `${baseSystemPrompt}\n\n${context}` },
   *     { role: 'user', content: userMessage }
   *   ]
   * })
   * ```
   */
  async recallAsContext(
    query: string,
    opts?: { recentTools?: string[] },
  ): Promise<string> {
    const memories = await this.recall(query, opts)
    if (memories.length === 0) return ''

    const lines = [
      '## Relevant memories from previous sessions',
      '',
      ...memories.map((m) => {
        const typeLabel =
          {
            user: '👤 User preference',
            feedback: '💡 Feedback',
            project: '📋 Project context',
            reference: '🔗 Reference',
          }[m.type] ?? '📝 Memory'

        return [`### ${typeLabel}: ${m.name}`, m.content, ''].join('\n')
      }),
    ]

    return lines.join('\n')
  }

  // ─── Memory Management ───────────────────────────────────────────────────

  /**
   * Save a memory directly (without a dream pass).
   * Use this for explicit memory creation.
   */
  async remember(opts: {
    name: string
    description: string
    content: string
    type: MemoryType
    metadata?: Record<string, unknown>
  }): Promise<Memory> {
    const now = Date.now()
    const memory: Memory = {
      id: randomUUID(),
      ...opts,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.set(memory)
    return memory
  }

  /**
   * Delete a specific memory by ID.
   */
  async forget(id: string): Promise<void> {
    await this.store.delete(id)
  }

  /**
   * List all memories, optionally filtered by type.
   */
  async listMemories(filter?: { type?: MemoryType }): Promise<Memory[]> {
    return this.store.list(filter)
  }

  /**
   * Get a specific memory by ID.
   */
  async getMemory(id: string): Promise<Memory | null> {
    return this.store.get(id)
  }

  /**
   * Clear all memories. Use with caution.
   */
  async clearAll(): Promise<void> {
    await this.store.clear()
    this._pendingSessions = []
  }

  // ─── Auto-scheduling ─────────────────────────────────────────────────────

  /**
   * Start automatic background dreaming.
   * dream will check the gate every 5 minutes and trigger a pass when ready.
   *
   * @param onResult - Called with the result after each dream pass
   */
  startAutoSchedule(onResult?: (result: DreamResult) => void): void {
    this.scheduler.startAutoSchedule(async () => {
      const result = await this.dream(true)
      onResult?.(result)
    })
  }

  /**
   * Stop automatic background dreaming.
   */
  stopAutoSchedule(): void {
    this.scheduler.stopAutoSchedule()
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  /**
   * Listen to dream events for observability.
   *
   * @example
   * ```typescript
   * dream.onEvent((event) => {
   *   if (event.type === 'dream:complete') {
   *     console.log(`Dream complete: ${event.result.summary}`)
   *   }
   * })
   * ```
   */
  onEvent(handler: (event: DreamEvent) => void): () => void {
    return this.consolidator.onEvent(handler)
  }

  // ─── Storage Access ───────────────────────────────────────────────────────

  /**
   * Direct access to the underlying store.
   * Use for custom integrations.
   */
  get rawStore(): MemoryStoreAdapter {
    return this.store
  }
}

// ─── Convenience Factory ─────────────────────────────────────────────────────

/**
 * Create a Dream instance with OpenAI.
 *
 * @example
 * ```typescript
 * const dream = createDream.openai({ model: 'gpt-4o-mini' })
 * ```
 */
export const createDream = {
  openai(opts: {
    model?: string
    apiKey?: string
    storePath?: string
    debug?: boolean
  }): Dream {
    return new Dream({
      llm: {
        model: opts.model ?? 'gpt-4o-mini',
        provider: 'openai',
        apiKey: opts.apiKey,
        scoringModel: 'gpt-4o-mini',
      },
      store: { type: 'filesystem', path: opts.storePath ?? '.dream' },
      debug: opts.debug,
    })
  },

  anthropic(opts: {
    model?: string
    apiKey?: string
    storePath?: string
    debug?: boolean
  }): Dream {
    return new Dream({
      llm: {
        // Default to Claude Sonnet 4 (Apr 2026 GA) for consolidation quality,
        // Haiku 3.5 for cheap scoring pass. Override via opts.model.
        model: opts.model ?? 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        apiKey: opts.apiKey,
        scoringModel: 'claude-3-5-haiku-20241022',
      },
      store: { type: 'filesystem', path: opts.storePath ?? '.dream' },
      debug: opts.debug,
    })
  },

  local(opts: {
    model: string
    baseURL?: string
    storePath?: string
    debug?: boolean
  }): Dream {
    return new Dream({
      llm: {
        model: opts.model,
        provider: 'openai',
        baseURL: opts.baseURL ?? 'http://localhost:11434/v1',
        apiKey: 'ollama',
      },
      store: { type: 'filesystem', path: opts.storePath ?? '.dream' },
      debug: opts.debug,
    })
  },

  inMemory(opts: { model: string; apiKey?: string }): Dream {
    return new Dream({
      llm: { model: opts.model, provider: 'openai', apiKey: opts.apiKey },
      store: { type: 'memory' },
    })
  },
}
