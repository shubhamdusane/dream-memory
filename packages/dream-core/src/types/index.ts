/**
 * Dream Memory - Open source memory consolidation for AI systems
 * Inspired by Anthropic's internal memory architecture
 */

// ─── Memory Types ─────────────────────────────────────────────────────────────

/**
 * The four memory types that Dream Memory supports.
 * Directly mirrors the internal taxonomy of advanced LLMs.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/**
 * A single memory record stored by the agent.
 */
export interface Memory {
  /** Unique identifier */
  id: string
  /** Human-readable name for this memory */
  name: string
  /** One-line description used for relevance scoring */
  description: string
  /** The actual memory content */
  content: string
  /** Type classification */
  type: MemoryType
  /** Unix timestamp (ms) when this memory was created */
  createdAt: number
  /** Unix timestamp (ms) when this memory was last updated */
  updatedAt: number
  /** Source session or context that created this memory */
  source?: string
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

/**
 * A lightweight header used for relevance scanning.
 * Never loads full memory content — only frontmatter.
 */
export interface MemoryHeader {
  id: string
  name: string
  description: string
  type: MemoryType | undefined
  updatedAt: number
}

// ─── Dream Pass Types ─────────────────────────────────────────────────────────

/**
 * The four phases of a dream consolidation pass.
 * Directly mirrors the 4-stage structure in Anthropic's consolidationPrompt.ts
 */
export type DreamPhase = 'orient' | 'gather' | 'consolidate' | 'prune'

/**
 * Result of a single dream pass execution.
 */
export interface DreamResult {
  /** Whether the dream pass ran successfully */
  success: boolean
  /** Which phase the dream reached */
  phase: DreamPhase
  /** Number of memories scanned */
  memoriesScanned: number
  /** Number of memories created */
  memoriesCreated: number
  /** Number of memories updated */
  memoriesUpdated: number
  /** Number of memories pruned/deleted */
  memoriesPruned: number
  /** Duration in milliseconds */
  durationMs: number
  /** Human-readable summary from the LLM */
  summary: string
  /** Error if the dream failed */
  error?: Error
  /** Timestamp when dream completed */
  completedAt: number
}

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Configuration for the dream memory system.
 */
export interface DreamConfig {
  /**
   * Your LLM provider configuration.
   * dream works with any provider that exposes an OpenAI-compatible interface.
   */
  llm: LLMConfig

  /**
   * Storage configuration.
   * @default FileSystemStore with .dream/ directory
   */
  store?: StoreConfig

  /**
   * Scheduling configuration for automatic dream passes.
   * @default { minHours: 24, minSessions: 5 }
   */
  schedule?: ScheduleConfig

  /**
   * Consolidation behavior configuration.
   */
  consolidation?: ConsolidationConfig

  /**
   * Pruning behavior configuration.
   */
  pruning?: PruningConfig

  /**
   * Enable verbose logging.
   * @default false
   */
  debug?: boolean
}

export interface LLMConfig {
  /**
   * The model to use for consolidation.
   * For relevance scoring, dream uses a lighter model automatically.
   * Examples: 'claude-3-5-sonnet-20241022', 'gpt-4o', 'gpt-4o-mini'
   */
  model: string

  /**
   * API key. Can also be set via OPENAI_API_KEY or ANTHROPIC_API_KEY env vars.
   */
  apiKey?: string

  /**
   * Base URL for OpenAI-compatible APIs.
   * Use this for local models (Ollama, LM Studio, etc.)
   * @default 'https://api.anthropic.com/v1' or 'https://api.openai.com/v1'
   */
  baseURL?: string

  /**
   * Provider type — helps dream pick the right API format.
   * @default 'openai' (compatible with OpenAI, Anthropic via proxy, Ollama, etc.)
   */
  provider?: 'openai' | 'anthropic'

  /**
   * The lighter model to use for relevance scoring (memory retrieval).
   * If not set, uses the same model as `model`.
   * @default same as model
   */
  scoringModel?: string

  /**
   * Maximum tokens for consolidation responses.
   * @default 4096
   */
  maxTokens?: number
}

export interface StoreConfig {
  /**
   * Storage backend type.
   * @default 'filesystem'
   */
  type: 'filesystem' | 'memory' | 'custom'

  /**
   * Path for filesystem store.
   * @default '.dream'
   */
  path?: string

  /**
   * Custom store implementation (when type is 'custom').
   */
  adapter?: MemoryStoreAdapter
}

export interface ScheduleConfig {
  /**
   * Minimum hours between dream passes.
   * @default 24
   */
  minHours?: number

  /**
   * Minimum number of new sessions before triggering a dream.
   * @default 5
   */
  minSessions?: number

  /**
   * Cron expression for scheduled dream passes.
   * If set, overrides minHours/minSessions gate.
   * Example: '0 3 * * *' (3am every day)
   */
  cron?: string

  /**
   * Enable automatic background dreaming.
   * @default true
   */
  enabled?: boolean
}

export interface ConsolidationConfig {
  /**
   * Maximum number of memories to keep.
   * @default 200
   */
  maxMemories?: number

  /**
   * Maximum memories to surface per query (relevance-scored).
   * @default 5
   */
  maxRelevantMemories?: number

  /**
   * Custom consolidation prompt additions.
   */
  extraPrompt?: string
}

export interface PruningConfig {
  /**
   * Delete memories older than this many days.
   * Set to 0 to disable age-based pruning.
   * @default 90
   */
  maxAgeDays?: number

  /**
   * Aggressiveness of deduplication (0-1).
   * 0 = no dedup, 1 = very aggressive
   * @default 0.85
   */
  deduplicationThreshold?: number
}

// ─── Adapter Interface ────────────────────────────────────────────────────────

/**
 * Interface for custom storage backends.
 * Implement this to use databases, Redis, S3, etc.
 */
export interface MemoryStoreAdapter {
  /** Load a specific memory by ID */
  get(id: string): Promise<Memory | null>
  /** Save a memory (create or update) */
  set(memory: Memory): Promise<void>
  /** Delete a memory */
  delete(id: string): Promise<void>
  /** List all memory headers (lightweight, no content) */
  listHeaders(): Promise<MemoryHeader[]>
  /** List full memories, optionally filtered by type */
  list(filter?: { type?: MemoryType }): Promise<Memory[]>
  /** Get the timestamp of the last consolidation */
  getLastConsolidatedAt(): Promise<number>
  /** Update the last consolidation timestamp */
  setLastConsolidatedAt(timestamp: number): Promise<void>
  /** Log a session interaction (for session counting gate) */
  logSession(sessionId: string): Promise<void>
  /** Count sessions since a given timestamp */
  countSessionsSince(sinceMs: number): Promise<number>
  /** Clear all memories (use with caution) */
  clear(): Promise<void>
}

// ─── Session Types ────────────────────────────────────────────────────────────

/**
 * A single interaction message to log before dreaming.
 */
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * A logged session that dream can consolidate from.
 */
export interface Session {
  id: string
  messages: SessionMessage[]
  startedAt: number
  endedAt?: number
  metadata?: Record<string, unknown>
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type DreamEvent =
  | { type: 'dream:start'; sessionCount: number }
  | { type: 'dream:phase'; phase: DreamPhase }
  | { type: 'dream:memory:created'; memory: Memory }
  | { type: 'dream:memory:updated'; memory: Memory }
  | { type: 'dream:memory:pruned'; id: string; reason: string }
  | { type: 'dream:complete'; result: DreamResult }
  | { type: 'dream:error'; error: Error }
