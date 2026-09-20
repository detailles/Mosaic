/**
 * Mosaic — Context management for LLM applications.
 *
 * Your context is a mosaic of pieces — messages, state, knowledge, metadata.
 * Mosaic helps you manage them with typed slots, lenses, transactions, and token budgets.
 */

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

/** Convenience helper to create a lens definition */
export function defineLens(name: string, config: Omit<import('./types.js').LensDef, 'name'>): import('./types.js').LensDef {
  return { name, ...config };
}
