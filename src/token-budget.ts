/**
 * TokenBudget — Priority-based token allocation for LLM context.
 *
 * Replaces naive message count caps with smart allocation.
 * Each section declares its content, priority, and overflow strategy.
 * compile() fits everything within the budget, dropping/shrinking
 * low-priority sections first.
 *
 * @example
 * ```typescript
 * const budget = new TokenBudget({ limit: 8192, countTokens: estimateTokens });
 *
 * budget.reserve('system', systemPrompt, { priority: 'fixed' });
 * budget.reserve('history', messages, { priority: 'high', strategy: 'tail' });
 * budget.reserve('knowledge', chunks, { priority: 'medium', strategy: 'rank' });
 * budget.reserve('state', stateContext, { priority: 'low', droppable: true });
 *
 * const result = budget.compile();
 * // result.sections — what fits
 * // result.dropped  — what was cut
 * // result.usage    — { used, limit, utilization }
 * ```
 */

/** Priority levels — fixed items are never dropped */
export type BudgetPriority = 'fixed' | 'high' | 'medium' | 'low';

/** How to shrink a section when budget overflows */
export type ShrinkStrategy =
  | 'tail' // keep last N items that fit (for message arrays)
  | 'rank' // keep highest-scored items (for ranked chunks)
  | 'truncate' // hard character cut on the content string
  | 'none'; // cannot shrink — either fits or gets dropped

/** Options for a budget reservation */
export interface ReserveOptions {
  /** Priority level (default: medium) */
  priority?: BudgetPriority;
  /** How to shrink when over budget (default: none) */
  strategy?: ShrinkStrategy;
  /** Can this section be dropped entirely? (default: false, true for 'low' priority) */
  droppable?: boolean;
  /** Minimum tokens to keep even when shrinking (default: 0) */
  minTokens?: number;
  /**
   * Overflow policy for `strategy: 'rank'` (ignored otherwise). Scores are
   * opaque to Mosaic — this only decides what happens at the first item that
   * does not fit after sorting:
   * - `'prefix'` (default): stop packing — the result is a prefix of the
   *   score-sorted list (the historical behavior).
   * - `'best-fit'`: skip the item that does not fit and keep packing smaller
   *   items — fills the budget better, but the result is not a prefix.
   */
  onOverflow?: 'prefix' | 'best-fit';
  /**
   * Rerank hook for `strategy: 'rank'` (ignored otherwise) — the integration
   * point for reranker knowledge (cross-encoder scores, intent boosts, ...).
   * Called once, synchronously, and only when the section actually has to
   * shrink — never when everything fits, so the cost is paid only under budget
   * pressure. The returned array is what gets score-sorted (stable) and packed;
   * the hook may reorder items and/or update their scores.
   */
  rerank?: (items: ScoredItem[]) => ScoredItem[];
}

/** A content item with an optional score (for rank strategy). The score is opaque to Mosaic — only its ordering matters. */
export interface ScoredItem {
  content: string;
  score?: number;
}

/** A reserved section in the budget */
interface BudgetSection {
  name: string;
  items: ScoredItem[];
  tokens: number;
  priority: BudgetPriority;
  strategy: ShrinkStrategy;
  droppable: boolean;
  minTokens: number;
  onOverflow: 'prefix' | 'best-fit';
  rerank?: (items: ScoredItem[]) => ScoredItem[];
}

/** Result of compiling the budget */
export interface BudgetResult {
  /** Sections that fit within budget, with their (possibly shrunk) content */
  sections: Record<string, string[]>;
  /** Names of sections that were dropped */
  dropped: string[];
  /** Names of sections that were shrunk */
  shrunk: string[];
  /** Token usage statistics */
  usage: {
    used: number;
    limit: number;
    utilization: number;
  };
  /** Per-section token counts after compile (dropped sections show 0) */
  sectionUsage: Record<string, number>;
}

/** Token counting function — provided by the application */
export type TokenCounter = (text: string) => number;

/** Simple char/4 token estimator — good enough for most cases */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Priority-based token allocator. Sections are reserved with content and a
 * priority, then `compile()` fits them within the limit: droppable sections are
 * cut first (lowest priority first), then shrinkable sections are reduced via
 * their strategy. `fixed` sections are never dropped or shrunk, so the result
 * can exceed the limit when fixed content alone overflows.
 */
export class TokenBudget {
  private sections: BudgetSection[] = [];
  private readonly countTokens: TokenCounter;
  private readonly limit: number;

  /**
   * @param options.limit - Total token budget. A non-positive limit means every
   *   section overflows.
   * @param options.countTokens - Token counter for content strings (default:
   *   {@link estimateTokens}, ~4 chars per token).
   */
  constructor(options: { limit: number; countTokens?: TokenCounter }) {
    this.limit = options.limit;
    this.countTokens = options.countTokens ?? estimateTokens;
  }

  /**
   * Reserve a section of the budget with string content.
   * @throws If a section with the same name is already reserved.
   */
  reserve(name: string, content: string, options?: ReserveOptions): void {
    this.reserveItems(name, [{ content }], options);
  }

  /**
   * Reserve a section with multiple items (messages, chunks, etc.).
   * Each item has content and an optional score (for rank strategy).
   * @throws If a section with the same name is already reserved — names are
   *   unique because compile results are keyed by section name.
   */
  reserveItems(name: string, items: ScoredItem[], options?: ReserveOptions): void {
    if (this.sections.some((s) => s.name === name)) {
      throw new Error(`[Mosaic] Budget section "${name}" is already reserved`);
    }
    const priority = options?.priority ?? 'medium';
    const reservedItems = items.map((item) => (item.score === undefined ? { content: item.content } : { content: item.content, score: item.score }));
    const totalTokens = reservedItems.reduce((sum, item) => sum + this.countTokens(item.content), 0);

    this.sections.push({
      name,
      items: reservedItems,
      tokens: totalTokens,
      priority,
      strategy: options?.strategy ?? 'none',
      droppable: options?.droppable ?? priority === 'low',
      minTokens: options?.minTokens ?? 0,
      onOverflow: options?.onOverflow ?? 'prefix',
      rerank: options?.rerank,
    });
  }

  /**
   * Compile the budget — fit all sections within the token limit.
   *
   * Algorithm:
   * 1. Calculate total tokens needed
   * 2. If within budget, return everything
   * 3. If over budget, shrink/drop sections from lowest priority first:
   *    - 'low' droppable sections dropped first
   *    - Then 'medium' sections shrunk via their strategy
   *    - Then 'high' sections shrunk
   *    - 'fixed' sections are never touched
   */
  compile(): BudgetResult {
    const result: BudgetResult = {
      sections: {},
      dropped: [],
      shrunk: [],
      usage: { used: 0, limit: this.limit, utilization: 0 },
      sectionUsage: {},
    };

    // Calculate total
    let totalTokens = this.sections.reduce((sum, s) => sum + s.tokens, 0);

    // If within budget, return everything
    if (totalTokens <= this.limit) {
      for (const section of this.sections) {
        result.sections[section.name] = section.items.map((i) => i.content);
        result.sectionUsage[section.name] = section.tokens;
      }
      result.usage.used = totalTokens;
      result.usage.utilization = this.limit > 0 ? totalTokens / this.limit : 0;
      return result;
    }

    // Over budget — need to shrink/drop
    // Sort by priority for processing (low → medium → high → fixed)
    const priorityOrder: Record<BudgetPriority, number> = { low: 0, medium: 1, high: 2, fixed: 3 };
    const sortedSections = [...this.sections].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // Track which sections to include and their adjusted items
    const sectionState = new Map<string, { items: ScoredItem[]; tokens: number; dropped: boolean; shrunk: boolean }>();
    for (const section of sortedSections) {
      sectionState.set(section.name, { items: [...section.items], tokens: section.tokens, dropped: false, shrunk: false });
    }

    let overflow = totalTokens - this.limit;

    // Pass 1: Drop droppable sections (lowest priority first)
    for (const section of sortedSections) {
      if (overflow <= 0) break;
      if (!section.droppable) continue;

      const state = sectionState.get(section.name)!;
      overflow -= state.tokens;
      totalTokens -= state.tokens;
      state.dropped = true;
      state.tokens = 0;
      state.items = [];
    }

    // Pass 2: Shrink remaining sections (lowest priority first, skip fixed)
    for (const section of sortedSections) {
      if (overflow <= 0) break;
      if (section.priority === 'fixed') continue;

      const state = sectionState.get(section.name)!;
      if (state.dropped) continue;
      if (section.strategy === 'none') continue;

      const tokensToFree = Math.min(overflow, state.tokens - section.minTokens);
      if (tokensToFree <= 0) continue;

      const targetTokens = state.tokens - tokensToFree;
      const shrunkItems = this.shrinkSection(section, state.items, targetTokens);
      const newTokens = shrunkItems.reduce((sum, item) => sum + this.countTokens(item.content), 0);
      const freed = state.tokens - newTokens;

      state.items = shrunkItems;
      state.tokens = newTokens;
      state.shrunk = true;
      overflow -= freed;
      totalTokens -= freed;
    }

    // Build result (in original insertion order)
    for (const section of this.sections) {
      const state = sectionState.get(section.name)!;
      if (state.dropped) {
        result.dropped.push(section.name);
        result.sectionUsage[section.name] = 0;
      } else {
        result.sections[section.name] = state.items.map((i) => i.content);
        result.sectionUsage[section.name] = state.tokens;
        if (state.shrunk) {
          result.shrunk.push(section.name);
        }
      }
    }

    result.usage.used = totalTokens;
    result.usage.utilization = this.limit > 0 ? totalTokens / this.limit : 0;
    return result;
  }

  /** Shrink a section's items to fit within targetTokens */
  private shrinkSection(section: BudgetSection, items: ScoredItem[], targetTokens: number): ScoredItem[] {
    switch (section.strategy) {
      case 'tail':
        return this.shrinkTail(items, targetTokens);
      case 'rank': {
        // The rerank hook runs only on this path — i.e., only when the section
        // actually has to shrink — so its cost is never paid when everything fits.
        const pool = section.rerank ? section.rerank(items) : items;
        return this.shrinkRank(pool, targetTokens, section.onOverflow);
      }
      case 'truncate':
        return this.shrinkTruncate(items, targetTokens);
      default:
        return items;
    }
  }

  /** Keep the last N items that fit (for message history) */
  private shrinkTail(items: ScoredItem[], targetTokens: number): ScoredItem[] {
    let total = 0;
    const result: ScoredItem[] = [];

    // Walk from the end (most recent first)
    for (let i = items.length - 1; i >= 0; i--) {
      const tokens = this.countTokens(items[i].content);
      if (total + tokens > targetTokens) break;
      result.unshift(items[i]);
      total += tokens;
    }

    return result;
  }

  /** Keep the highest-scored items that fit (for RAG chunks).
   *  Sort is STABLE on ties — insertion order wins — so callers can compose
   *  deterministic ranking by applying small score boosts in a pre-pass.
   *  `onOverflow: 'prefix'` stops at the first item that does not fit;
   *  `'best-fit'` skips it and keeps packing smaller items. */
  private shrinkRank(items: ScoredItem[], targetTokens: number, onOverflow: 'prefix' | 'best-fit'): ScoredItem[] {
    // Sort by score descending, tie-break by original insertion index
    const sorted = [...items]
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const diff = (b.item.score ?? 0) - (a.item.score ?? 0);
        return diff !== 0 ? diff : a.idx - b.idx;
      })
      .map(({ item }) => item);

    let total = 0;
    const result: ScoredItem[] = [];

    for (const item of sorted) {
      const tokens = this.countTokens(item.content);
      if (total + tokens > targetTokens) {
        if (onOverflow === 'best-fit') continue;
        break;
      }
      result.push(item);
      total += tokens;
    }

    return result;
  }

  /** Hard truncate the joined content to fit targetTokens, measured with the
   *  budget's own token counter: content that already fits is returned whole;
   *  otherwise a fitting prefix is cut by binary search and '...' appended.
   *  The contract is the FIT GUARANTEE — the result never exceeds targetTokens
   *  by the counter's measure — not maximum retention: real tokenizers are not
   *  monotone over prefixes (a longer prefix can tokenize cheaper), so the
   *  search may stop short of the longest fitting prefix. */
  private shrinkTruncate(items: ScoredItem[], targetTokens: number): ScoredItem[] {
    if (items.length === 0) return [];

    const ELLIPSIS = '...';
    const combined = items.map((i) => i.content).join('\n');

    if (this.countTokens(combined) <= targetTokens) return [{ content: combined }];

    // Even the ellipsis does not fit — emit nothing rather than exceed the target.
    if (this.countTokens(ELLIPSIS) > targetTokens) return [{ content: '' }];

    // Binary search a fitting prefix with the ellipsis appended. Invariant
    // maintained: lo fits, hi does not — the result always fits. It is NOT
    // necessarily the longest fitting prefix: token counts are not
    // non-decreasing over prefixes for real tokenizers (e.g. tiktoken merges
    // 'international' into a single token), so maximality is not contracted.
    let lo = 0;
    let hi = combined.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.countTokens(combined.substring(0, mid) + ELLIPSIS) <= targetTokens) lo = mid;
      else hi = mid;
    }

    return [{ content: `${combined.substring(0, lo)}${ELLIPSIS}` }];
  }
}
