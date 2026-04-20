import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  Memory,
  MemoryHeader,
  MemoryStoreAdapter,
  MemoryType,
} from '../types/index.js'

const LOCK_FILE = '.consolidate-lock'
const INDEX_FILE = 'MEMORY.md'
const SESSIONS_FILE = '.sessions.json'
const MEMORIES_DIR = 'memories'

interface SessionLog {
  sessions: Array<{ id: string; loggedAt: number }>
}

/**
 * FileSystemStore — the default storage backend for dream.
 *
 * Directory layout:
 *   .dream/
 *     MEMORY.md              ← index file (human-readable)
 *     .consolidate-lock      ← mtime = lastConsolidatedAt
 *     .sessions.json         ← session log for gate counting
 *     memories/
 *       user_role.md         ← individual memory files
 *       feedback_testing.md
 *       project_auth.md
 *       ...
 */
export class FileSystemStore implements MemoryStoreAdapter {
  private readonly root: string
  private readonly memoriesDir: string

  constructor(root: string = '.dream') {
    this.root = root
    this.memoriesDir = join(root, MEMORIES_DIR)
  }

  private lockPath(): string {
    return join(this.root, LOCK_FILE)
  }

  private indexPath(): string {
    return join(this.root, INDEX_FILE)
  }

  private sessionsPath(): string {
    return join(this.root, SESSIONS_FILE)
  }

  private memoryPath(id: string): string {
    return join(this.memoriesDir, `${id}.md`)
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.memoriesDir, { recursive: true })
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  private serializeMemory(memory: Memory): string {
    const frontmatter = [
      '---',
      `id: ${memory.id}`,
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `createdAt: ${memory.createdAt}`,
      `updatedAt: ${memory.updatedAt}`,
      memory.source ? `source: ${memory.source}` : null,
      memory.metadata ? `metadata: ${JSON.stringify(memory.metadata)}` : null,
      '---',
      '',
      memory.content,
    ]
      .filter((line) => line !== null)
      .join('\n')

    return frontmatter
  }

  private deserializeMemory(raw: string, _filePath: string): Memory | null {
    try {
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/m)
      if (!fmMatch) return null

      const [, frontmatterStr, content] = fmMatch
      const frontmatter: Record<string, string> = {}

      for (const line of frontmatterStr.split('\n')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim()
        const value = line.slice(colonIdx + 1).trim()
        frontmatter[key] = value
      }

      if (!frontmatter.id || !frontmatter.name || !frontmatter.type) {
        return null
      }

      return {
        id: frontmatter.id,
        name: frontmatter.name,
        description: frontmatter.description ?? '',
        content: content.trim(),
        type: frontmatter.type as MemoryType,
        createdAt: parseInt(frontmatter.createdAt ?? '0', 10),
        updatedAt: parseInt(frontmatter.updatedAt ?? '0', 10),
        source: frontmatter.source,
        metadata: frontmatter.metadata
          ? JSON.parse(frontmatter.metadata)
          : undefined,
      }
    } catch {
      return null
    }
  }

  // ─── MemoryStoreAdapter Implementation ───────────────────────────────────

  async get(id: string): Promise<Memory | null> {
    try {
      const raw = await fs.readFile(this.memoryPath(id), 'utf-8')
      return this.deserializeMemory(raw, this.memoryPath(id))
    } catch {
      return null
    }
  }

  async set(memory: Memory): Promise<void> {
    await this.ensureDirectories()
    const content = this.serializeMemory(memory)
    await fs.writeFile(this.memoryPath(memory.id), content, 'utf-8')
    await this.rebuildIndex()
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.memoryPath(id))
      await this.rebuildIndex()
    } catch {
      // File may not exist
    }
  }

  async listHeaders(): Promise<MemoryHeader[]> {
    try {
      await this.ensureDirectories()
      const files = await fs.readdir(this.memoriesDir)
      const mdFiles = files.filter(
        (f) => f.endsWith('.md') && f !== 'MEMORY.md',
      )

      const headers = await Promise.allSettled(
        mdFiles.map(async (file): Promise<MemoryHeader> => {
          const filePath = join(this.memoriesDir, file)
          const stat = await fs.stat(filePath)
          const raw = await fs.readFile(filePath, 'utf-8')

          // Only parse frontmatter (first 30 lines max)
          const lines = raw.split('\n').slice(0, 30).join('\n')
          const fmMatch = lines.match(/^---\n([\s\S]*?)\n---/)
          if (!fmMatch)
            return {
              id: file.replace('.md', ''),
              name: file.replace('.md', ''),
              description: '',
              type: undefined,
              updatedAt: stat.mtimeMs,
            }

          const frontmatter: Record<string, string> = {}
          for (const line of fmMatch[1].split('\n')) {
            const colonIdx = line.indexOf(':')
            if (colonIdx === -1) continue
            frontmatter[line.slice(0, colonIdx).trim()] = line
              .slice(colonIdx + 1)
              .trim()
          }

          return {
            id: frontmatter.id ?? file.replace('.md', ''),
            name: frontmatter.name ?? '',
            description: frontmatter.description ?? '',
            type: frontmatter.type as MemoryType | undefined,
            updatedAt: stat.mtimeMs,
          }
        }),
      )

      return headers
        .filter(
          (r): r is PromiseFulfilledResult<MemoryHeader> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  async list(filter?: { type?: MemoryType }): Promise<Memory[]> {
    try {
      await this.ensureDirectories()
      const files = await fs.readdir(this.memoriesDir)
      const mdFiles = files.filter((f) => f.endsWith('.md'))

      const memories = await Promise.allSettled(
        mdFiles.map(async (file) => {
          const raw = await fs.readFile(
            join(this.memoriesDir, file),
            'utf-8',
          )
          return this.deserializeMemory(
            raw,
            join(this.memoriesDir, file),
          )
        }),
      )

      return memories
        .filter(
          (r): r is PromiseFulfilledResult<Memory> =>
            r.status === 'fulfilled' && r.value !== null,
        )
        .map((r) => r.value as Memory)
        .filter((m) => !filter?.type || m.type === filter.type)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  async getLastConsolidatedAt(): Promise<number> {
    try {
      const stat = await fs.stat(this.lockPath())
      return stat.mtimeMs
    } catch {
      return 0
    }
  }

  async setLastConsolidatedAt(timestamp: number): Promise<void> {
    await this.ensureDirectories()
    await fs.writeFile(this.lockPath(), String(process.pid))
    // Set mtime to the given timestamp (mirrors Anthropic's lock design)
    const t = timestamp / 1000
    await fs.utimes(this.lockPath(), t, t)
  }

  async logSession(sessionId: string): Promise<void> {
    await this.ensureDirectories()
    let log: SessionLog = { sessions: [] }

    try {
      const raw = await fs.readFile(this.sessionsPath(), 'utf-8')
      log = JSON.parse(raw) as SessionLog
    } catch {
      // File doesn't exist yet
    }

    // Avoid duplicate logging
    if (!log.sessions.find((s) => s.id === sessionId)) {
      log.sessions.push({ id: sessionId, loggedAt: Date.now() })
      // Keep last 1000 sessions
      if (log.sessions.length > 1000) {
        log.sessions = log.sessions.slice(-1000)
      }
      await fs.writeFile(this.sessionsPath(), JSON.stringify(log, null, 2))
    }
  }

  async countSessionsSince(sinceMs: number): Promise<number> {
    try {
      const raw = await fs.readFile(this.sessionsPath(), 'utf-8')
      const log = JSON.parse(raw) as SessionLog
      return log.sessions.filter((s) => s.loggedAt > sinceMs).length
    } catch {
      return 0
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.root, { recursive: true, force: true })
    } catch {
      // Nothing to clear
    }
  }

  // ─── Index Building ───────────────────────────────────────────────────────

  /**
   * Rebuild the MEMORY.md index file.
   * This is the human-readable entry point for the agent's memory.
   * Kept under 200 lines and 25KB per Anthropic's design.
   */
  private async rebuildIndex(): Promise<void> {
    const headers = await this.listHeaders()
    const MAX_LINES = 200
    const MAX_BYTES = 25_000

    const lines: string[] = [
      '# Memory Index',
      '',
      `> Auto-generated by Dream Memory | ${headers.length} memories | Last updated: ${new Date().toISOString()}`,
      '',
      '## Memories',
      '',
    ]

    for (const header of headers) {
      const typeEmoji =
        {
          user: '👤',
          feedback: '💡',
          project: '📋',
          reference: '🔗',
        }[header.type ?? 'project'] ?? '📝'

      lines.push(
        `- ${typeEmoji} [${header.name}](memories/${header.id}.md) — ${header.description}`,
      )

      if (lines.length >= MAX_LINES) {
        lines.push('', `_...and ${headers.length - lines.length + 6} more_`)
        break
      }
    }

    const content = lines.join('\n')
    const truncated =
      content.length > MAX_BYTES ? content.slice(0, MAX_BYTES) + '\n...' : content

    await fs.writeFile(this.indexPath(), truncated, 'utf-8')
  }
}

/**
 * InMemoryStore — for testing and ephemeral use cases.
 * No persistence across process restarts.
 */
export class InMemoryStore implements MemoryStoreAdapter {
  private memories = new Map<string, Memory>()
  private lastConsolidatedAt = 0
  private sessions: Array<{ id: string; loggedAt: number }> = []

  async get(id: string): Promise<Memory | null> {
    return this.memories.get(id) ?? null
  }

  async set(memory: Memory): Promise<void> {
    this.memories.set(memory.id, memory)
  }

  async delete(id: string): Promise<void> {
    this.memories.delete(id)
  }

  async listHeaders(): Promise<MemoryHeader[]> {
    return Array.from(this.memories.values())
      .map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        type: m.type,
        updatedAt: m.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async list(filter?: { type?: MemoryType }): Promise<Memory[]> {
    return Array.from(this.memories.values())
      .filter((m) => !filter?.type || m.type === filter.type)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async getLastConsolidatedAt(): Promise<number> {
    return this.lastConsolidatedAt
  }

  async setLastConsolidatedAt(timestamp: number): Promise<void> {
    this.lastConsolidatedAt = timestamp
  }

  async logSession(sessionId: string): Promise<void> {
    if (!this.sessions.find((s) => s.id === sessionId)) {
      this.sessions.push({ id: sessionId, loggedAt: Date.now() })
    }
  }

  async countSessionsSince(sinceMs: number): Promise<number> {
    return this.sessions.filter((s) => s.loggedAt > sinceMs).length
  }

  async clear(): Promise<void> {
    this.memories.clear()
    this.sessions = []
    this.lastConsolidatedAt = 0
  }
}
