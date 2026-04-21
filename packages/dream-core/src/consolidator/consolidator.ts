import { randomUUID } from 'crypto'
import type {
  Memory,
  MemoryHeader,
  DreamResult,
  DreamPhase,
  DreamEvent,
  ConsolidationConfig,
  Session,
  MemoryStoreAdapter,
} from '../types/index.js'
import { LLMClient } from '../utils/llm.js'
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  buildRelevanceScoringPrompt,
} from './prompts.js'

interface ConsolidationActions {
  create: Array<{
    name: string
    description: string
    type: Memory['type']
    content: string
  }>
  update: Array<{
    id: string
    description: string
    content: string
  }>
  delete: Array<{
    id: string
    reason: string
  }>
  summary: string
}

/**
 * Consolidator — the heart of the dream pass.
 *
 * Implements the 4-phase consolidation cycle:
 * 1. Orient  — load existing memory headers
 * 2. Gather  — prepare session transcripts
 * 3. Consolidate — call LLM, parse actions, write memories
 * 4. Prune   — delete stale memories
 *
 * The two-model pattern (from Anthropic's architecture):
 * - Main model: expensive consolidation decisions
 * - Scoring model: cheap relevance filtering per query
 */
export class Consolidator {
  private readonly llm: LLMClient
  private readonly store: MemoryStoreAdapter
  private readonly config: ConsolidationConfig
  private readonly debug: boolean
  // Additive handlers — multiple consumers can subscribe. Prior versions
  // stored a single handler that got overwritten on every subscribe.
  private eventHandlers: Array<(event: DreamEvent) => void> = []

  constructor(opts: {
    llm: LLMClient
    store: MemoryStoreAdapter
    config?: ConsolidationConfig
    debug?: boolean
  }) {
    this.llm = opts.llm
    this.store = opts.store
    this.config = opts.config ?? {}
    this.debug = opts.debug ?? false
  }

  /**
   * Subscribe to dream events. Returns an unsubscribe function.
   * Multiple subscribers are supported — they are invoked in registration
   * order. A handler that throws is caught and logged (in debug mode) so
   * one misbehaving observer cannot break the consolidation pass.
   */
  onEvent(handler: (event: DreamEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  private emit(event: DreamEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(event)
      } catch (err) {
        if (this.debug) {
          console.error(`[dream] event handler threw`, err)
        }
      }
    }
    if (this.debug) {
      console.log(`[dream] ${event.type}`, event)
    }
  }

  private log(msg: string): void {
    if (this.debug) console.log(`[dream:consolidator] ${msg}`)
  }

  /**
   * Run a full dream pass.
   *
   * @param sessions - Recent sessions to consolidate from
   * @returns DreamResult with stats and summary
   */
  async run(sessions: Session[]): Promise<DreamResult> {
    const startTime = Date.now()
    let phase: DreamPhase = 'orient'
    let memoriesScanned = 0
    let memoriesCreated = 0
    let memoriesUpdated = 0
    let memoriesPruned = 0

    try {
      this.emit({ type: 'dream:start', sessionCount: sessions.length })

      // ── Phase 1: Orient ─────────────────────────────────────────────────
      phase = 'orient'
      this.emit({ type: 'dream:phase', phase })
      this.log('Phase 1: Orient — loading existing memory headers')

      const existingHeaders = await this.store.listHeaders()
      memoriesScanned = existingHeaders.length
      this.log(`Found ${memoriesScanned} existing memories`)

      // ── Phase 2: Gather ─────────────────────────────────────────────────
      phase = 'gather'
      this.emit({ type: 'dream:phase', phase })
      this.log('Phase 2: Gather — preparing session transcripts')

      const transcripts = this.prepareTranscripts(sessions)
      this.log(`Prepared ${transcripts.length} session transcripts`)

      if (transcripts.length === 0 && existingHeaders.length === 0) {
        this.log('Nothing to consolidate — no sessions and no memories')
        return this.buildResult({
          success: true,
          phase: 'prune',
          memoriesScanned: 0,
          memoriesCreated: 0,
          memoriesUpdated: 0,
          memoriesPruned: 0,
          durationMs: Date.now() - startTime,
          summary: 'Nothing to consolidate — no sessions or memories found.',
        })
      }

      // ── Phase 3: Consolidate ─────────────────────────────────────────────
      phase = 'consolidate'
      this.emit({ type: 'dream:phase', phase })
      this.log('Phase 3: Consolidate — calling LLM for consolidation')

      const actions = await this.callConsolidationLLM(
        existingHeaders,
        transcripts,
      )

      // Execute create actions
      for (const action of actions.create) {
        const now = Date.now()
        const memory: Memory = {
          id: randomUUID(),
          name: action.name,
          description: action.description,
          content: action.content,
          type: action.type,
          createdAt: now,
          updatedAt: now,
        }
        await this.store.set(memory)
        memoriesCreated++
        this.emit({ type: 'dream:memory:created', memory })
        this.log(`Created memory: ${memory.name}`)
      }

      // Execute update actions
      for (const action of actions.update) {
        const existing = await this.store.get(action.id)
        if (!existing) {
          this.log(`Update skipped — memory not found: ${action.id}`)
          continue
        }
        const updated: Memory = {
          ...existing,
          description: action.description ?? existing.description,
          content: action.content,
          updatedAt: Date.now(),
        }
        await this.store.set(updated)
        memoriesUpdated++
        this.emit({ type: 'dream:memory:updated', memory: updated })
        this.log(`Updated memory: ${updated.name}`)
      }

      // ── Phase 4: Prune ───────────────────────────────────────────────────
      phase = 'prune'
      this.emit({ type: 'dream:phase', phase })
      this.log('Phase 4: Prune — removing stale memories')

      // Execute LLM-suggested deletes
      for (const action of actions.delete) {
        await this.store.delete(action.id)
        memoriesPruned++
        this.emit({
          type: 'dream:memory:pruned',
          id: action.id,
          reason: action.reason,
        })
        this.log(`Pruned memory ${action.id}: ${action.reason}`)
      }

      // Also enforce max memory cap
      const afterHeaders = await this.store.listHeaders()
      const maxMemories = this.config.maxMemories ?? 200
      if (afterHeaders.length > maxMemories) {
        const toDelete = afterHeaders.slice(maxMemories)
        for (const header of toDelete) {
          await this.store.delete(header.id)
          memoriesPruned++
          this.emit({
            type: 'dream:memory:pruned',
            id: header.id,
            reason: `Exceeded max memory cap (${maxMemories})`,
          })
        }
      }

      const result = this.buildResult({
        success: true,
        phase,
        memoriesScanned,
        memoriesCreated,
        memoriesUpdated,
        memoriesPruned,
        durationMs: Date.now() - startTime,
        summary: actions.summary,
      })

      this.emit({ type: 'dream:complete', result })
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit({ type: 'dream:error', error: err })

      return this.buildResult({
        success: false,
        phase,
        memoriesScanned,
        memoriesCreated,
        memoriesUpdated,
        memoriesPruned,
        durationMs: Date.now() - startTime,
        summary: `Dream failed during ${phase}: ${err.message}`,
        error: err,
      })
    }
  }

  /**
   * Find memories relevant to a specific query.
   * Uses the lightweight scoring model (two-model pattern).
   */
  async findRelevant(
    query: string,
    opts?: { recentTools?: string[] },
  ): Promise<Memory[]> {
    const headers = await this.store.listHeaders()
    if (headers.length === 0) return []

    const maxRelevant = this.config.maxRelevantMemories ?? 5

    // Two-model pattern: use scoring model for this lightweight task
    const prompt = buildRelevanceScoringPrompt({
      query,
      memories: headers,
      recentTools: opts?.recentTools,
    })

    try {
      const response = await this.llm.score([
        { role: 'user', content: prompt },
      ])

      const ids = JSON.parse(response.content.trim()) as string[]

      // Load the selected memories (max 5)
      const selected = await Promise.all(
        ids.slice(0, maxRelevant).map((id) => this.store.get(id)),
      )

      return selected.filter((m): m is Memory => m !== null)
    } catch (err) {
      this.log(`Relevance scoring failed: ${err} — returning empty`)
      return []
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private prepareTranscripts(sessions: Session[]): string[] {
    return sessions.map((session) => {
      const lines = session.messages.map((msg) => {
        const prefix =
          msg.role === 'user'
            ? 'Human'
            : msg.role === 'assistant'
              ? 'Assistant'
              : 'System'
        return `${prefix}: ${msg.content}`
      })
      return lines.join('\n')
    })
  }

  private async callConsolidationLLM(
    existingHeaders: MemoryHeader[],
    transcripts: string[],
  ): Promise<ConsolidationActions> {
    const systemPrompt = buildConsolidationSystemPrompt()
    const userPrompt = buildConsolidationUserPrompt({
      existingMemories: existingHeaders,
      sessionTranscripts: transcripts,
      config: this.config,
      extraContext: this.config.extraPrompt,
    })

    const response = await this.llm.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ])

    return this.parseConsolidationResponse(response.content)
  }

  private parseConsolidationResponse(content: string): ConsolidationActions {
    // Strip markdown code blocks if present
    const cleaned = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as ConsolidationActions
      return {
        create: Array.isArray(parsed.create) ? parsed.create : [],
        update: Array.isArray(parsed.update) ? parsed.update : [],
        delete: Array.isArray(parsed.delete) ? parsed.delete : [],
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary
            : 'Consolidation complete.',
      }
    } catch {
      this.log(`Failed to parse LLM response: ${cleaned.slice(0, 200)}`)
      return {
        create: [],
        update: [],
        delete: [],
        summary:
          'Consolidation response could not be parsed. No changes made.',
      }
    }
  }

  private buildResult(opts: {
    success: boolean
    phase: DreamPhase
    memoriesScanned: number
    memoriesCreated: number
    memoriesUpdated: number
    memoriesPruned: number
    durationMs: number
    summary: string
    error?: Error
  }): DreamResult {
    return {
      ...opts,
      completedAt: Date.now(),
    }
  }
}
