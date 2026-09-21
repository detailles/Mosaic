/**
 * Mosaic — Context management for LLM applications.
 *
 * Your context is a mosaic of pieces — messages, state, knowledge, metadata.
 * Mosaic helps you manage them with typed slots, lenses, transactions, and token budgets.
 * This public entry point constructs immutable lens definitions; it does not own application state or permissions.
 */

import type { LensDef, LensSlots } from './types.js';

export { ContextManager, ScopedContextManager, TurnTransaction } from './context-manager.js';
export type { RenderOptions } from './renderers.js';
export { renderConversationSummary, renderRouterContext } from './renderers.js';
export type { BudgetPriority, BudgetResult, ReserveOptions, ScoredItem, ShrinkStrategy, TokenCounter } from './token-budget.js';
export { estimateTokens, TokenBudget } from './token-budget.js';
export type {
  ContextInspection,
  ContextSnapshot,
  CtxMessage,
  ILogger,
  KnowledgeChunk,
  KnowledgeLensConfig,
  LensDef,
  LensSlots,
  LensSlotValues,
  LensView,
  MessagePair,
  MessageRole,
  RecentOptions,
  SlotDef,
  SlotLifecycle,
  SlotPersistence,
  SlotState,
  StagedChange,
  TransactionSummary,
} from './types.js';

/**
 * Captures immutable selection options and preserves typed slot aliases in the resulting view.
 * A name is diagnostic only. Reuse a definition while its parameters stay fixed; replace it when external
 * predicate parameters change. Slot values themselves remain owned by ContextManager, not copied into the lens.
 */
export function defineLens<const Slots extends LensSlots | undefined = undefined>(name: string, config: Omit<LensDef<Slots>, 'name'>): LensDef<Slots> {
  const slots = config.slots;
  const selectedSlots = typeof slots === 'object' && slots !== null ? Object.freeze(Array.isArray(slots) ? [...slots] : { ...slots }) : slots;
  return Object.freeze({
    name,
    ...(config.messages
      ? {
          messages: Object.freeze({
            ...config.messages,
            ...(typeof config.messages.turns === 'object' ? { turns: Object.freeze({ ...config.messages.turns }) } : {}),
          }),
        }
      : {}),
    ...(slots !== undefined ? { slots: selectedSlots } : {}),
    ...(config.knowledge
      ? {
          knowledge: Object.freeze({
            ...config.knowledge,
            ...(config.knowledge.sources ? { sources: Object.freeze([...config.knowledge.sources]) } : {}),
          }),
        }
      : {}),
  }) as LensDef<Slots>;
}
