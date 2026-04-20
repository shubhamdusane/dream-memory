---
name: Bug Report
about: Something is broken
title: '[BUG] '
labels: bug
assignees: ''
---

## Describe the Bug

A clear description of what the bug is.

## To Reproduce

```typescript
// Minimal reproduction code
import { Dream } from '@dream-agent/core'

const dream = new Dream({ ... })
// steps that cause the bug
```

## Expected vs Actual

**Expected:** What you expected to happen
**Actual:** What actually happened

## Environment

- dream version: (run `npm list @dream-agent/core`)
- Node.js version: (run `node --version`)
- OS: (e.g. macOS 14, Ubuntu 22.04, Windows 11)
- LLM provider + model: (e.g. OpenAI gpt-4o-mini)

## Additional Context

Any error messages, stack traces, or logs.
