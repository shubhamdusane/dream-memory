# Contributing to Dream Memory

First off — thank you. Dream Memory is better because of contributors like you.

This guide covers everything you need to go from zero to a merged pull request.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Tests](#tests)
- [Pull Request Process](#pull-request-process)
- [Areas That Need Help](#areas-that-need-help)

---

## Code of Conduct

Be excellent to each other. Constructive criticism is welcome; personal attacks are not.

---

## How Can I Contribute?

### 🐛 Reporting Bugs

Open an issue with:
- dream-memory version (`npm list @dream-agent/core`)
- Node.js version (`node --version`)
- Minimal reproduction case
- What you expected vs. what happened

### 💡 Suggesting Features

Open an issue tagged `enhancement`. Include:
- The use case (what problem does it solve?)
- Proposed API (if you have one)
- Whether you're willing to implement it

### 🔌 Building Storage Adapters

dream-memory ships with filesystem and in-memory stores. The community can build:
- Redis adapter
- Postgres/SQLite adapter
- Pinecone/Qdrant (vector DB) adapter
- S3/GCS adapter

Implement the `MemoryStoreAdapter` interface and open a PR or publish your own package.

### 📝 Improving Documentation

The best documentation comes from people who hit friction using the library. If anything was confusing, fix it and open a PR.

---

## Development Setup

### Prerequisites

- Node.js 18+
- npm 8+

### Setup

```bash
# Clone the repo
git clone https://github.com/shubhamdusane/dream-memory.git
cd dream-memory

# Install dependencies
cd packages/dream-core
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode (development)
npm run dev
```

### Environment Variables

Create a `.env` file in `packages/dream-core/` for running examples:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Project Structure

```
dream-memory/
├── packages/
│   └── dream-core/
│       ├── src/
│       │   ├── dream.ts              # Main public API
│       │   ├── types/index.ts        # All TypeScript types
│       │   ├── store/
│       │   │   └── filesystem.ts     # FileSystem + InMemory stores
│       │   ├── consolidator/
│       │   │   ├── consolidator.ts   # 4-phase dream pass logic
│       │   │   └── prompts.ts        # Consolidation + scoring prompts
│       │   ├── scheduler/
│       │   │   └── scheduler.ts      # Gate logic + auto-scheduling
│       │   └── utils/
│       │       └── llm.ts            # Unified LLM client
│       ├── tests/
│       │   └── dream.test.ts         # Full test suite
│       └── examples/
│           ├── quickstart.ts
│           └── langchain-integration.ts
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # Run tests on every PR
│   │   └── publish.yml               # Publish to npm on release
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       └── feature_request.md
└── README.md
```

---

## Making Changes

### Branch naming

```
feature/redis-adapter
fix/memory-scan-race-condition
docs/add-postgres-example
chore/upgrade-typescript
```

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Redis storage adapter
fix: handle empty session transcripts gracefully
docs: add LangGraph integration example
test: add edge cases for scheduler gate logic
chore: upgrade TypeScript to 5.5
```

---

## Tests

All PRs must have tests. We use Jest.

```bash
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Run a specific test file
npx jest tests/dream.test.ts

# Run with verbose output
npx jest --verbose
```

### Writing tests

Tests live in `tests/`. Mock the LLM client to avoid real API calls:

```typescript
jest.mock('../src/utils/llm.js')
const MockLLMClient = LLMClient as jest.MockedClass<typeof LLMClient>
MockLLMClient.prototype.complete = jest.fn().mockResolvedValue({
  content: JSON.stringify({
    create: [], update: [], delete: [],
    summary: 'Nothing to consolidate.'
  })
})
```

Use `InMemoryStore` for tests that don't need filesystem:

```typescript
const dream = new Dream({
  llm: { model: 'gpt-4o-mini', provider: 'openai', apiKey: 'test' },
  store: { type: 'memory' },
})
```

---

## Pull Request Process

1. Fork the repo and create your branch from `main`
2. Add tests for your changes
3. Make sure all tests pass: `npm test`
4. Make sure TypeScript compiles: `npm run typecheck`
5. Update the README if you're adding a feature
6. Submit your PR with a clear description of what it does and why

### PR checklist

- [ ] Tests added/updated
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] All tests pass (`npm test`)
- [ ] README updated (if adding features or APIs)
- [ ] Commit messages follow Conventional Commits

---

## Areas That Need Help

These are the highest-value contributions right now:

### 🔥 High Priority

| Area | Description |
|------|-------------|
| **Redis adapter** | `MemoryStoreAdapter` implementation using `ioredis` |
| **PostgreSQL adapter** | Using `pg` or `drizzle-orm` |
| **SQLite adapter** | Zero-infra persistent storage with `better-sqlite3` |
| **LangChain middleware** | Clean wrapper that plugs into LangChain memory interface |
| **Python port** | `dream` in Python for the LangChain/LlamaIndex ecosystem |

### 📚 Documentation

| Area | Description |
|------|-------------|
| **LangGraph example** | Full agent with dream memory using LangGraph |
| **LlamaIndex example** | Integration with LlamaIndex workflows |
| **FastAPI example** | REST API with persistent dream memory |

### 🧪 Tests

| Area | Description |
|------|-------------|
| **Filesystem store tests** | Currently untested due to tmp directory complexity |
| **Concurrency tests** | Multiple agents dreaming simultaneously |
| **Large memory tests** | Behavior with 200+ memories |

---

## Questions?

Open a GitHub Discussion or file an issue. We respond within 48 hours.

---

Thank you for making dream better. 🌙
