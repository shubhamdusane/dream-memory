/**
 * dream + LangChain Integration Example
 *
 * Shows how to add dream memory to any LangChain agent.
 * Run: npx tsx examples/langchain-integration.ts
 */

import { Dream } from '../src/index.js'

/**
 * DreamMemoryLayer — wraps any LangChain agent with dream memory.
 *
 * This pattern works with:
 * - LangChain agents
 * - LangGraph workflows
 * - Any custom agent loop
 *
 * Usage:
 *   const agent = createYourAgent()
 *   const withMemory = new DreamMemoryLayer(dream, agent)
 *   const response = await withMemory.invoke("write some code")
 */
export class DreamMemoryLayer {
  private dream: Dream
  private messages: Array<{ role: string; content: string }> = []

  constructor(dream: Dream) {
    this.dream = dream
  }

  /**
   * Process a user message with memory-augmented context.
   *
   * This is where dream integrates with your agent:
   * 1. Recall relevant memories for this query
   * 2. Inject them into the system prompt
   * 3. Get response from your LLM/agent
   * 4. Log the exchange for next dream pass
   */
  async process(userMessage: string): Promise<string> {
    // Step 1: Recall relevant memories
    const memoryContext = await this.dream.recallAsContext(userMessage)

    // Step 2: Build the augmented system prompt
    const systemPrompt = [
      'You are a helpful AI assistant.',
      '',
      memoryContext,
    ]
      .filter(Boolean)
      .join('\n')

    // Step 3: Call your LLM (replace with actual LangChain/OpenAI call)
    console.log('\n📤 Sending to LLM with memory context:')
    console.log('System prompt length:', systemPrompt.length, 'chars')
    if (memoryContext) {
      console.log('Memory context injected:', memoryContext.slice(0, 200) + '...')
    } else {
      console.log('No memory context (first session)')
    }

    // Simulate LLM response (replace with actual LLM call)
    const assistantResponse = `I understand your request: "${userMessage}". 
Based on what I remember about you, I'll tailor my response accordingly.`

    // Step 4: Log the exchange for the next dream pass
    this.messages.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantResponse },
    )

    return assistantResponse
  }

  /**
   * End the session and optionally trigger a dream pass.
   */
  async endSession(triggerDream = false): Promise<void> {
    if (this.messages.length === 0) return

    await this.dream.logSession(
      this.messages as Array<{
        role: 'user' | 'assistant' | 'system'
        content: string
      }>,
    )
    this.messages = []

    if (triggerDream) {
      const result = await this.dream.dream(true)
      console.log('\n💤 Post-session dream:', result.summary)
    }
  }
}

async function main() {
  const dream = new Dream({
    llm: {
      model: 'gpt-4o-mini',
      provider: 'openai',
    },
    store: { type: 'memory' }, // Use in-memory for this demo
    schedule: { minHours: 0, minSessions: 0 },
    debug: false,
  })

  // Pre-populate with some existing memories (simulating prior sessions)
  await dream.remember({
    name: 'User is a TypeScript developer',
    description: 'User prefers TypeScript and works on fintech',
    content:
      'User is building a fintech startup in TypeScript. They prefer concise code and hate boilerplate.',
    type: 'user',
  })

  await dream.remember({
    name: 'Code style preferences',
    description: 'Use Winston for logging, not console.log',
    content:
      'Always use Winston for logging. Never use console.log in production code.\n\n**Why:** Production log aggregation requirement.\n**How to apply:** Import logger from src/utils/logger.ts in all new files.',
    type: 'feedback',
  })

  console.log('🌙 dream + LangChain Integration Demo\n')
  console.log('Pre-populated with 2 existing memories.\n')

  // Create memory-augmented agent
  const agent = new DreamMemoryLayer(dream)

  // Simulate two conversation turns
  const q1 = 'Write me a function to validate payment amounts'
  console.log(`\n👤 User: ${q1}`)
  const r1 = await agent.process(q1)
  console.log(`\n🤖 Assistant: ${r1}`)

  const q2 = 'Add error handling to that function'
  console.log(`\n👤 User: ${q2}`)
  const r2 = await agent.process(q2)
  console.log(`\n🤖 Assistant: ${r2}`)

  // End session and trigger dream
  await agent.endSession(true)

  console.log('\n✅ Integration example complete!')
  console.log('In production, dream runs in the background between sessions.')
}

main().catch(console.error)
