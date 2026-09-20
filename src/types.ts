/**
 * Mosaic — Core Types
 *
 * Domain-specific state management for LLM context.
 * Framework-agnostic — no application-specific imports.
 */

// ── Logger ──────────────────────────────────────────────────────────

/** Minimal logger interface — bring your own implementation.
 *  Compatible with console, winston, pino, or any logger with a warn method. */
export interface ILogger {
  warn(message: string): void;
}

// ── Messages ────────────────────────────────────────────────────────

/** Message role in a conversation */
export type MessageRole = 'user' | 'assistant' | 'system';

/** A message in the conversation context */
export interface CtxMessage {
  role: MessageRole;
  content: string;
  timestamp: Date;
  /** Arbitrary metadata attached by the application */
  metadata?: Record<string, unknown>;
  /** Explicit tags set at write time — replaces content-parsing hacks.
   *  e.g., { responseType: 'clarification', confidence: '0.8' } */
  tags?: Record<string, string>;
}

/** A user/assistant exchange pair */
export interface MessagePair {
  user: CtxMessage;
  assistant: CtxMessage;
}

// ── Knowledge ───────────────────────────────────────────────────────

/** A retrieved knowledge chunk — the universal unit of RAG context */
export interface KnowledgeChunk {
  /** The text content of the chunk */
  content: string;
  /** Relevance score (0-1, higher is more relevant) */
  score: number;
  /** Source identifier — e.g., 'rag', 'web', 'database' */
  source?: string;
  /** Application-specific metadata (chunkId, documentTitle, url, etc.) */
  meta?: Record<string, unknown>;
}

/** Constraints for knowledge in a lens */
export interface KnowledgeLensConfig {
  /** Which sources to include (omit for all) */
  sources?: string[];
  /** Maximum number of items to return */
  top?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Optional predicate — chunk is excluded when returns false. Framework-agnostic;
   *  callers inject application logic via closures. Applied after source/minScore
   *  filters and before sort/top. Lenses with where-closures that capture mutable
   *  state must be rebuilt per turn since the view cache keys on lens name. */
  where?: (chunk: KnowledgeChunk) => boolean;
}

// ── Messages (continued) ────────────────────────────────────────────

/** Options for filtering recent messages */
export interface RecentOptions {
  /** Filter function applied to each message */
  filter?: (msg: CtxMessage) => boolean;
}

// ── Slots ───────────────────────────────────────────────────────────

/**
 * Slot persistence — hints to the token budget about priority.
 *
 * - `static`: essential context that should always be in the prompt
 *    (e.g., currentProduct, currentTopic). Budget: high priority, not droppable.
 * - `transient`: turn-level metadata that's useful but not critical
 *    (e.g., lastAnswerConfidence, keyTerms). Budget: low priority, droppable.
 * - `internal`: system-only state that is never rendered to the LLM
 *    (e.g., retryCount, lastResponseType). Budget: excluded entirely.
 *
 * This is separate from lifecycle (when to clear) — a slot can persist
 * across turns (lifecycle: persistent) but still be droppable from the
 * budget (persistence: transient).
 */
export type SlotPersistence = 'static' | 'transient' | 'internal';

/**
 * Slot lifecycle — controls when a slot's value is automatically cleared.
 *
 * - `persistent`: value persists until explicitly cleared (default)
 * - `consume-once`: value is cleared after the first `get()` — ideal for
 *    one-shot signals like pendingClarification
 * - `turn-scoped`: value is cleared at the start of each turn via `nextTurn()`
 *    — ideal for per-turn metadata that shouldn't leak across turns
 */
export type SlotLifecycle = 'persistent' | 'consume-once' | 'turn-scoped';

/**
 * Slot definition — describes a named, typed state container.
 *
 * Slots are strict: unset slots return `undefined` from `get()` and `peek()`.
 * There is intentionally no `defaultValue` — silent defaults hide mutation
 * and make it impossible to distinguish "never set" from "set to default."
 * If a slot needs an initial value, write it explicitly with `ctx.set()` at
 * registration time (the backend does this in `registerStateSlots`).
 */
export interface SlotDef<T = unknown> {
  /** Unique slot name */
  readonly name: string;
  /** Custom serializer for persistence (default: JSON-safe identity) */
  readonly serialize?: (value: T) => unknown;
  /** Custom deserializer for restore (default: identity) */
  readonly deserialize?: (raw: unknown) => T;
  /** Lifecycle — controls automatic clearing behavior (default: persistent) */
  readonly lifecycle?: SlotLifecycle;
  /** Owner — module name(s) allowed to write. When set, `set()` from
   *  a non-owner caller throws. Enforced via `ctx.as(name)` scoped handles. */
  readonly owner?: string | string[];
  /** Persistence hint for token budgeting (default: static).
   *  static = always include in prompt, transient = droppable under pressure. */
  readonly persistence?: SlotPersistence;
}

/** Internal slot state — value + metadata */
export interface SlotState<T = unknown> {
  value: T | undefined;
  /** Turn number when this slot was last written */
  lastSetAtTurn: number;
  /** How many times this slot has been written */
  writeCount: number;
}

// ── Transactions ────────────────────────────────────────────────────

/** A staged slot change within a transaction */
export interface StagedChange {
  slotName: string;
  /** 'set' = new value, 'clear' = reset to default */
  action: 'set' | 'clear';
  /** New value (undefined for clear) */
  value?: unknown;
  /** Previous value before staging */
  previousValue?: unknown;
}

/** Summary of what a transaction will apply on commit */
export interface TransactionSummary {
  changeCount: number;
  changes: StagedChange[];
  status: 'open' | 'committed' | 'rolled-back';
}

// ── Lenses ──────────────────────────────────────────────────────────

/** Lens definition — declares what a consumer needs from the context */
export interface LensDef {
  /** Lens name (for logging/debugging) */
  readonly name: string;
  /** Message constraints */
  readonly messages?: {
    /** Maximum number of recent messages to include */
    last?: number;
    /** Maximum character length per message content */
    maxChars?: number;
    /** Generic filter function — return false to exclude a message.
     *  Applied before `last` and `maxChars` constraints.
     *  Use this for application-specific filtering (e.g., skip refusals). */
    filter?: (msg: CtxMessage, index: number, all: CtxMessage[]) => boolean;
  };
  /** Which slots this lens can access — '*' for all, or array of slot names */
  readonly slots?: '*' | string[];
  /** Knowledge chunk constraints (omit to exclude knowledge from this lens) */
  readonly knowledge?: KnowledgeLensConfig;
}

/** The view returned by a lens — scoped, read-only access to context */
export interface LensView {
  /** Lens name */
  readonly name: string;
  /** Filtered messages according to lens constraints */
  readonly messages: readonly CtxMessage[];
  /** Scoped slot access — returns value if declared, undefined + warning if not */
  readonly slots: Record<string, unknown>;
  /** Knowledge chunks (filtered by lens config, sorted by score descending) */
  readonly knowledge: readonly KnowledgeChunk[];
  /** Message count (of the filtered set) */
  readonly messageCount: number;
  /** Conversation depth (user messages in the full context, not filtered) */
  readonly depth: number;
}

// ── Inspection ──────────────────────────────────────────────────────

/** Structured inspection of the full context state */
export interface ContextInspection {
  messageCount: number;
  depth: number;
  turnCount: number;
  slots: Record<
    string,
    {
      value: unknown;
      lifecycle: SlotLifecycle;
      persistence: SlotPersistence;
      owner?: string | string[];
      lastSetAtTurn: number;
      writeCount: number;
    }
  >;
  slotCount: number;
  activeSlotCount: number;
  knowledgeCount: number;
  knowledgeSources: string[];
}

// ── Snapshots ───────────────────────────────────────────────────────

/** Serializable snapshot of full context state */
export interface ContextSnapshot {
  messages: Array<{
    role: MessageRole;
    content: string;
    timestamp: string; // ISO string for JSON safety
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  }>;
  slots: Record<string, unknown>;
  turnCount: number;
}
