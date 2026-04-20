import type { MemoryHeader, ConsolidationConfig } from '../types/index.js'

/**
 * Consolidation prompts for the dream pass.
 *
 * Architecture directly inspired by Anthropic's internal consolidationPrompt.ts
 * from their Claude Code source (released 2026).
 *
 * The 4-phase structure mirrors their production implementation:
 * Phase 1: Orient  → understand what exists
 * Phase 2: Gather  → find new signal worth keeping
 * Phase 3: Consolidate → merge and write durable memories
 * Phase 4: Prune   → clean up stale, duplicate, or low-value memories
 */

export function buildConsolidationSystemPrompt(): string {
  return `You are the dream consolidation agent — a specialized subagent responsible for maintaining an AI's long-term memory.

Your role: analyze recent session transcripts and update a structured memory store so that future sessions can orient quickly and have accurate context.

Memory types you work with:
- **user**: Information about the user's role, goals, and preferences
- **feedback**: Guidance about how to approach work (corrections + confirmations)  
- **project**: Ongoing work, decisions, bugs, timelines
- **reference**: Pointers to external systems, resources, URLs

What makes a good memory:
- Facts NOT derivable from current context
- Non-obvious patterns or decisions
- User preferences discovered through interaction
- Important context that would take effort to re-discover

What NOT to save:
- Code patterns obvious from reading the codebase
- Ephemeral task details or current-session context
- Information already documented elsewhere
- Debugging solutions (the fix is in the code)

Output format: Respond with a JSON object containing your actions and a summary.`
}

export function buildConsolidationUserPrompt(opts: {
  existingMemories: MemoryHeader[]
  sessionTranscripts: string[]
  config?: ConsolidationConfig
  extraContext?: string
}): string {
  const { existingMemories, sessionTranscripts, config, extraContext } = opts

  const memoryList =
    existingMemories.length > 0
      ? existingMemories
          .map(
            (m) =>
              `- [${m.type ?? 'unknown'}] ${m.name}: ${m.description} (id: ${m.id})`,
          )
          .join('\n')
      : '(No existing memories — this is a fresh start)'

  const transcriptContent =
    sessionTranscripts.length > 0
      ? sessionTranscripts
          .map((t, i) => `<session_${i + 1}>\n${t}\n</session_${i + 1}>`)
          .join('\n\n')
      : '(No session transcripts provided)'

  const maxMemories = config?.maxMemories ?? 200

  return `# Dream: Memory Consolidation Pass

You are performing a reflective pass over session transcripts to maintain durable, well-organized memories.

---

## Phase 1 — Orient

Review what memories already exist so you can update rather than duplicate:

<existing_memories>
${memoryList}
</existing_memories>

Total existing: ${existingMemories.length} / ${maxMemories} max

---

## Phase 2 — Gather Recent Signal

Review the recent session transcripts below. Look for:
1. New information about the user (role, preferences, working style)
2. Corrections the user made to your behavior ("don't do X", "always do Y")
3. Confirmations of non-obvious approaches (user said "yes, exactly")
4. Project decisions, blockers, or context worth preserving
5. External resources or systems referenced

<session_transcripts>
${transcriptContent}
</session_transcripts>

${extraContext ? `## Additional Context\n${extraContext}\n` : ''}

---

## Phase 3 — Consolidate

Decide what to create, update, or leave unchanged.

Rules:
- Merge new signal into EXISTING memories before creating new ones
- Convert relative dates ("yesterday", "last week") to absolute ISO dates
- Fix contradicted facts at the source — don't add "updated" notes
- Each memory should be self-contained: include WHY not just WHAT

---

## Phase 4 — Prune

Identify memories to delete:
- Contradicted by newer information
- Superseded by updated memories
- Ephemeral details that no longer matter
- Duplicates of other memories

---

## Output Format

Respond with ONLY a valid JSON object (no markdown, no explanation):

{
  "create": [
    {
      "name": "string — short, descriptive name",
      "description": "string — one line, used for relevance scoring",
      "type": "user | feedback | project | reference",
      "content": "string — the actual memory content. For feedback/project: lead with the rule/fact, then Why: and How to apply: lines"
    }
  ],
  "update": [
    {
      "id": "string — existing memory ID",
      "description": "string — updated description (or same)",
      "content": "string — updated full content"
    }
  ],
  "delete": [
    {
      "id": "string — memory ID to delete",
      "reason": "string — why this memory should be removed"
    }
  ],
  "summary": "string — 2-3 sentences describing what you consolidated, updated, or pruned. If nothing changed, say so."
}

If there is nothing worth consolidating, return:
{
  "create": [],
  "update": [],
  "delete": [],
  "summary": "No new information worth persisting. Memories are current."
}`
}

export function buildRelevanceScoringPrompt(opts: {
  query: string
  memories: MemoryHeader[]
  recentTools?: string[]
}): string {
  const { query, memories, recentTools = [] } = opts

  const memoryList = memories
    .map(
      (m, i) =>
        `${i + 1}. [${m.type ?? 'unknown'}] ${m.name} (id: ${m.id}): ${m.description}`,
    )
    .join('\n')

  const toolsNote =
    recentTools.length > 0
      ? `\nRecently used tools (skip API reference memories for these): ${recentTools.join(', ')}`
      : ''

  return `You are selecting memories relevant to an AI agent's current query.

Query: "${query}"${toolsNote}

Available memories:
${memoryList}

Return a JSON array of memory IDs that are clearly relevant (max 5).
Be selective — only include memories that DIRECTLY help with this query.
Return empty array if none are clearly relevant.

Response format: ["id1", "id2", ...]
No other text.`
}
