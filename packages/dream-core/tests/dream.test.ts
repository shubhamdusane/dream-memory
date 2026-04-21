/**
 * dream core test suite
 *
 * Tests cover:
 * - InMemoryStore (no filesystem needed)
 * - Consolidator (with mocked LLM)
 * - Scheduler gate logic
 * - Dream public API
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Dream, createDream, InMemoryStore, FileSystemStore } from '../src/index.js'
import type { Memory, SessionMessage } from '../src/index.js'
import { Scheduler } from '../src/scheduler/scheduler.js'
import { LLMClient } from '../src/utils/llm.js'

// ─── Mock LLM Client ─────────────────────────────────────────────────────────

jest.mock('../src/utils/llm.js')

const mockConsolidationResponse = JSON.stringify({
  create: [
    {
      name: 'User prefers TypeScript',
      description: 'User has expressed a preference for TypeScript over JavaScript',
      type: 'user',
      content: 'User prefers TypeScript over JavaScript for all projects.\n\n**Why:** Stated explicitly in session.\n**How to apply:** Always use TypeScript in code examples and suggestions.',
    },
  ],
  update: [],
  delete: [],
  summary: 'Created 1 new user preference memory about TypeScript.',
})

const mockRelevanceResponse = JSON.stringify(['mock-memory-id'])

const MockLLMClient = LLMClient as unknown as jest.MockedClass<typeof LLMClient>
;(MockLLMClient.prototype as any).complete = jest.fn<any>().mockResolvedValue({
  content: mockConsolidationResponse,
})
;(MockLLMClient.prototype as any).score = jest.fn<any>().mockResolvedValue({
  content: mockRelevanceResponse,
})

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createTestMessages(): SessionMessage[] {
  return [
    { role: 'user', content: 'I prefer TypeScript over JavaScript' },
    { role: 'assistant', content: 'Noted, I will use TypeScript.' },
  ]
}

// ─── InMemoryStore Tests ──────────────────────────────────────────────────────

describe('InMemoryStore', () => {
  let store: InMemoryStore

  beforeEach(() => {
    store = new InMemoryStore()
  })

  it('should store and retrieve a memory', async () => {
    const memory: Memory = {
      id: 'test-1',
      name: 'Test Memory',
      description: 'A test memory',
      content: 'Test content',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await store.set(memory)
    const retrieved = await store.get('test-1')
    expect(retrieved).toEqual(memory)
  })

  it('should return null for non-existent memories', async () => {
    const result = await store.get('non-existent')
    expect(result).toBeNull()
  })

  it('should list memories', async () => {
    const mem1: Memory = {
      id: 'mem-1',
      name: 'Memory 1',
      description: 'First',
      content: 'Content 1',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const mem2: Memory = {
      id: 'mem-2',
      name: 'Memory 2',
      description: 'Second',
      content: 'Content 2',
      type: 'feedback',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await store.set(mem1)
    await store.set(mem2)

    const all = await store.list()
    expect(all).toHaveLength(2)

    const userOnly = await store.list({ type: 'user' })
    expect(userOnly).toHaveLength(1)
    expect(userOnly[0].id).toBe('mem-1')
  })

  it('should delete a memory', async () => {
    const memory: Memory = {
      id: 'to-delete',
      name: 'Delete Me',
      description: 'Will be deleted',
      content: 'Content',
      type: 'project',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await store.set(memory)
    expect(await store.get('to-delete')).not.toBeNull()

    await store.delete('to-delete')
    expect(await store.get('to-delete')).toBeNull()
  })

  it('should track sessions', async () => {
    const before = Date.now()
    await store.logSession('session-1')
    await store.logSession('session-2')

    const count = await store.countSessionsSince(before - 1000)
    expect(count).toBe(2)
  })

  it('should not count sessions before the cutoff', async () => {
    await store.logSession('old-session')
    await new Promise((r) => setTimeout(r, 5))
    const cutoff = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    await store.logSession('new-session')

    const count = await store.countSessionsSince(cutoff)
    expect(count).toBe(1)
  })

  it('should track last consolidation timestamp', async () => {
    expect(await store.getLastConsolidatedAt()).toBe(0)

    const now = Date.now()
    await store.setLastConsolidatedAt(now)

    const retrieved = await store.getLastConsolidatedAt()
    expect(retrieved).toBe(now)
  })

  it('should clear all data', async () => {
    await store.set({
      id: 'some-memory',
      name: 'Some',
      description: 'Some',
      content: 'Content',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await store.logSession('some-session')

    await store.clear()

    expect(await store.list()).toHaveLength(0)
    expect(await store.countSessionsSince(0)).toBe(0)
  })
})

// ─── Scheduler Tests ──────────────────────────────────────────────────────────

describe('Scheduler', () => {
  let store: InMemoryStore
  let scheduler: Scheduler

  beforeEach(() => {
    store = new InMemoryStore()
    scheduler = new Scheduler(store, { minHours: 24, minSessions: 5 })
  })

  it('should trigger on first run (no prior consolidation)', async () => {
    const result = await scheduler.shouldTrigger()
    expect(result.shouldDream).toBe(true)
  })

  it('should not trigger if not enough time has passed', async () => {
    await store.setLastConsolidatedAt(Date.now())
    const result = await scheduler.shouldTrigger()
    expect(result.shouldDream).toBe(false)
    expect(result.reason).toContain('Time gate')
  })

  it('should not trigger if not enough sessions', async () => {
    // Set last consolidation to 25 hours ago
    await store.setLastConsolidatedAt(Date.now() - 25 * 60 * 60 * 1000)
    // Only 2 sessions, need 5
    await store.logSession('s1')
    await store.logSession('s2')

    const result = await scheduler.shouldTrigger()
    expect(result.shouldDream).toBe(false)
    expect(result.reason).toContain('Session gate')
  })

  it('should trigger when both gates pass', async () => {
    await store.setLastConsolidatedAt(Date.now() - 25 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i++) {
      await store.logSession(`session-${i}`)
    }

    const result = await scheduler.shouldTrigger()
    expect(result.shouldDream).toBe(true)
  })
})

// ─── Dream Public API Tests ───────────────────────────────────────────────────

describe('Dream', () => {
  let dream: Dream

  beforeEach(() => {
    jest.clearAllMocks()
    dream = new Dream({
      llm: { model: 'gpt-4o-mini', provider: 'openai', apiKey: 'test-key' },
      store: { type: 'memory' },
      schedule: { minHours: 0, minSessions: 0 }, // Always trigger in tests
    })
  })

  it('should log a session', async () => {
    const sessionId = await dream.logSession(createTestMessages())
    expect(typeof sessionId).toBe('string')
    expect(sessionId).toHaveLength(36) // UUID
  })

  it('should run a dream pass and return a result', async () => {
    await dream.logSession(createTestMessages())

    const result = await dream.dream(true)

    expect(result.success).toBe(true)
    expect(result.memoriesCreated).toBe(1)
    expect(result.summary).toContain('TypeScript')
  })

  it('should store memories after dreaming', async () => {
    await dream.logSession(createTestMessages())
    await dream.dream(true)

    const memories = await dream.listMemories()
    expect(memories.length).toBeGreaterThan(0)
    expect(memories[0].type).toBe('user')
  })

  it('should support explicit memory creation with remember()', async () => {
    const memory = await dream.remember({
      name: 'User prefers dark mode',
      description: 'UI preference for dark mode',
      content: 'User always uses dark mode in their IDE and prefers dark themed outputs.',
      type: 'user',
    })

    expect(memory.id).toBeTruthy()
    expect(memory.name).toBe('User prefers dark mode')

    const retrieved = await dream.getMemory(memory.id)
    expect(retrieved).not.toBeNull()
  })

  it('should support session management with start/add/end', async () => {
    dream.startSession()
    dream.addMessage({ role: 'user', content: 'Hello' })
    dream.addMessage({ role: 'assistant', content: 'Hi there!' })
    const sessionId = await dream.endSession()

    expect(typeof sessionId).toBe('string')
  })

  it('should return formatted context from recall', async () => {
    await dream.remember({
      name: 'TypeScript preference',
      description: 'User prefers TypeScript',
      content: 'Always use TypeScript.',
      type: 'user',
    })

    // Mock the scoring to return our memory
    ;(MockLLMClient.prototype as any).score = jest.fn<any>().mockResolvedValue({
      content: JSON.stringify([
        (await dream.listMemories())[0].id,
      ]),
    })

    const context = await dream.recallAsContext('code style preferences')
    expect(context).toContain('Relevant memories')
    expect(context).toContain('TypeScript preference')
  })

  it('should emit events during dream pass', async () => {
    const events: string[] = []
    dream.onEvent((event) => events.push(event.type))

    await dream.logSession(createTestMessages())
    await dream.dream(true)

    expect(events).toContain('dream:start')
    expect(events).toContain('dream:phase')
    expect(events).toContain('dream:complete')
  })

  it('should delete a memory with forget()', async () => {
    const memory = await dream.remember({
      name: 'Temp memory',
      description: 'Temporary',
      content: 'Will be forgotten',
      type: 'project',
    })

    await dream.forget(memory.id)

    const retrieved = await dream.getMemory(memory.id)
    expect(retrieved).toBeNull()
  })

  it('should return skipped result when gates not met', async () => {
    const conservativeDream = new Dream({
      llm: { model: 'gpt-4o-mini', provider: 'openai', apiKey: 'test-key' },
      store: { type: 'memory' },
      schedule: { minHours: 999, minSessions: 999 },
    })

    // Set recent consolidation
    await conservativeDream.rawStore.setLastConsolidatedAt(Date.now())

    const result = await conservativeDream.dream(false)
    expect(result.success).toBe(true)
    expect(result.summary).toContain('skipped')
  })
})

// ─── Regression: endSession → dream → listMemories ───────────────────────────

describe('Regression: endSession queues messages for consolidation', () => {
  let dream: Dream

  beforeEach(() => {
    jest.clearAllMocks()
    dream = new Dream({
      llm: { model: 'gpt-4o-mini', provider: 'openai', apiKey: 'test-key' },
      store: { type: 'memory' },
      schedule: { minHours: 0, minSessions: 0 },
    })
  })

  it('creates memories when using startSession/addMessage/endSession flow', async () => {
    dream.startSession()
    dream.addMessage({ role: 'user', content: 'I prefer TypeScript over JavaScript' })
    dream.addMessage({ role: 'assistant', content: 'Noted, I will use TypeScript.' })
    await dream.endSession()

    const result = await dream.dream(true)
    expect(result.success).toBe(true)
    expect(result.memoriesCreated).toBe(1)

    const memories = await dream.listMemories()
    expect(memories).toHaveLength(1)
    expect(memories[0].name).toContain('TypeScript')
  })
})

// ─── Regression: FileSystemStore frontmatter with colons ──────────────────────

describe('Regression: FileSystemStore handles colons in frontmatter values', () => {
  let tmp: string
  let store: FileSystemStore

  beforeEach(async () => {
    tmp = join(tmpdir(), `dream-test-${randomUUID()}`)
    await fs.mkdir(tmp, { recursive: true })
    store = new FileSystemStore(tmp)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('round-trips a memory whose name contains a colon (URL)', async () => {
    const id = randomUUID()
    const memory: Memory = {
      id,
      name: 'API reference: https://api.example.com/v1',
      description: 'Payment API: v2 docs',
      content: 'Use /payments endpoint. Auth: Bearer token.',
      type: 'reference',
      createdAt: 1713657600000,
      updatedAt: 1713657600000,
    }
    await store.set(memory)
    const loaded = await store.get(id)
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe('API reference: https://api.example.com/v1')
    expect(loaded!.description).toBe('Payment API: v2 docs')
  })

  it('rejects invalid memory ids (path traversal)', async () => {
    // Valid lookup with bogus id should throw, not resolve ../
    await expect(store.get('../../../etc/passwd')).resolves.toBeNull()
    // Write path must throw before hitting the filesystem
    await expect(
      store.set({
        id: '../../escape',
        name: 'bad',
        description: '',
        content: '',
        type: 'user',
        createdAt: 0,
        updatedAt: 0,
      }),
    ).rejects.toThrow(/Invalid memory id/)
  })
})

// ─── createDream Factory Tests ────────────────────────────────────────────────

describe('createDream factories', () => {
  it('should create an OpenAI-configured dream instance', () => {
    const instance = createDream.openai({ model: 'gpt-4o', apiKey: 'sk-test' })
    expect(instance).toBeInstanceOf(Dream)
  })

  it('should create an Anthropic-configured dream instance', () => {
    const instance = createDream.anthropic({ apiKey: 'sk-ant-test' })
    expect(instance).toBeInstanceOf(Dream)
  })

  it('should create a local model dream instance', () => {
    const instance = createDream.local({ model: 'llama3' })
    expect(instance).toBeInstanceOf(Dream)
  })

  it('should create an in-memory dream instance', () => {
    const instance = createDream.inMemory({
      model: 'gpt-4o-mini',
      apiKey: 'test',
    })
    expect(instance).toBeInstanceOf(Dream)
  })
})
