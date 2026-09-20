/**
 * Mosaic — Core library tests.
 * No application-specific imports — tests the framework-agnostic library.
 */
import { describe, expect, it } from 'bun:test';

import { ContextManager, defineLens, estimateTokens, TokenBudget } from '../src/index.js';

describe('ContextManager', () => {
  // ── Message Queries ─────────────────────────────────────────────

  describe('lastByRole', () => {
    it('returns the last message with the given role', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'first');
      ctx.addMessage('assistant', 'response 1');
      ctx.addMessage('user', 'second');
      ctx.addMessage('assistant', 'response 2');

      expect(ctx.lastByRole('assistant')?.content).toBe('response 2');
      expect(ctx.lastByRole('user')?.content).toBe('second');
    });

    it('returns undefined when no messages of that role exist', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'hello');

      expect(ctx.lastByRole('assistant')).toBeUndefined();
    });
  });

  describe('recent', () => {
    it('returns the N most recent messages', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'a');
      ctx.addMessage('assistant', 'b');
      ctx.addMessage('user', 'c');
      ctx.addMessage('assistant', 'd');

      const last2 = ctx.recent(2);
      expect(last2).toHaveLength(2);
      expect(last2[0].content).toBe('c');
      expect(last2[1].content).toBe('d');
    });

    it('applies filter when provided', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'a');
      ctx.addMessage('assistant', 'REFUSAL: I cannot help');
      ctx.addMessage('user', 'b');
      ctx.addMessage('assistant', 'Sure, here is the answer');

      const filtered = ctx.recent(4, {
        filter: (msg) => !msg.content.startsWith('REFUSAL'),
      });
      expect(filtered).toHaveLength(3);
    });
  });

  describe('recentPairs', () => {
    it('returns user/assistant exchange pairs', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'q1');
      ctx.addMessage('assistant', 'a1');
      ctx.addMessage('user', 'q2');
      ctx.addMessage('assistant', 'a2');

      const pairs = ctx.recentPairs(2);
      expect(pairs).toHaveLength(2);
      expect(pairs[0].user.content).toBe('q1');
      expect(pairs[1].assistant.content).toBe('a2');
    });

    it('skips orphaned messages without pairs', () => {
      const ctx = new ContextManager();
      ctx.addMessage('system', 'you are helpful');
      ctx.addMessage('user', 'q1');
      ctx.addMessage('assistant', 'a1');
      ctx.addMessage('user', 'q2');

      expect(ctx.recentPairs(5)).toHaveLength(1);
    });
  });

  describe('depth', () => {
    it('counts only user messages', () => {
      const ctx = new ContextManager();
      ctx.addMessage('system', 'init');
      ctx.addMessage('user', 'q1');
      ctx.addMessage('assistant', 'a1');
      ctx.addMessage('user', 'q2');

      expect(ctx.depth()).toBe(2);
    });
  });

  describe('search', () => {
    it('finds messages containing the query (case-insensitive)', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'I have an MODEL-A');
      ctx.addMessage('assistant', 'The MODEL-A is a controller');

      const results = ctx.search('model-a');
      expect(results).toHaveLength(2);
    });

    it('filters by role', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'error E-07');
      ctx.addMessage('assistant', 'Error E-07 means overcurrent');

      expect(ctx.search('e-07', { role: 'user' })).toHaveLength(1);
    });

    it('respects limit', () => {
      const ctx = new ContextManager();
      ctx.addMessage('user', 'test one');
      ctx.addMessage('user', 'test two');
      ctx.addMessage('user', 'test three');

      expect(ctx.search('test', { limit: 2 })).toHaveLength(2);
    });
  });

  describe('tags', () => {
    it('stores and retrieves message tags', () => {
      const ctx = new ContextManager();
      ctx.addMessage('assistant', 'What product?', { tags: { responseType: 'clarification' } });

      expect(ctx.lastAssistantHasTag('responseType', 'clarification')).toBe(true);
      expect(ctx.lastAssistantHasTag('responseType', 'answer')).toBe(false);
    });
  });

  describe('maxMessages', () => {
    it('trims old messages when limit exceeded', () => {
      const ctx = new ContextManager({ maxMessages: 3 });
      ctx.addMessage('user', 'a');
      ctx.addMessage('assistant', 'b');
      ctx.addMessage('user', 'c');
      ctx.addMessage('assistant', 'd');

      expect(ctx.messageCount).toBe(3);
      expect(ctx.allMessages()[0].content).toBe('b');
    });
  });

  // ── Slots ───────────────────────────────────────────────────────

  describe('slots', () => {
    it('defines a slot and returns undefined until set', () => {
      const ctx = new ContextManager();
      const product = ctx.defineSlot<string | null>('product');
      expect(ctx.get(product)).toBeUndefined();
    });

    it('sets and reads a slot value', () => {
      const ctx = new ContextManager();
      const product = ctx.defineSlot<string | null>('product');
      ctx.set(product, 'MODEL-A');
      expect(ctx.get(product)).toBe('MODEL-A');
    });

    it('clears a slot back to undefined', () => {
      const ctx = new ContextManager();
      const product = ctx.defineSlot<string | null>('product');
      ctx.set(product, 'MODEL-A');
      ctx.clear(product);
      expect(ctx.get(product)).toBeUndefined();
    });
  });

  // ── Serialization ───────────────────────────────────────────────

  describe('snapshot / restore', () => {
    it('round-trips messages and slots', () => {
      const ctx = new ContextManager();
      const product = ctx.defineSlot<string | null>('product');
      ctx.addMessage('user', 'What is MODEL-A?');
      ctx.set(product, 'MODEL-A');
      ctx.nextTurn();

      const snap = ctx.snapshot();
      const ctx2 = new ContextManager();
      ctx2.defineSlot<string | null>('product');
      ctx2.restore(snap);

      expect(ctx2.messageCount).toBe(1);
      expect(ctx2.get(product)).toBe('MODEL-A');
      expect(ctx2.turnCount).toBe(1);
    });

    it('uses custom serializer/deserializer for Map slots', () => {
      const ctx = new ContextManager();
      const entities = ctx.defineSlot<Map<string, number>>('entities', {
        serialize: (m) => Array.from(m.entries()),
        deserialize: (raw) => new Map(raw as Array<[string, number]>),
      });

      ctx.set(entities, new Map([['product:model-a', 3]]));
      const snap = ctx.snapshot();

      expect(Array.isArray(snap.slots.entities)).toBe(true);

      const ctx2 = new ContextManager();
      ctx2.defineSlot<Map<string, number>>('entities', {
        serialize: (m) => Array.from(m.entries()),
        deserialize: (raw) => new Map(raw as Array<[string, number]>),
      });
      ctx2.restore(snap);

      const restored = ctx2.get(entities);
      expect(restored).toBeInstanceOf(Map);
      expect(restored?.get('product:model-a')).toBe(3);
    });
  });
});

// ── Slot Lifecycle ────────────────────────────────────────────────

describe('Slot Lifecycle', () => {
  describe('consume-once', () => {
    it('clears value after first get()', () => {
      const ctx = new ContextManager();
      const signal = ctx.defineSlot<string | undefined>('signal', { lifecycle: 'consume-once' });

      ctx.set(signal, 'fire');
      expect(ctx.get(signal)).toBe('fire');
      expect(ctx.get(signal)).toBeUndefined();
    });

    it('peek() does not consume the value', () => {
      const ctx = new ContextManager();
      const signal = ctx.defineSlot<string | undefined>('signal', { lifecycle: 'consume-once' });

      ctx.set(signal, 'fire');
      expect(ctx.peek(signal)).toBe('fire');
      expect(ctx.peek(signal)).toBe('fire');
      expect(ctx.get(signal)).toBe('fire');
      expect(ctx.get(signal)).toBeUndefined();
    });
  });

  describe('turn-scoped', () => {
    it('clears value on nextTurn()', () => {
      const ctx = new ContextManager();
      const turnData = ctx.defineSlot<string | undefined>('turnData', { lifecycle: 'turn-scoped' });

      ctx.set(turnData, 'turn-1-data');
      expect(ctx.get(turnData)).toBe('turn-1-data');

      ctx.nextTurn();
      expect(ctx.get(turnData)).toBeUndefined();
    });

    it('does not clear persistent slots on nextTurn()', () => {
      const ctx = new ContextManager();
      const persistent = ctx.defineSlot<string>('persistent');
      const scoped = ctx.defineSlot<string | undefined>('scoped', { lifecycle: 'turn-scoped' });

      ctx.set(persistent, 'survives');
      ctx.set(scoped, 'dies');

      ctx.nextTurn();
      expect(ctx.get(persistent)).toBe('survives');
      expect(ctx.get(scoped)).toBeUndefined();
    });
  });
});

// ── Slot Ownership ────────────────────────────────────────────────

describe('Slot Ownership', () => {
  it('allows owner to write via scoped handle', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product', { owner: 'resolver' });

    ctx.as('resolver').set(product, 'MODEL-A');
    expect(ctx.get(product)).toBe('MODEL-A');
  });

  it('rejects non-owner writes via scoped handle', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product', { owner: 'resolver' });

    expect(() => ctx.as('orchestrator').set(product, 'MODEL-A')).toThrow('owned by [resolver]');
  });

  it('allows multiple owners', () => {
    const ctx = new ContextManager();
    const topic = ctx.defineSlot<string>('topic', { owner: ['resolver', 'orchestrator'] });

    ctx.as('resolver').set(topic, 'troubleshooting');
    ctx.as('orchestrator').set(topic, 'specifications');
    expect(() => ctx.as('agent').set(topic, 'hacking')).toThrow('owned by [resolver, orchestrator]');
  });

  it('allows unscoped writes (backward compat)', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product', { owner: 'resolver' });

    ctx.set(product, 'MODEL-A');
    expect(ctx.get(product)).toBe('MODEL-A');
  });
});

// ── Context Inspection ────────────────────────────────────────────

describe('Context Inspection', () => {
  it('returns structured context state', () => {
    const ctx = new ContextManager();
    ctx.defineSlot<string | null>('product', { owner: 'resolver' });
    ctx.defineSlot<string | undefined>('signal', { lifecycle: 'consume-once' });

    ctx.addMessage('user', 'Hello');
    ctx.addMessage('assistant', 'Hi');
    ctx.set({ name: 'product' }, 'MODEL-A');
    ctx.set({ name: 'signal' }, 'fire');
    ctx.nextTurn();

    const info = ctx.inspect();
    expect(info.messageCount).toBe(2);
    expect(info.depth).toBe(1);
    expect(info.turnCount).toBe(1);
    expect(info.slotCount).toBe(2);
    expect(info.slots.product.owner).toBe('resolver');
    expect(info.slots.signal.lifecycle).toBe('consume-once');
  });
});

// ── Lenses ────────────────────────────────────────────────────────

describe('Lenses', () => {
  it('limits messages by count', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'a');
    ctx.addMessage('assistant', 'b');
    ctx.addMessage('user', 'c');
    ctx.addMessage('assistant', 'd');

    const view = ctx.through(defineLens('test', { messages: { last: 2 } }));
    expect(view.messageCount).toBe(2);
    expect(view.messages[0].content).toBe('c');
  });

  it('truncates message content by maxChars', () => {
    const ctx = new ContextManager();
    ctx.addMessage('assistant', 'A'.repeat(300));

    const view = ctx.through(defineLens('test', { messages: { last: 1, maxChars: 20 } }));
    expect(view.messages[0].content.length).toBeLessThanOrEqual(23);
    expect(view.messages[0].content).toContain('...');
  });

  it('applies generic filter', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'a');
    ctx.addMessage('assistant', 'REFUSAL: cannot help');
    ctx.addMessage('user', 'b');
    ctx.addMessage('assistant', 'Sure, here you go');

    const view = ctx.through(
      defineLens('test', {
        messages: { last: 4, filter: (msg) => !msg.content.startsWith('REFUSAL') },
      })
    );

    expect(view.messageCount).toBe(3);
    expect(view.messages.every((m) => !m.content.startsWith('REFUSAL'))).toBe(true);
  });

  it('provides declared slots', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');
    ctx.set(product, 'MODEL-A');

    const view = ctx.through(defineLens('test', { slots: ['product'] }));
    expect(view.slots.product).toBe('MODEL-A');
  });

  it('soft-warns on undeclared slot access via logger', () => {
    const warnings: string[] = [];
    const ctx = new ContextManager({ logger: { warn: (msg) => warnings.push(msg) } });
    ctx.defineSlot<string>('secret');
    ctx.set({ name: 'secret' }, 'value');

    const view = ctx.through(defineLens('test', { slots: ['other'] }));
    const val = view.slots.secret;

    expect(val).toBe('value');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('undeclared slot "secret"');
  });

  it('silent when no logger provided (default no-op)', () => {
    const ctx = new ContextManager(); // no logger
    ctx.defineSlot<string>('secret');
    ctx.set({ name: 'secret' }, 'value');

    // Should not throw — no-op logger handles it
    const view = ctx.through(defineLens('test', { slots: ['other'] }));
    expect(view.slots.secret).toBe('value');
  });

  it('returns zero messages with last: 0', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'hello');

    const view = ctx.through(defineLens('test', { messages: { last: 0 }, slots: '*' }));
    expect(view.messageCount).toBe(0);
  });

  it('depth reflects full context', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'a');
    ctx.addMessage('assistant', 'b');
    ctx.addMessage('user', 'c');

    const view = ctx.through(defineLens('test', { messages: { last: 1 } }));
    expect(view.messageCount).toBe(1);
    expect(view.depth).toBe(2);
  });
});

// ── Transactions ──────────────────────────────────────────────────

describe('TurnTransaction', () => {
  it('stages slot writes without applying them', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');

    const turn = ctx.beginTurn();
    turn.set(product, 'MODEL-A');

    expect(turn.get(product)).toBe('MODEL-A');
    // ctx.get() sees staged writes during active transaction (read-your-writes)
    expect(ctx.get(product)).toBe('MODEL-A');
    // peek() bypasses transaction — committed state still unchanged
    expect(ctx.peek(product)).toBeUndefined();
  });

  it('commit applies all staged changes', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');
    const topic = ctx.defineSlot<string>('topic');

    const turn = ctx.beginTurn();
    turn.set(product, 'MODEL-A');
    turn.set(topic, 'troubleshooting');
    turn.commit();

    expect(ctx.get(product)).toBe('MODEL-A');
    expect(ctx.get(topic)).toBe('troubleshooting');
  });

  it('rollback discards all staged changes', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');
    ctx.set(product, 'MODEL-A');

    const turn = ctx.beginTurn();
    turn.set(product, 'MODEL-B');
    turn.rollback();

    expect(ctx.get(product)).toBe('MODEL-A');
  });

  it('provides summary of staged changes', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');

    const turn = ctx.beginTurn();
    turn.set(product, 'MODEL-A');

    const summary = turn.summary();
    expect(summary.changeCount).toBe(1);
    expect(summary.changes[0].action).toBe('set');
    expect(summary.changes[0].value).toBe('MODEL-A');
  });

  it('skips unchanged values in summary', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');
    const topic = ctx.defineSlot<string>('topic');
    ctx.set(product, 'MX-500');
    ctx.set(topic, 'troubleshooting');

    const turn = ctx.beginTurn();
    turn.set(product, 'MX-500'); // same value — should be skipped
    turn.set(topic, 'specifications'); // different — should be staged

    const summary = turn.summary();
    expect(summary.changeCount).toBe(1);
    expect(summary.changes[0].slotName).toBe('topic');
  });

  it('skips clear on already-empty slots', () => {
    const ctx = new ContextManager();
    const pending = ctx.defineSlot<string | undefined>('pending');

    const turn = ctx.beginTurn();
    turn.clear(pending); // already undefined — should be skipped

    expect(turn.summary().changeCount).toBe(0);
  });

  it('detects changes in arrays', () => {
    const ctx = new ContextManager();
    const terms = ctx.defineSlot<string[]>('terms');
    ctx.set(terms, ['motor', 'fault']);

    const turn = ctx.beginTurn();
    turn.set(terms, ['motor', 'fault']); // same — skipped
    expect(turn.summary().changeCount).toBe(0);

    turn.set(terms, ['motor', 'contactor']); // different — staged
    expect(turn.summary().changeCount).toBe(1);
  });

  it('throws on writes after commit', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');

    const turn = ctx.beginTurn();
    turn.commit();
    expect(() => turn.set(product, 'MODEL-A')).toThrow('committed');
  });

  it('throws on writes after rollback', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');

    const turn = ctx.beginTurn();
    turn.rollback();
    expect(() => turn.set(product, 'MODEL-A')).toThrow('rolled-back');
  });

  it('prevents double-open', () => {
    const ctx = new ContextManager();
    ctx.beginTurn();
    expect(() => ctx.beginTurn()).toThrow('already open');
  });

  it('clears active transaction on commit/rollback', () => {
    const ctx = new ContextManager();
    const turn = ctx.beginTurn();
    expect(ctx.transaction).toBe(turn);
    turn.commit();
    expect(ctx.transaction).toBeNull();
  });

  it('nextTurn() refuses while a transaction is open; works again after commit or rollback', () => {
    // Pins O2: advancing mid-transaction would mutate committed state behind
    // the transaction's back — it must fail loudly and leave nothing wedged.
    const ctx = new ContextManager();
    const turn = ctx.beginTurn();
    expect(() => ctx.nextTurn()).toThrow('Cannot advance turn while a transaction is open');
    expect(ctx.turnCount).toBe(0); // counter untouched by the refused call
    turn.commit();
    expect(ctx.nextTurn()).toBe(1);

    const ctx2 = new ContextManager();
    const turn2 = ctx2.beginTurn();
    expect(() => ctx2.nextTurn()).toThrow('Cannot advance turn while a transaction is open');
    turn2.rollback();
    expect(ctx2.nextTurn()).toBe(1);
  });

  it('snapshot() refuses while a transaction is open; works after commit or rollback', () => {
    // Pins O8: a mid-transaction snapshot would silently drop staged changes.
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    ctx.set(product, 'committed');

    const turn = ctx.beginTurn();
    turn.set(product, 'staged');
    expect(() => ctx.snapshot()).toThrow('Cannot snapshot while a transaction is open');
    turn.rollback();
    expect(ctx.snapshot().slots.product).toBe('committed');

    const turn2 = ctx.beginTurn();
    turn2.set(product, 'new-value');
    expect(() => ctx.snapshot()).toThrow('Cannot snapshot while a transaction is open');
    turn2.commit();
    expect(ctx.snapshot().slots.product).toBe('new-value');
  });

  // ── ctx.set during an open transaction ─────────────────────────────
  //
  // These tests pin the behavior of ctx.set() when a transaction is open.
  // Historically ctx.set() wrote directly to committed state and bypassed
  // the transaction entirely, which meant rollback could not undo it. That
  // was a footgun. After the silent-forward fix, ctx.set() during an open
  // transaction stages through transaction.set() so rollback works.

  it('ctx.set followed by ctx.get during open transaction returns the new value (read-your-writes)', () => {
    const ctx = new ContextManager();
    const detectedLanguage = ctx.defineSlot<string | undefined>('detectedLanguage');
    // Seed prior-turn value the way loadStateIntoSlots does
    ctx.set(detectedLanguage, 'Turkish');

    ctx.beginTurn();
    ctx.set(detectedLanguage, 'English');

    // This is the scenario that LP02 made me suspect was broken.
    // It is not broken — set + get within a turn returns the new value.
    expect(ctx.get(detectedLanguage)).toBe('English');
  });

  it('ctx.set during open transaction is rolled back by transaction.rollback', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');
    ctx.set(product, 'MODEL-A');

    const turn = ctx.beginTurn();
    // Before the silent-forward fix: this wrote directly to committed state
    // and rollback could not undo it. After the fix: the write stages
    // through transaction.set() and is discarded on rollback.
    ctx.set(product, 'ModelC');
    expect(ctx.get(product)).toBe('ModelC'); // staged, visible in turn
    turn.rollback();

    expect(ctx.peek(product)).toBe('MODEL-A'); // committed state preserved
  });

  it('ctx.set after transaction.set on the same slot overwrites the staged value', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string | null>('product');

    const turn = ctx.beginTurn();
    turn.set(product, 'staged-first');
    // After the silent-forward fix, this ctx.set should also stage into
    // the transaction — so it overwrites 'staged-first' in the staged
    // map. Before the fix, ctx.set wrote 'via-ctx-second' directly to
    // committed state and commit() then overwrote it with the stale
    // 'staged-first' on commit (staged-first wins), which is backwards.
    ctx.set(product, 'via-ctx-second');

    expect(turn.get(product)).toBe('via-ctx-second');
    turn.commit();

    expect(ctx.peek(product)).toBe('via-ctx-second');
  });
});

// ── Token Budget ──────────────────────────────────────────────────

describe('TokenBudget', () => {
  it('returns all sections when within budget', () => {
    const budget = new TokenBudget({ limit: 1000, countTokens: estimateTokens });
    budget.reserve('system', 'You are a helpful assistant.', { priority: 'fixed' });
    budget.reserve('history', 'User: hello', { priority: 'high' });

    const result = budget.compile();
    expect(result.dropped).toHaveLength(0);
    expect(result.sections.system).toBeDefined();
    expect(result.sections.history).toBeDefined();
  });

  it('drops low-priority droppable sections first', () => {
    const budget = new TokenBudget({ limit: 15, countTokens: estimateTokens });
    budget.reserve('system', 'A'.repeat(40), { priority: 'fixed' });
    budget.reserve('state', 'B'.repeat(40), { priority: 'low', droppable: true });

    const result = budget.compile();
    expect(result.dropped).toContain('state');
    expect(result.sections.system).toBeDefined();
  });

  it('shrinks with tail strategy', () => {
    const budget = new TokenBudget({ limit: 15, countTokens: estimateTokens });
    budget.reserveItems('history', [{ content: 'A'.repeat(40) }, { content: 'B'.repeat(40) }, { content: 'C'.repeat(40) }], { priority: 'high', strategy: 'tail' });

    const result = budget.compile();
    expect(result.shrunk).toContain('history');
    expect(result.sections.history[result.sections.history.length - 1]).toBe('C'.repeat(40));
  });

  it('shrinks with rank strategy', () => {
    const budget = new TokenBudget({ limit: 8, countTokens: estimateTokens });
    budget.reserveItems(
      'chunks',
      [
        { content: 'low relevance', score: 0.3 },
        { content: 'high relevance', score: 0.95 },
        { content: 'medium relevance', score: 0.6 },
      ],
      { priority: 'medium', strategy: 'rank' }
    );

    const result = budget.compile();
    expect(result.sections.chunks[0]).toBe('high relevance');
  });

  it('reports utilization', () => {
    const budget = new TokenBudget({ limit: 100, countTokens: estimateTokens });
    budget.reserve('content', 'A'.repeat(200), { priority: 'high' });

    const result = budget.compile();
    expect(result.usage.utilization).toBe(0.5);
    expect(result.usage.limit).toBe(100);
  });

  it('shrinkRank is stable on score ties (insertion order wins)', () => {
    // estimateTokens = ceil(len/4). Each item is 20 chars = 5 tokens.
    // Budget of 10 tokens fits exactly 2 items; 3 items = 15 tokens overflows.
    const budget = new TokenBudget({ limit: 10, countTokens: estimateTokens });
    budget.reserveItems(
      'chunks',
      [
        { content: 'AAAAAAAAAAAAAAAAAAAA', score: 0.8 }, // inserted first
        { content: 'BBBBBBBBBBBBBBBBBBBB', score: 0.8 }, // inserted second
        { content: 'CCCCCCCCCCCCCCCCCCCC', score: 0.8 }, // inserted third
      ],
      { priority: 'medium', strategy: 'rank' }
    );

    const result = budget.compile();
    // Stable sort: first two inserted items survive, third is dropped on tie
    expect(result.sections.chunks).toHaveLength(2);
    expect(result.sections.chunks[0]).toBe('AAAAAAAAAAAAAAAAAAAA');
    expect(result.sections.chunks[1]).toBe('BBBBBBBBBBBBBBBBBBBB');
    expect(result.sections.chunks).not.toContain('CCCCCCCCCCCCCCCCCCCC');
  });
});

// ── Knowledge ─────────────────────────────────────────────────────

describe('Knowledge', () => {
  it('adds and retrieves chunks sorted by score', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'low', score: 0.3 },
      { content: 'high', score: 0.95 },
      { content: 'medium', score: 0.6 },
    ]);

    const chunks = ctx.getKnowledge();
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('high');
    expect(chunks[0].source).toBe('rag');
  });

  it('filters by source', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'from rag', score: 0.8 }]);
    ctx.addKnowledge('web', [{ content: 'from web', score: 0.7 }]);

    const ragOnly = ctx.getKnowledge({ sources: ['rag'] });
    expect(ragOnly).toHaveLength(1);
    expect(ragOnly[0].content).toBe('from rag');
  });

  it('filters by minScore', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'low', score: 0.2 },
      { content: 'high', score: 0.9 },
    ]);

    expect(ctx.getKnowledge({ minScore: 0.5 })).toHaveLength(1);
  });

  it('limits by top', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'a', score: 0.9 },
      { content: 'b', score: 0.8 },
      { content: 'c', score: 0.7 },
    ]);

    expect(ctx.getKnowledge({ top: 2 })).toHaveLength(2);
  });

  it('clears on nextTurn', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'chunk', score: 0.9 }]);
    expect(ctx.knowledgeCount).toBe(1);

    ctx.nextTurn();
    expect(ctx.knowledgeCount).toBe(0);
  });

  it('preserves meta', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'text', score: 0.8, meta: { docId: 'abc', title: 'My Doc' } }]);

    const chunks = ctx.getKnowledge();
    expect(chunks[0].meta?.docId).toBe('abc');
    expect(chunks[0].meta?.title).toBe('My Doc');
  });

  it('appears in inspect()', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'a', score: 0.9 }]);
    ctx.addKnowledge('web', [{ content: 'b', score: 0.8 }]);

    const info = ctx.inspect();
    expect(info.knowledgeCount).toBe(2);
    expect(info.knowledgeSources).toEqual(expect.arrayContaining(['rag', 'web']));
  });

  it('flows through lenses', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'low', score: 0.2 },
      { content: 'high', score: 0.95 },
      { content: 'medium', score: 0.6 },
    ]);
    ctx.addKnowledge('web', [{ content: 'web result', score: 0.7 }]);

    // Lens with knowledge config
    const lens = defineLens('synthesis', {
      knowledge: { sources: ['rag'], top: 2, minScore: 0.3 },
    });

    const view = ctx.through(lens);
    expect(view.knowledge).toHaveLength(2);
    expect(view.knowledge[0].content).toBe('high');
    expect(view.knowledge[1].content).toBe('medium');
  });

  it('lens without knowledge config returns empty array', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'chunk', score: 0.9 }]);

    const lens = defineLens('router', { messages: { last: 1 } });
    const view = ctx.through(lens);
    expect(view.knowledge).toHaveLength(0);
  });

  it('respects where predicate', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'alpha', score: 0.9, meta: { kind: 'x' } },
      { content: 'beta', score: 0.8, meta: { kind: 'y' } },
      { content: 'gamma', score: 0.7, meta: { kind: 'x' } },
    ]);

    const result = ctx.getKnowledge({ where: (c) => c.meta?.kind === 'x' });
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('alpha');
    expect(result[1].content).toBe('gamma');
  });

  it('where composes with sources, minScore, and top', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'rag-x-high', score: 0.95, meta: { kind: 'x' } },
      { content: 'rag-x-low', score: 0.2, meta: { kind: 'x' } },
      { content: 'rag-y-high', score: 0.9, meta: { kind: 'y' } },
    ]);
    ctx.addKnowledge('web', [{ content: 'web-x', score: 0.99, meta: { kind: 'x' } }]);

    const result = ctx.getKnowledge({
      sources: ['rag'],
      minScore: 0.3,
      where: (c) => c.meta?.kind === 'x',
      top: 5,
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('rag-x-high');
  });

  it('where is never given chunks excluded by source filter', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [{ content: 'rag-chunk', score: 0.9 }]);
    ctx.addKnowledge('web', [{ content: 'web-chunk', score: 0.9 }]);

    const seen: string[] = [];
    ctx.getKnowledge({
      sources: ['rag'],
      where: (c) => {
        seen.push(c.content);
        return true;
      },
    });
    expect(seen).toEqual(['rag-chunk']);
  });

  it('lens propagates where via through()', () => {
    const ctx = new ContextManager();
    ctx.addKnowledge('rag', [
      { content: 'keep', score: 0.9, meta: { kind: 'x' } },
      { content: 'drop', score: 0.95, meta: { kind: 'y' } },
    ]);

    const lens = defineLens('test', {
      knowledge: { where: (c) => c.meta?.kind === 'x' },
    });

    const view = ctx.through(lens);
    expect(view.knowledge).toHaveLength(1);
    expect(view.knowledge[0].content).toBe('keep');
  });
});

// ── Query helper clamps ───────────────────────────────────────────
//
// Pins O7: count/limit arguments are normalized defensively instead of leaking
// slice() footguns (recent(0) used to return the FULL history via slice(-0)).

describe('Query helper clamps', () => {
  it('recent(0), recent(negative), recent(NaN) return [] and non-integers floor', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'a');
    ctx.addMessage('assistant', 'b');
    ctx.addMessage('user', 'c');

    expect(ctx.recent(0)).toEqual([]); // was: full history via slice(-0)
    expect(ctx.recent(-1)).toEqual([]);
    expect(ctx.recent(NaN)).toEqual([]);
    expect(ctx.recent(2.7).map((m) => m.content)).toEqual(['b', 'c']);
  });

  it('recentPairs normalizes count the same way', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'q1');
    ctx.addMessage('assistant', 'a1');
    ctx.addMessage('user', 'q2');
    ctx.addMessage('assistant', 'a2');

    expect(ctx.recentPairs(0)).toEqual([]);
    expect(ctx.recentPairs(-1)).toEqual([]);
    expect(ctx.recentPairs(1.9)).toHaveLength(1);
  });

  it('search: limit 0 or negative returns [], undefined stays unbounded', () => {
    const ctx = new ContextManager();
    ctx.addMessage('user', 'test one');
    ctx.addMessage('user', 'test two');
    ctx.addMessage('user', 'test three');

    expect(ctx.search('test', { limit: 0 })).toEqual([]); // was: falsy → unbounded
    expect(ctx.search('test', { limit: -2 })).toEqual([]);
    expect(ctx.search('test')).toHaveLength(3);
    expect(ctx.search('test', {})).toHaveLength(3);
    expect(ctx.search('test', { limit: 2 })).toHaveLength(2);
  });
});

// ── Typed-state integration invariants ─────────────────────────────
//
// Each test names the regression it pins. These are the transaction/cache/ownership/restore
// paths a typed-state integration relies on.

describe('Transaction and view invariants for typed-state integrations', () => {
  it('A -> B -> A inside one transaction ends with nothing staged and A committed (last operation wins)', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    ctx.set(product, 'A');
    const turn = ctx.beginTurn();
    turn.set(product, 'B');
    turn.set(product, 'A');
    expect(turn.summary().changeCount).toBe(0);
    expect(ctx.get(product)).toBe('A');
    turn.commit();
    expect(ctx.peek(product)).toBe('A');
  });

  it('unset -> set -> clear inside one transaction ends unset (a staged set is dropped by clear)', () => {
    const ctx = new ContextManager();
    const pending = ctx.defineSlot<string>('pending');
    const turn = ctx.beginTurn();
    turn.set(pending, 'model');
    turn.clear(pending);
    expect(turn.summary().changeCount).toBe(0);
    expect(ctx.get(pending)).toBeUndefined();
    turn.commit();
    expect(ctx.peek(pending)).toBeUndefined();
  });

  it('a lens sees staged values the same way get() does (staged-read parity), and the cache follows staging', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    ctx.set(product, 'MODEL-A');
    const lens = { name: 'render', slots: ['product'] as string[] };
    expect(ctx.through(lens).slots.product).toBe('MODEL-A');
    const turn = ctx.beginTurn();
    turn.set(product, 'ModelC');
    expect(ctx.get(product)).toBe('ModelC');
    expect(ctx.through(lens).slots.product).toBe('ModelC');
    turn.rollback();
    expect(ctx.through(lens).slots.product).toBe('MODEL-A');
  });

  it('restore after a cached lens view drops the cache and resets slots absent from the snapshot', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    const topic = ctx.defineSlot<string>('topic');
    ctx.set(product, 'MODEL-A');
    ctx.set(topic, 'wiring');
    const lens = { name: 'render', slots: '*' as const };
    expect(ctx.through(lens).slots.product).toBe('MODEL-A');
    const snap = ctx.snapshot();
    ctx.set(product, 'MODEL-B');
    ctx.clear(topic);
    ctx.set(product, 'MODEL-B');
    const other = new ContextManager();
    other.defineSlot<string>('product');
    other.defineSlot<string>('topic');
    other.set(other.defineSlot<string>('product'), 'STALE');
    other.through(lens);
    other.restore({ ...snap, slots: { product: 'MODEL-A' } });
    expect(other.through(lens).slots.product).toBe('MODEL-A');
    expect(other.peek(topic)).toBeUndefined();
    expect(other.has(topic)).toBe(false);
  });

  it('restore validates before mutating: an undefined slot in the snapshot is refused and nothing changes', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    ctx.set(product, 'MODEL-A');
    expect(() => ctx.restore({ messages: [], slots: { product: 'X', unknown: 1 }, turnCount: 3 })).toThrow('not defined');
    expect(ctx.peek(product)).toBe('MODEL-A');
    expect(ctx.turnCount).toBe(0);
    const failing = new ContextManager();
    const count = failing.defineSlot<number>('count', {
      deserialize: (raw) => {
        if (typeof raw !== 'number') throw new Error('count must be a number');
        return raw;
      },
    });
    failing.set(count, 1);
    expect(() => failing.restore({ messages: [], slots: { count: 'one' }, turnCount: 2 })).toThrow('must be a number');
    expect(failing.peek(count)).toBe(1);
    ctx.beginTurn();
    expect(() => ctx.restore({ messages: [], slots: {}, turnCount: 0 })).toThrow('transaction is open');
  });

  it('a foreign owner cannot clear an owned slot, the owner can', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product', { owner: 'writer' });
    ctx.as('writer').set(product, 'MODEL-A');
    expect(() => ctx.as('renderer').clear(product)).toThrow('cannot clear');
    expect(ctx.peek(product)).toBe('MODEL-A');
    ctx.as('writer').clear(product);
    expect(ctx.has(product)).toBe(false);
  });

  it('mutating an object read from a slot cannot change committed state; rollback restores the committed copy', () => {
    const ctx = new ContextManager();
    const objects = ctx.defineSlot<{ items: string[] }>('objects');
    const source = { items: ['a'] };
    ctx.set(objects, source);
    source.items.push('leaked-through-argument');
    const read = ctx.peek(objects)!;
    expect(read.items).toEqual(['a']);
    expect(() => {
      read.items.push('leaked-through-read');
    }).toThrow();
    const turn = ctx.beginTurn();
    turn.set(objects, { items: ['a', 'b'] });
    const staged = ctx.get(objects)!;
    expect(() => {
      (staged as { items: string[] }).items.push('leaked-through-staged');
    }).toThrow();
    turn.rollback();
    expect(ctx.peek(objects)).toEqual({ items: ['a'] });
  });

  it('consuming a consume-once slot invalidates cached lens views (consumption is a mutation)', () => {
    const ctx = new ContextManager();
    const signal = ctx.defineSlot<string>('signal', { lifecycle: 'consume-once' });
    ctx.set(signal, 'fire');
    const lens = { name: 'render', slots: ['signal'] as string[] };
    // Build + cache the view while the value is present.
    expect(ctx.through(lens).slots.signal).toBe('fire');
    // get() consumes the value — a cached view must not keep serving it.
    expect(ctx.get(signal)).toBe('fire');
    expect(ctx.through(lens).slots.signal).toBeUndefined();
  });

  it('has() sees staged changes during an open transaction, same as get() (read-your-writes)', () => {
    const ctx = new ContextManager();
    const product = ctx.defineSlot<string>('product');
    const pending = ctx.defineSlot<string>('pending');
    ctx.set(product, 'MODEL-A');

    const turn = ctx.beginTurn();
    turn.set(pending, 'staged');
    expect(ctx.get(pending)).toBe('staged');
    expect(ctx.has(pending)).toBe(true); // staged set is visible
    turn.clear(product);
    expect(ctx.get(product)).toBeUndefined();
    expect(ctx.has(product)).toBe(false); // staged clear is visible
    turn.rollback();

    expect(ctx.has(product)).toBe(true);
    expect(ctx.has(pending)).toBe(false);
  });

  it('a cached lens view is invalidated when knowledge changes (addKnowledge / clearKnowledge)', () => {
    // Cache-invalidation coverage: slot writes, restore and rollback are pinned
    // elsewhere; knowledge mutation was the remaining mutation type without a
    // staleness pin.
    const ctx = new ContextManager();
    const lens = { name: 'render', knowledge: { top: 5 } };
    ctx.addKnowledge('rag', [{ content: 'first', score: 0.9 }]);
    expect(ctx.through(lens).knowledge.map((k) => k.content)).toEqual(['first']);

    ctx.addKnowledge('rag', [{ content: 'second', score: 0.95 }]);
    expect(ctx.through(lens).knowledge.map((k) => k.content)).toEqual(['second', 'first']);

    ctx.clearKnowledge();
    expect(ctx.through(lens).knowledge).toHaveLength(0);
  });
});
