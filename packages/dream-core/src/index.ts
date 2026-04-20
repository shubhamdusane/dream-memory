export { Dream, createDream } from './dream.js'
export { FileSystemStore, InMemoryStore } from './store/filesystem.js'

export type {
  Memory,
  MemoryType,
  MemoryHeader,
  DreamConfig,
  DreamResult,
  DreamPhase,
  DreamEvent,
  Session,
  SessionMessage,
  LLMConfig,
  StoreConfig,
  ScheduleConfig,
  ConsolidationConfig,
  PruningConfig,
  MemoryStoreAdapter,
} from './types/index.js'
