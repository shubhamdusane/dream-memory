import type { ScheduleConfig, MemoryStoreAdapter } from '../types/index.js'

interface GateCheckResult {
  shouldDream: boolean
  reason: string
  sessionsSinceLastDream: number
  hoursSinceLastDream: number
}

/**
 * Scheduler — decides when to trigger dream passes.
 *
 * Gate order (cheapest check first, same as Anthropic's design):
 *   1. Time gate: hours since last consolidation >= minHours
 *   2. Session gate: new sessions since last consolidation >= minSessions
 *   3. Lock: no other process is mid-consolidation
 *
 * This prevents unnecessary LLM calls when nothing has changed.
 */
export class Scheduler {
  private readonly config: Required<ScheduleConfig>
  private readonly store: MemoryStoreAdapter
  private cronTimer?: ReturnType<typeof setInterval>
  private isRunning = false

  constructor(store: MemoryStoreAdapter, config?: ScheduleConfig) {
    this.store = store
    this.config = {
      minHours: config?.minHours ?? 24,
      minSessions: config?.minSessions ?? 5,
      cron: config?.cron ?? '',
      enabled: config?.enabled ?? true,
    }
  }

  /**
   * Check whether a dream pass should be triggered.
   * Runs all gates in order (cheapest first).
   */
  async shouldTrigger(): Promise<GateCheckResult> {
    const lastConsolidatedAt = await this.store.getLastConsolidatedAt()
    const now = Date.now()

    const hoursSinceLastDream =
      lastConsolidatedAt === 0
        ? Infinity
        : (now - lastConsolidatedAt) / (1000 * 60 * 60)

    const sessionsSinceLastDream =
      await this.store.countSessionsSince(lastConsolidatedAt)

    // Gate 1: Time
    if (hoursSinceLastDream < this.config.minHours) {
      return {
        shouldDream: false,
        reason: `Time gate: ${hoursSinceLastDream.toFixed(1)}h < ${this.config.minHours}h minimum`,
        sessionsSinceLastDream,
        hoursSinceLastDream,
      }
    }

    // Gate 2: Sessions (skip if this is the very first dream)
    if (
      lastConsolidatedAt > 0 &&
      sessionsSinceLastDream < this.config.minSessions
    ) {
      return {
        shouldDream: false,
        reason: `Session gate: ${sessionsSinceLastDream} sessions < ${this.config.minSessions} minimum`,
        sessionsSinceLastDream,
        hoursSinceLastDream,
      }
    }

    return {
      shouldDream: true,
      reason: `Gates passed: ${hoursSinceLastDream.toFixed(1)}h elapsed, ${sessionsSinceLastDream} new sessions`,
      sessionsSinceLastDream,
      hoursSinceLastDream,
    }
  }

  /**
   * Force trigger regardless of gates.
   * Use this for manual /dream commands.
   */
  shouldTriggerForced(): GateCheckResult {
    return {
      shouldDream: true,
      reason: 'Manual trigger (forced)',
      sessionsSinceLastDream: 0,
      hoursSinceLastDream: 0,
    }
  }

  /**
   * Mark the current time as the last consolidation time.
   */
  async recordConsolidation(): Promise<void> {
    await this.store.setLastConsolidatedAt(Date.now())
  }

  /**
   * Start automatic background scheduling.
   *
   * @param onTrigger - Called when the schedule fires. Run your dream pass here.
   * @param checkIntervalMs - How often to check the gate (default: 5 min)
   */
  startAutoSchedule(
    onTrigger: () => Promise<void>,
    checkIntervalMs = 5 * 60 * 1000,
  ): void {
    if (!this.config.enabled) return
    if (this.cronTimer) return // Already running

    this.cronTimer = setInterval(async () => {
      if (this.isRunning) return

      const gate = await this.shouldTrigger()
      if (!gate.shouldDream) return

      this.isRunning = true
      try {
        await onTrigger()
        await this.recordConsolidation()
      } catch (err) {
        console.error('[dream:scheduler] Auto-dream failed:', err)
      } finally {
        this.isRunning = false
      }
    }, checkIntervalMs)
  }

  /**
   * Stop automatic background scheduling.
   */
  stopAutoSchedule(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = undefined
    }
  }
}
