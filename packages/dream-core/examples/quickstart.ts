/**
 * dream — Quickstart Example
 *
 * This example shows the core dream loop in under 50 lines.
 * Run: npx tsx examples/quickstart.ts
 */

import { Dream } from '../src/index.js'

async function main() {
  // 1. Initialize dream with your LLM
  const dream = new Dream({
    llm: {
      model: 'gpt-4o-mini',
      provider: 'openai',
      // Reads OPENAI_API_KEY from env automatically
    },
    store: {
      type: 'filesystem',
      path: '.dream-example', // Memories stored here
    },
    schedule: {
      minHours: 0.001, // Trigger almost immediately (for demo)
      minSessions: 1,
    },
    debug: true,
  })

  console.log('🌙 dream — memory consolidation for AI agents\n')

  // 2. Log a session (simulate an agent conversation)
  console.log('Logging session...')
  await dream.logSession([
    {
      role: 'user',
      content:
        "I'm building a fintech startup. I prefer TypeScript, hate long meetings, and always want concise code.",
    },
    {
      role: 'assistant',
      content:
        "Got it! I'll keep my responses concise and use TypeScript. What are you building?",
    },
    {
      role: 'user',
      content:
        "A payment gateway. The auth service uses JWT tokens and is in src/auth/. We use Prisma for the database.",
    },
    {
      role: 'assistant',
      content:
        'Understood. JWT auth in src/auth/, Prisma for DB. Should I follow the existing patterns there?',
    },
    {
      role: 'user',
      content:
        "Yes, always check existing patterns first. And don't use console.log — we use Winston for logging.",
    },
  ])

  // 3. Trigger a dream pass (this calls the LLM to consolidate)
  console.log('\n💤 Running dream pass...')
  const result = await dream.dream(true)

  console.log('\n✅ Dream complete!')
  console.log(`   Created: ${result.memoriesCreated} memories`)
  console.log(`   Updated: ${result.memoriesUpdated} memories`)
  console.log(`   Pruned:  ${result.memoriesPruned} memories`)
  console.log(`   Duration: ${result.durationMs}ms`)
  console.log(`   Summary: ${result.summary}`)

  // 4. List what was remembered
  console.log('\n🧠 Memories stored:')
  const memories = await dream.listMemories()
  for (const memory of memories) {
    console.log(`\n  [${memory.type}] ${memory.name}`)
    console.log(`   ${memory.description}`)
  }

  // 5. Recall relevant memories for a new query
  console.log('\n🔍 Recalling memories for: "how should I write code here?"')
  const context = await dream.recallAsContext(
    'how should I write code here?',
  )

  if (context) {
    console.log('\n📋 Context injected into next LLM call:')
    console.log(context)
  } else {
    console.log('No relevant memories found.')
  }

  // 6. Clean up example data
  await dream.clearAll()
  console.log('\n🧹 Cleaned up example data.')
}

main().catch(console.error)
