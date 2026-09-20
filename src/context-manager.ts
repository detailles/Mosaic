/**
 * Mosaic — ContextManager
 *
 * Core class for managing LLM conversation context.
 * Holds messages + typed slots. Provides query methods, lenses,
 * transactions, and inspection for organized context management.
 *
 * Framework-agnostic — no application-specific imports.
 */

import type {
  ContextInspection,
  ContextSnapshot,
  CtxMessage,
  ILogger,
  KnowledgeChunk,
  LensDef,
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

export class ContextManager {
  private _messages: CtxMessage[] = [];
  private slots: Map<string, SlotState> = new Map();
  private slotDefs: Map<string, SlotDef> = new Map();
  private _knowledge: KnowledgeChunk[] = [];
  private _callerIdentity: string | null = null;
  private _turnCount = 0;
  private _activeTransaction: TurnTransaction | null = null;
  private _viewCache: Map<string, LensView> = new Map();
  private readonly logger: ILogger;

  private readonly maxMessages: number;

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

  addMessage(role: MessageRole, content: string, options?: { metadata?: Record<string, unknown>; tags?: Record<string, string> }): void {
    this._messages.push({
      role,
      content,
      timestamp: new Date(),
      metadata: options?.metadata,
      tags: options?.tags,
    });

    if (this.maxMessages > 0 && this._messages.length > this.maxMessages) {
      this._messages = this._messages.slice(-this.maxMessages);
    }
    this._viewCache.clear();
  }

  allMessages(): readonly CtxMessage[] {
    return this.getMessages();
  }

  get messageCount(): number {
    return this.getMessages().length;
  }

  // ── Message Queries ─────────────────────────────────────────────

  lastByRole(role: MessageRole): CtxMessage | undefined {
    const msgs = this.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === role) {
        return msgs[i];
      }
    }
    return undefined;
  }

  recent(count: number, options?: RecentOptions): CtxMessage[] {
    const msgs = this.getMessages();
    const slice = msgs.slice(-count);
    if (!options?.filter) return [...slice];
    return [...slice].filter(options.filter);
  }

  recentPairs(count: number): MessagePair[] {
    const msgs = this.getMessages();
    const pairs: MessagePair[] = [];

    for (let i = msgs.length - 1; i >= 1 && pairs.length < count; i--) {
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

  depth(): number {
    let count = 0;
    for (const msg of this.getMessages()) {
      if (msg.role === 'user') count++;
    }
    return count;
  }

  search(query: string, options?: { limit?: number; role?: MessageRole }): CtxMessage[] {
    const lowerQuery = query.toLowerCase();
    const results: CtxMessage[] = [];
    const msgs = this.getMessages();

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (options?.role && msg.role !== options.role) continue;
      if (msg.content.toLowerCase().includes(lowerQuery)) {
        results.push(msg);
        if (options?.limit && results.length >= options.limit) break;
      }
    }

    return results;
  }

  getByTag(tagName: string, tagValue: string): CtxMessage[] {
    return [...this.getMessages()].filter((msg) => msg.tags?.[tagName] === tagValue);
  }

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
    this._viewCache.clear();
  }

  /** Get all knowledge chunks, optionally filtered by source. Sorted by score descending.
   *  Filter order: sources → minScore → where → sort → top. */
  getKnowledge(options?: { sources?: string[]; top?: number; minScore?: number; where?: (chunk: KnowledgeChunk) => boolean }): KnowledgeChunk[] {
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
      items = items.slice(0, options.top);
    }

    return items;
  }

  /** Clear all knowledge chunks (called at start of each turn) */
  clearKnowledge(): void {
    this._knowledge = [];
    this._viewCache.clear();
  }

  /** Get the total number of knowledge chunks */
  get knowledgeCount(): number {
    return this._knowledge.length;
  }

  // ── Slot Operations ─────────────────────────────────────────────

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
    }

    return value;
  }

  peek<T>(slot: SlotDef<T>): T | undefined {
    const state = this.slots.get(slot.name);
    if (!state || state.value === undefined) return undefined;
    return state.value as T;
  }

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
      this._viewCache.clear();
      return;
    }

    state.value = isolated;
    state.lastSetAtTurn = this._turnCount;
    state.writeCount++;
    this._viewCache.clear();
  }

  /** Internal: the value a reader sees right now — staged change first, committed state otherwise. */
  _effective(name: string): unknown {
    if (this._activeTransaction?.status === 'open') {
      const staged = this._activeTransaction.staged.get(name);
      if (staged) return staged.action === 'clear' ? undefined : staged.value;
    }
    return this.slots.get(name)?.value;
  }

  /** Internal: lens views are cached per lens name; any staged or committed change invalidates them. */
  _invalidateViews(): void {
    this._viewCache.clear();
  }

  has(slot: Pick<SlotDef, 'name'>): boolean {
    const state = this.slots.get(slot.name);
    return state !== undefined && state.value !== undefined;
  }

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
      this._viewCache.clear();
    }
  }

  allSlots(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, state] of this.slots) {
      result[name] = state.value;
    }
    return result;
  }

  /**
   * Get slot values grouped by persistence type — for token budget integration.
   * Static slots should be reserved with high priority (not droppable).
   * Transient slots should be reserved with low priority (droppable).
   */
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
   * Messages and slots are filtered/constrained per the lens definition.
   * Accessing an undeclared slot logs a warning and returns the value (soft enforcement).
   */
  through(lens: LensDef): LensView {
    const cached = this._viewCache.get(lens.name);
    if (cached) return cached;

    let messages = [...this.getMessages()];

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
    } else if (allowedSlots) {
      for (const name of allowedSlots) {
        allSlotValues[name] = effective(name);
      }
    }

    const slotsProxy = new Proxy(allSlotValues, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (allowedSlots !== '*' && allowedSlots && !allowedSlots.includes(prop)) {
          logger.warn(`[Mosaic] Lens "${lensName}" accessed undeclared slot "${prop}" — add it to the lens definition`);
        }
        return effective(prop);
      },
    });

    // Filter knowledge per lens config
    const knowledge = lens.knowledge ? this.getKnowledge(lens.knowledge) : [];

    const view: LensView = {
      name: lens.name,
      messages,
      slots: slotsProxy,
      knowledge,
      messageCount: messages.length,
      depth: this.depth(),
    };
    this._viewCache.set(lens.name, view);
    return view;
  }

  // ── Transactions ───────────────────────────────────────────────

  get transaction(): TurnTransaction | null {
    return this._activeTransaction;
  }

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

  get turnCount(): number {
    return this._turnCount;
  }

  nextTurn(): number {
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
    this._viewCache.clear();

    return this._turnCount;
  }

  // ── Scoped Access ───────────────────────────────────────────────

  as(identity: string): ScopedContextManager {
    return new ScopedContextManager(this, identity);
  }

  _setCallerIdentity(identity: string | null): void {
    this._callerIdentity = identity;
  }

  // ── Serialization ───────────────────────────────────────────────

  snapshot(): ContextSnapshot {
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
    this._viewCache.clear();
  }
}

/**
 * ScopedContextManager — tags writes with a caller identity for ownership enforcement.
 */
export class ScopedContextManager {
  constructor(
    private readonly ctx: ContextManager,
    private readonly identity: string
  ) {}

  get<T>(slot: SlotDef<T>): T | undefined {
    return this.ctx.get(slot);
  }

  peek<T>(slot: SlotDef<T>): T | undefined {
    return this.ctx.peek(slot);
  }

  set<T>(slot: SlotDef<T>, value: T): void {
    this.ctx._setCallerIdentity(this.identity);
    try {
      this.ctx.set(slot, value);
    } finally {
      this.ctx._setCallerIdentity(null);
    }
  }

  has(slot: Pick<SlotDef, 'name'>): boolean {
    return this.ctx.has(slot);
  }

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
 */
export class TurnTransaction {
  /** Internal: staged changes by slot name; read by the owning context for read-your-writes. */
  readonly staged: Map<string, StagedChange> = new Map();
  private _status: 'open' | 'committed' | 'rolled-back' = 'open';

  constructor(private readonly ctx: ContextManager) {}

  get status(): 'open' | 'committed' | 'rolled-back' {
    return this._status;
  }

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

  clear(slot: Pick<SlotDef, 'name'>): void {
    this.assertOpen();
    const previousValue = this.ctx.peek(slot);

    // The last operation wins here too: clearing a slot that was only set inside this transaction
    // drops the staged set (unset -> set -> clear ends unset); clearing a committed value stages a clear.
    if (previousValue === undefined || previousValue === null) {
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

  get<T>(slot: SlotDef<T>): T | undefined {
    const change = this.staged.get(slot.name);
    if (change) {
      return change.action === 'clear' ? undefined : (change.value as T);
    }
    return this.ctx.peek(slot);
  }

  summary(): TransactionSummary {
    return {
      changeCount: this.staged.size,
      changes: [...this.staged.values()],
      status: this._status,
    };
  }

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
