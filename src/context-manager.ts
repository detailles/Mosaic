/**
 * Mosaic — ContextManager
 *
 * Core class for managing LLM conversation context.
 * Holds messages + typed slots. Provides query methods, lenses,
 * transactions, and inspection for organized context management.
 *
 * Framework-agnostic — no application-specific imports. Chat adapters own turn boundaries;
 * this manager stamps and persists them without inferring turns from messages or scenario steps.
 */

import type {
  ContextInspection,
  ContextSnapshot,
  CtxMessage,
  ILogger,
  KnowledgeChunk,
  LensDef,
  LensSlots,
  LensSlotValues,
  LensView,
  MessagePair,
  MessageRole,
  RecentOptions,
  SlotDef,
  SlotLifecycle,
  SlotState,
  StagedChange,
  TransactionSummary,
} from './types.js';

/** No-op logger — used when no logger is provided */
const NOOP_LOGGER: ILogger = { warn: () => {} };

/**
 * ContextManager — owns the full conversation context: messages, typed slots,
 * and knowledge chunks. Slots are strict (unset reads return `undefined` — no
 * silent defaults); reads through `get()`/`has()`/`through()` see staged writes
 * of the open transaction (read-your-writes), while `peek()` always reads
 * committed state. At most one transaction may be open at a time.
 */
export class ContextManager {
  private _messages: CtxMessage[] = [];
  private slots: Map<string, SlotState> = new Map();
  private slotDefs: Map<string, SlotDef> = new Map();
  private _knowledge: KnowledgeChunk[] = [];
  private _callerIdentity: string | null = null;
  private _turnCount = 0;
  private _activeTransaction: TurnTransaction | null = null;
  private _viewCache = new WeakMap<LensDef, LensView>();
  private readonly logger: ILogger;

  private readonly maxMessages: number;

  /**
   * @param options.maxMessages - Cap on retained messages; the oldest are trimmed
   *   once the cap is exceeded (default 50; `0` disables trimming).
   * @param options.logger - Receives soft-enforcement warnings (default: silent no-op).
   */
  constructor(options?: { maxMessages?: number; logger?: ILogger }) {
    this.maxMessages = options?.maxMessages ?? 50;
    this.logger = options?.logger ?? NOOP_LOGGER;
  }

  /**
   * Access the message array. Subclasses (adapters) override this
   * to read from external sources without copying data.
   */
  protected getMessages(): readonly CtxMessage[] {
    return this._messages;
  }

  // ── Message Operations ──────────────────────────────────────────

  /** Append a message in the current chat turn and trim to `maxMessages`, without renumbering retained messages. */
  addMessage(role: MessageRole, content: string, options?: { metadata?: Record<string, unknown>; tags?: Record<string, string> }): void {
    this._messages.push({
      role,
      content,
      timestamp: new Date(),
      turn: this._turnCount,
      metadata: options?.metadata,
      tags: options?.tags,
    });

    if (this.maxMessages > 0 && this._messages.length > this.maxMessages) {
      this._messages = this._messages.slice(-this.maxMessages);
    }
    this._invalidateViews();
  }

  /** All retained messages, oldest first. The array is live — do not mutate it. */
  allMessages(): readonly CtxMessage[] {
    return this.getMessages();
  }

  /** Number of retained messages (after `maxMessages` trimming). */
  get messageCount(): number {
    return this.getMessages().length;
  }

  // ── Message Queries ─────────────────────────────────────────────

  /** The most recent message with the given role, or `undefined` if none exists. */
  lastByRole(role: MessageRole): CtxMessage | undefined {
    const msgs = this.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === role) {
        return msgs[i];
      }
    }
    return undefined;
  }

  /**
   * The `count` most recent messages, oldest first. `options.filter` is applied
   * after slicing, so it can only shrink the result below `count`.
   * `count` is normalized defensively: `0`, negative or `NaN` returns `[]`
   * (never the full history), non-integers are floored.
   */
  recent(count: number, options?: RecentOptions): CtxMessage[] {
    const n = clampCount(count);
    if (n === 0) return [];
    const msgs = this.getMessages();
    const slice = msgs.slice(-n);
    if (!options?.filter) return [...slice];
    return [...slice].filter(options.filter);
  }

  /**
   * The `count` most recent adjacent user→assistant exchanges, oldest first.
   * Messages without an adjacent counterpart (system lines, orphans) are skipped.
   * `count` is normalized like `recent()`: `0`, negative or `NaN` returns `[]`,
   * non-integers are floored.
   */
  recentPairs(count: number): MessagePair[] {
    const n = clampCount(count);
    const msgs = this.getMessages();
    const pairs: MessagePair[] = [];

    for (let i = msgs.length - 1; i >= 1 && pairs.length < n; i--) {
      if (msgs[i].role === 'assistant' && msgs[i - 1].role === 'user') {
        pairs.unshift({
          user: msgs[i - 1],
          assistant: msgs[i],
        });
        i--;
      }
    }

    return pairs;
  }

  /** Conversation depth: the number of user messages in the full retained history. */
  depth(): number {
    let count = 0;
    for (const msg of this.getMessages()) {
      if (msg.role === 'user') count++;
    }
    return count;
  }

  /**
   * Case-insensitive substring search over message content, most recent match first.
   * `options.role` restricts by role; `options.limit` caps the number of matches —
   * `undefined` means unbounded, while `0`, negative or `NaN` returns no matches.
   */
  search(query: string, options?: { limit?: number; role?: MessageRole }): CtxMessage[] {
    const limit = options?.limit === undefined ? undefined : clampCount(options.limit);
    if (limit === 0) return [];

    const lowerQuery = query.toLowerCase();
    const results: CtxMessage[] = [];
    const msgs = this.getMessages();

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (options?.role && msg.role !== options.role) continue;
      if (msg.content.toLowerCase().includes(lowerQuery)) {
        results.push(msg);
        if (limit !== undefined && results.length >= limit) break;
      }
    }

    return results;
  }

  /** All messages carrying the exact tag `tagName: tagValue`, in history order. */
  getByTag(tagName: string, tagValue: string): CtxMessage[] {
    return [...this.getMessages()].filter((msg) => msg.tags?.[tagName] === tagValue);
  }

  /** True when the most recent assistant message carries the exact tag `tagName: tagValue`. */
  lastAssistantHasTag(tagName: string, tagValue: string): boolean {
    const last = this.lastByRole('assistant');
    return last?.tags?.[tagName] === tagValue;
  }

  // ── Knowledge ──────────────────────────────────────────────────

  /** Add retrieved knowledge chunks. Appends to existing — call clearKnowledge() first for a fresh set. */
  addKnowledge(source: string, chunks: Array<{ content: string; score: number; meta?: Record<string, unknown> }>): void {
    for (const chunk of chunks) {
      this._knowledge.push({ content: chunk.content, score: chunk.score, source, meta: chunk.meta });
    }
    this._invalidateViews();
  }

  /** Get all knowledge chunks, optionally filtered by source. Sorted by score descending.
   *  Filter order: sources → minScore → where → sort → top. */
  getKnowledge(options?: { sources?: readonly string[]; top?: number; minScore?: number; where?: (chunk: KnowledgeChunk) => boolean }): KnowledgeChunk[] {
    let items = [...this._knowledge];

    if (options?.sources) {
      const sources = new Set(options.sources);
      items = items.filter((c) => c.source !== undefined && sources.has(c.source));
    }
    if (options?.minScore !== undefined) {
      const min = options.minScore;
      items = items.filter((c) => c.score >= min);
    }
    if (options?.where) {
      items = items.filter(options.where);
    }

    items.sort((a, b) => b.score - a.score);

    if (options?.top !== undefined) {
      items = items.slice(0, clampCount(options.top));
    }

    return items;
  }

  /** Clear all knowledge chunks (called at start of each turn) */
  clearKnowledge(): void {
    this._knowledge = [];
    this._invalidateViews();
  }

  /** Get the total number of knowledge chunks */
  get knowledgeCount(): number {
    return this._knowledge.length;
  }

  // ── Slot Operations ─────────────────────────────────────────────

  /**
   * Register a typed slot. Redefining an existing name replaces the definition
   * but keeps the current value. Unset slots read as `undefined` — there is no
   * default value; seed one explicitly with `set()` if needed. (`null` is a
   * stored value, distinct from unset: `has()` is `true` for it, but it is
   * skipped by `slotsByPersistence()` and never rendered.)
   * @returns The slot definition to pass to `get`/`set`/`peek`/`has`/`clear`.
   */
  defineSlot<T>(
    name: string,
    options?: {
      serialize?: (v: T) => unknown;
      deserialize?: (raw: unknown) => T;
      lifecycle?: SlotLifecycle;
      owner?: string | string[];
      persistence?: import('./types.js').SlotPersistence;
    }
  ): SlotDef<T> {
    const def: SlotDef<T> = {
      name,
      serialize: options?.serialize,
      deserialize: options?.deserialize,
      lifecycle: options?.lifecycle,
      owner: options?.owner,
      persistence: options?.persistence,
    };

    this.slotDefs.set(name, def as SlotDef);

    if (!this.slots.has(name)) {
      this.slots.set(name, {
        value: undefined,
        lastSetAtTurn: 0,
        writeCount: 0,
      });
    }

    return def;
  }

  /**
   * Read a slot. During an open transaction, staged writes are visible
   * (read-your-writes). Unset slots return `undefined`.
   *
   * Reading a `consume-once` slot consumes it — the value is cleared and cached
   * lens views are invalidated — but only when no transaction is open. During an
   * open transaction the read sees the staged/committed value without consuming
   * it (deliberate: the rollback semantics of consumption are undefined).
   */
  get<T>(slot: SlotDef<T>): T | undefined {
    // During an active transaction, prefer staged writes (read-your-writes)
    if (this._activeTransaction?.status === 'open') {
      return this._activeTransaction.get(slot);
    }

    const state = this.slots.get(slot.name);
    if (!state || state.value === undefined) return undefined;

    const value = state.value as T;

    const def = this.slotDefs.get(slot.name);
    if (def?.lifecycle === 'consume-once') {
      state.value = undefined;
      // Consuming is a mutation: cached lens views holding the pre-consume value are stale.
      this._invalidateViews();
    }

    return value;
  }

  /**
   * Read committed state directly: bypasses an open transaction's staged writes
   * and never consumes a `consume-once` slot. Unset slots return `undefined`.
   */
  peek<T>(slot: SlotDef<T>): T | undefined {
    const state = this.slots.get(slot.name);
    if (!state || state.value === undefined) return undefined;
    return state.value as T;
  }

  /**
   * Write a slot. Throws if the caller identity (set via `as()`) is not an owner
   * of the slot. While a transaction is open the write is staged into it, so
   * `rollback()` undoes it and `commit()` applies it atomically. Object values
   * are stored as isolated deep-frozen copies: mutating a value you passed in or
   * read out cannot change committed state.
   */
  set<T>(slot: SlotDef<T>, value: T): void {
    const def = this.slotDefs.get(slot.name);
    if (def?.owner && this._callerIdentity) {
      const owners = Array.isArray(def.owner) ? def.owner : [def.owner];
      if (!owners.includes(this._callerIdentity)) {
        throw new Error(`[Mosaic] Slot "${slot.name}" is owned by [${owners.join(', ')}], caller "${this._callerIdentity}" cannot write`);
      }
    }

    // If a transaction is open, forward the write so it can be rolled back.
    // Historically ctx.set() wrote directly to committed state even during an
    // open transaction, which meant rollback could not undo it. Callers are
    // free to keep using ctx.set() — the forwarding is invisible from the
    // outside, and read-your-writes still works through transaction.get().
    if (this._activeTransaction?.status === 'open') {
      this._activeTransaction.set(slot, value);
      return;
    }

    this._commitDirect(slot, value);
  }

  /** Internal: write to committed state without touching the active transaction.
   *  The stored value is an isolated deep-frozen copy: a caller that mutates an object it read
   *  cannot change committed state behind the transaction (and rollback) boundary. */
  _commitDirect<T>(slot: SlotDef<T>, value: T): void {
    const isolated = isolate(value);
    const state = this.slots.get(slot.name);
    if (!state) {
      this.slots.set(slot.name, {
        value: isolated,
        lastSetAtTurn: this._turnCount,
        writeCount: 1,
      });
      this._invalidateViews();
      return;
    }

    state.value = isolated;
    state.lastSetAtTurn = this._turnCount;
    state.writeCount++;
    this._invalidateViews();
  }

  /** Internal: the value a reader sees right now — staged change first, committed state otherwise. */
  _effective(name: string): unknown {
    if (this._activeTransaction?.status === 'open') {
      const staged = this._activeTransaction.staged.get(name);
      if (staged) return staged.action === 'clear' ? undefined : staged.value;
    }
    return this.slots.get(name)?.value;
  }

  /** Internal: any staged or committed change invalidates definition-scoped cached views. */
  _invalidateViews(): void {
    this._viewCache = new WeakMap();
  }

  /**
   * True when the slot currently holds a value. Unset means `undefined`; `null`
   * is a stored value, so `has()` returns `true` for it — but `null` values are
   * skipped by `slotsByPersistence()` and never rendered to the LLM. During an
   * open transaction this reflects staged changes, consistent with `get()`.
   */
  has(slot: Pick<SlotDef, 'name'>): boolean {
    // Reads see your writes within the same turn: during an open transaction,
    // has() answers about the staged value, same as get().
    if (this._activeTransaction?.status === 'open') {
      return this._effective(slot.name) !== undefined;
    }
    const state = this.slots.get(slot.name);
    return state !== undefined && state.value !== undefined;
  }

  /**
   * Reset a slot to unset (`undefined`). Ownership is enforced exactly as for
   * `set()`; while a transaction is open the clear is staged into it.
   */
  clear(slot: Pick<SlotDef, 'name'>): void {
    // Ownership applies to clear exactly as to set: a foreign owner cannot erase a slot either.
    const def = this.slotDefs.get(slot.name);
    if (def?.owner && this._callerIdentity) {
      const owners = Array.isArray(def.owner) ? def.owner : [def.owner];
      if (!owners.includes(this._callerIdentity)) {
        throw new Error(`[Mosaic] Slot "${slot.name}" is owned by [${owners.join(', ')}], caller "${this._callerIdentity}" cannot clear`);
      }
    }
    if (this._activeTransaction?.status === 'open') {
      this._activeTransaction.clear(slot);
      return;
    }
    this._clearDirect(slot);
  }

  /** Internal: clear a slot without touching the active transaction. */
  _clearDirect(slot: Pick<SlotDef, 'name'>): void {
    const state = this.slots.get(slot.name);
    if (state) {
      state.value = undefined;
      this._invalidateViews();
    }
  }

  /**
   * Committed values of all defined slots, keyed by name (unset slots appear as
   * `undefined`). Ignores staged transaction changes.
   */
  allSlots(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, state] of this.slots) {
      result[name] = state.value;
    }
    return result;
  }

  /**
   * Get slot values grouped by persistence type — for token budget integration.
   * - static: reserve with high priority (not droppable)
   * - transient: reserve with low priority (droppable)
   * - internal: excluded from budget entirely (never rendered to LLM)
   */
  slotsByPersistence(): { static: Record<string, unknown>; transient: Record<string, unknown>; internal: Record<string, unknown> } {
    const result = { static: {} as Record<string, unknown>, transient: {} as Record<string, unknown>, internal: {} as Record<string, unknown> };
    for (const [name, state] of this.slots) {
      if (state.value === undefined || state.value === null) continue;
      const def = this.slotDefs.get(name);
      const persistence = def?.persistence ?? 'static';
      result[persistence][name] = state.value;
    }
    return result;
  }

  // ── Inspection ─────────────────────────────────────────────────

  /**
   * Structured readout of the full context state — message/turn counts and
   * per-slot value, lifecycle, persistence, owner, and write metadata.
   * Reflects committed state (staged transaction changes are not included).
   */
  inspect(): ContextInspection {
    const slotEntries: ContextInspection['slots'] = {};
    for (const [name, state] of this.slots) {
      const def = this.slotDefs.get(name);
      slotEntries[name] = {
        value: state.value,
        lifecycle: def?.lifecycle ?? 'persistent',
        persistence: def?.persistence ?? 'static',
        owner: def?.owner,
        lastSetAtTurn: state.lastSetAtTurn,
        writeCount: state.writeCount,
      };
    }

    return {
      messageCount: this.getMessages().length,
      depth: this.depth(),
      turnCount: this._turnCount,
      slots: slotEntries,
      slotCount: this.slots.size,
      activeSlotCount: [...this.slots.values()].filter((s) => s.value !== undefined && s.value !== null).length,
      knowledgeCount: this._knowledge.length,
      knowledgeSources: [...new Set(this._knowledge.map((k) => k.source).filter(Boolean) as string[])],
    };
  }

  // ── Lenses ─────────────────────────────────────────────────────

  /**
   * Get a scoped, read-only view of the context through a lens.
   * Messages and slots are filtered/constrained per immutable lens definition, not display name.
   * Accessing an undeclared slot logs a warning and returns the value (soft enforcement).
   */
  through<Slots extends LensSlots | undefined>(lens: LensDef<Slots>): LensView<Slots> {
    const cached = this._viewCache.get(lens);
    if (cached) return cached as LensView<Slots>;

    let messages = [...this.getMessages()];

    const turns = lens.messages?.turns;
    if (turns !== undefined) {
      const count = turns === 'current' ? 1 : clampCount(turns.last);
      const first = Math.max(0, this._turnCount - count + 1);
      messages = count === 0 ? [] : messages.filter((message) => message.turn !== undefined && message.turn >= first && message.turn <= this._turnCount);
    }

    // Apply generic filter (application-specific, e.g., skip refusals)
    if (lens.messages?.filter) {
      const filterFn = lens.messages.filter;
      messages = messages.filter((msg, i, arr) => filterFn(msg, i, arr));
    }
    if (lens.messages?.last !== undefined) {
      messages = lens.messages.last === 0 ? [] : messages.slice(-lens.messages.last);
    }
    if (lens.messages?.maxChars !== undefined) {
      const max = lens.messages.maxChars;
      messages = messages.map((m) => ({
        ...m,
        content: m.content.length > max ? `${m.content.substring(0, max)}...` : m.content,
      }));
    }

    const allowedSlots = lens.slots;
    const allSlotValues: Record<string, unknown> = {};
    const slotSource = this.slots;
    const lensName = lens.name;
    const logger = this.logger;
    // A lens sees the same values a reader sees: staged changes of the open transaction first, then
    // committed state (read-your-writes parity between get() and through()).
    const effective = (name: string) => this._effective(name);

    if (allowedSlots === '*') {
      for (const name of slotSource.keys()) {
        allSlotValues[name] = effective(name);
      }
    } else if (Array.isArray(allowedSlots)) {
      for (const name of allowedSlots) {
        allSlotValues[name] = effective(name);
      }
    } else if (allowedSlots) {
      for (const [alias, slot] of Object.entries(allowedSlots)) {
        allSlotValues[alias] = effective(slot.name);
      }
    }

    const slotsProxy = new Proxy(allSlotValues, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (allowedSlots !== '*' && allowedSlots) {
          logger.warn(`[Mosaic] Lens "${lensName}" accessed undeclared slot "${prop}" — add it to the lens definition`);
        }
        return effective(prop);
      },
    });

    // Filter knowledge per lens config
    const knowledge = lens.knowledge ? this.getKnowledge(lens.knowledge) : [];

    const view: LensView<Slots> = {
      name: lens.name,
      messages,
      slots: slotsProxy as LensSlotValues<Slots>,
      knowledge,
      messageCount: messages.length,
      depth: this.depth(),
    };
    this._viewCache.set(lens, view);
    return view;
  }

  // ── Transactions ───────────────────────────────────────────────

  /** The currently active transaction, or `null` when no turn is open. */
  get transaction(): TurnTransaction | null {
    return this._activeTransaction;
  }

  /**
   * Open a transaction staging slot mutations for one turn. The returned handle
   * is trusted: writes through it bypass slot-ownership checks — use
   * `ctx.as(owner).set(...)` where enforcement is needed.
   * @throws If a transaction is already open.
   */
  beginTurn(): TurnTransaction {
    if (this._activeTransaction?.status === 'open') {
      throw new Error('[Mosaic] Cannot begin a new turn — a transaction is already open');
    }
    this._activeTransaction = new TurnTransaction(this);
    return this._activeTransaction;
  }

  _clearTransaction(): void {
    this._activeTransaction = null;
  }

  // ── Turn Tracking ───────────────────────────────────────────────

  /** Current zero-based chat turn; only `nextTurn()` advances it, and snapshot/restore preserves it. */
  get turnCount(): number {
    return this._turnCount;
  }

  /**
   * Advance at the application's next logical chat turn, not on pagination or every message.
   * Clear turn-scoped state: `turn-scoped` slot
   * values and all knowledge chunks. Invalidates cached lens views.
   * @returns The new turn count.
   * @throws If a transaction is open — advancing would mutate committed state
   *   behind the transaction's back. Commit or roll back first.
   */
  nextTurn(): number {
    if (this._activeTransaction?.status === 'open') {
      throw new Error('[Mosaic] Cannot advance turn while a transaction is open');
    }
    this._turnCount++;

    // Clear turn-scoped slots
    for (const [name, def] of this.slotDefs) {
      if (def.lifecycle === 'turn-scoped') {
        const state = this.slots.get(name);
        if (state) {
          state.value = undefined;
        }
      }
    }

    // Clear knowledge (turn-scoped by nature — new retrieval each turn)
    this._knowledge = [];
    this._invalidateViews();

    return this._turnCount;
  }

  // ── Scoped Access ───────────────────────────────────────────────

  /**
   * A scoped handle that writes under the given identity, so `owner`-restricted
   * slots can enforce who may write. Reads behave exactly as on this context.
   */
  as(identity: string): ScopedContextManager {
    return new ScopedContextManager(this, identity);
  }

  _setCallerIdentity(identity: string | null): void {
    this._callerIdentity = identity;
  }

  // ── Serialization ───────────────────────────────────────────────

  /**
   * Serialize the full context — messages (timestamps as ISO strings), slot
   * values (via each slot's `serialize` when defined), and the turn count.
   * Knowledge chunks are not included.
   * @throws If a transaction is open — a snapshot then would silently drop the
   *   staged changes. Commit or roll back first.
   */
  snapshot(): ContextSnapshot {
    if (this._activeTransaction?.status === 'open') {
      throw new Error('[Mosaic] Cannot snapshot while a transaction is open');
    }
    const serializedSlots: Record<string, unknown> = {};
    for (const [name, state] of this.slots) {
      if (state.value === undefined) continue;
      const def = this.slotDefs.get(name);
      serializedSlots[name] = def?.serialize ? def.serialize(state.value) : state.value;
    }

    return {
      messages: [...this.getMessages()].map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        ...(m.turn !== undefined ? { turn: m.turn } : {}),
        metadata: m.metadata,
        tags: m.tags,
      })),
      slots: serializedSlots,
      turnCount: this._turnCount,
    };
  }

  /**
   * Replace the whole context with a snapshot. Every snapshot slot must be defined and must
   * deserialize before anything is mutated; slots absent from the snapshot are reset, cached lens
   * views are dropped, and a restore during an open transaction is refused.
   */
  restore(snapshot: ContextSnapshot): void {
    if (this._activeTransaction?.status === 'open') {
      throw new Error('[Mosaic] Cannot restore while a transaction is open');
    }
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.messages) || !snapshot.slots || typeof snapshot.slots !== 'object' || !Number.isInteger(snapshot.turnCount)) {
      throw new Error('[Mosaic] Snapshot shape is invalid');
    }
    if (
      !Number.isSafeInteger(snapshot.turnCount) ||
      snapshot.turnCount < 0 ||
      snapshot.messages.some((message) => message.turn !== undefined && (!Number.isSafeInteger(message.turn) || message.turn < 0 || message.turn > snapshot.turnCount))
    ) {
      throw new Error('[Mosaic] Snapshot chat turn is invalid');
    }
    const restored = new Map<string, unknown>();
    for (const [name, rawValue] of Object.entries(snapshot.slots)) {
      const def = this.slotDefs.get(name);
      if (!def) throw new Error(`[Mosaic] Snapshot slot "${name}" is not defined`);
      restored.set(name, def.deserialize ? def.deserialize(rawValue) : rawValue);
    }

    this._messages = snapshot.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
      ...(m.turn !== undefined ? { turn: m.turn } : {}),
      metadata: m.metadata,
      tags: m.tags,
    }));

    for (const name of this.slots.keys()) {
      if (!restored.has(name)) this.slots.set(name, { value: undefined, lastSetAtTurn: snapshot.turnCount, writeCount: 0 });
    }
    for (const [name, value] of restored) {
      this.slots.set(name, { value: isolate(value), lastSetAtTurn: snapshot.turnCount, writeCount: 0 });
    }

    this._knowledge = [];
    this._turnCount = snapshot.turnCount;
    this._invalidateViews();
  }
}

/**
 * ScopedContextManager — tags writes with a caller identity for ownership enforcement.
 * Read methods delegate unchanged; `set`/`clear` run under the scoped identity and
 * throw when the identity is not an owner of the slot.
 */
export class ScopedContextManager {
  constructor(
    private readonly ctx: ContextManager,
    private readonly identity: string
  ) {}

  /** Read a slot — identical to `ContextManager.get()`. */
  get<T>(slot: SlotDef<T>): T | undefined {
    return this.ctx.get(slot);
  }

  /** Read committed state — identical to `ContextManager.peek()`. */
  peek<T>(slot: SlotDef<T>): T | undefined {
    return this.ctx.peek(slot);
  }

  /**
   * Write a slot under this handle's identity.
   * @throws If the identity is not in the slot's `owner` list.
   */
  set<T>(slot: SlotDef<T>, value: T): void {
    this.ctx._setCallerIdentity(this.identity);
    try {
      this.ctx.set(slot, value);
    } finally {
      this.ctx._setCallerIdentity(null);
    }
  }

  /** True when the slot holds a value — identical to `ContextManager.has()`. */
  has(slot: Pick<SlotDef, 'name'>): boolean {
    return this.ctx.has(slot);
  }

  /**
   * Clear a slot under this handle's identity.
   * @throws If the identity is not in the slot's `owner` list.
   */
  clear(slot: Pick<SlotDef, 'name'>): void {
    this.ctx._setCallerIdentity(this.identity);
    try {
      this.ctx.clear(slot);
    } finally {
      this.ctx._setCallerIdentity(null);
    }
  }
}

/**
 * TurnTransaction — buffers slot mutations and applies them atomically.
 * Reads see staged values (read-your-writes semantics).
 *
 * The handle is trusted: writes through `transaction.set()`/`clear()` do NOT
 * re-check slot ownership. Callers that need ownership enforcement write via
 * `ctx.as(owner).set(...)` — the scoped write is ownership-checked and then
 * forwarded into the open transaction.
 */
export class TurnTransaction {
  /** Internal: staged changes by slot name; read by the owning context for read-your-writes. */
  readonly staged: Map<string, StagedChange> = new Map();
  private _status: 'open' | 'committed' | 'rolled-back' = 'open';

  constructor(private readonly ctx: ContextManager) {}

  /** Lifecycle state of this transaction: `open`, `committed`, or `rolled-back`. */
  get status(): 'open' | 'committed' | 'rolled-back' {
    return this._status;
  }

  /**
   * Stage a slot write. The last operation on a slot wins; staging a value equal
   * to the committed value cancels any earlier staged change for that slot.
   * @throws If the transaction is no longer open.
   */
  set<T>(slot: SlotDef<T>, value: T): void {
    this.assertOpen();
    const previousValue = this.ctx.peek(slot);

    // The last operation wins. A value equal to committed state cancels any earlier staged change
    // for the slot (A -> B -> A ends with nothing to write) instead of leaving B staged.
    if (valuesEqual(previousValue, value)) {
      this.staged.delete(slot.name);
      this.ctx._invalidateViews();
      return;
    }

    this.staged.set(slot.name, {
      slotName: slot.name,
      action: 'set',
      value: isolate(value),
      previousValue,
    });
    this.ctx._invalidateViews();
  }

  /**
   * Stage a slot clear. Clearing a slot that holds no committed value cancels
   * any earlier staged change for that slot (ends unset).
   * @throws If the transaction is no longer open.
   */
  clear(slot: Pick<SlotDef, 'name'>): void {
    this.assertOpen();
    const previousValue = this.ctx.peek(slot);

    // The last operation wins here too: clearing a slot that was only set inside this transaction
    // drops the staged set (unset -> set -> clear ends unset); clearing a committed value stages a clear.
    if (previousValue === undefined) {
      this.staged.delete(slot.name);
      this.ctx._invalidateViews();
      return;
    }

    this.staged.set(slot.name, {
      slotName: slot.name,
      action: 'clear',
      previousValue,
    });
    this.ctx._invalidateViews();
  }

  /** Read a slot as this transaction sees it: staged change first, otherwise committed state. */
  get<T>(slot: SlotDef<T>): T | undefined {
    const change = this.staged.get(slot.name);
    if (change) {
      return change.action === 'clear' ? undefined : (change.value as T);
    }
    return this.ctx.peek(slot);
  }

  /** What `commit()` would apply right now: staged changes and current status. */
  summary(): TransactionSummary {
    return {
      changeCount: this.staged.size,
      changes: [...this.staged.values()],
      status: this._status,
    };
  }

  /**
   * Apply all staged changes atomically and close the transaction. The context's
   * active transaction is cleared; further use of this handle throws.
   * @throws If the transaction is no longer open.
   */
  commit(): void {
    this.assertOpen();

    // Apply staged changes via _commitDirect so we bypass the transaction
    // forwarding in ctx.set() (which would re-stage these changes infinitely
    // while the transaction is still 'open').
    for (const change of this.staged.values()) {
      const slot: SlotDef = { name: change.slotName };
      if (change.action === 'set') {
        this.ctx._commitDirect(slot, change.value);
      } else {
        this.ctx._clearDirect(slot);
      }
    }

    this._status = 'committed';
    this.ctx._clearTransaction();
  }

  /**
   * Discard all staged changes and close the transaction; committed state is left
   * untouched and lens views cached while changes were staged are invalidated.
   * @throws If the transaction is no longer open.
   */
  rollback(): void {
    this.assertOpen();
    this.staged.clear();
    this._status = 'rolled-back';
    this.ctx._clearTransaction();
    // Views built while the changes were staged must not survive the rollback.
    this.ctx._invalidateViews();
  }

  private assertOpen(): void {
    if (this._status !== 'open') {
      throw new Error(`[Mosaic] Transaction is ${this._status} — cannot modify`);
    }
  }
}

/**
 * Isolate a slot value: plain objects and arrays are deep-copied and deep-frozen so a reader that
 * mutates what it received cannot alter committed or staged state; other objects (Map, Date, class
 * instances) are stored as given because their serialization is owned by the slot definition.
 */
function isolate<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => isolate(entry))) as unknown as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) copy[key] = isolate(entry);
    return Object.freeze(copy) as T;
  }
  return value;
}

/** Normalize a count/limit argument: NaN and non-positive values clamp to 0, non-integers floor. */
function clampCount(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Shallow equality check for slot values — handles primitives, arrays, and simple objects */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
  }

  return false;
}
