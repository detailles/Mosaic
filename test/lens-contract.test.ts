/**
 * Exercises typed lens projections, definition-scoped caching and persisted chat turns.
 * Uses only Mosaic's public API; no provider, scenario runner or application state is involved.
 * Existing tests cover slot transactions but not these cross-view and chat-resume boundaries.
 */
import { describe, expect, it } from 'bun:test';
import { ContextManager, defineLens } from '../src/index.js';

describe('Lens definition and chat turn contracts', () => {
  it('projects typed slot references by alias and keeps unset slots explicit', () => {
    const context = new ContextManager();
    const product = context.defineSlot<{ code: string }>('support.product');
    const reports = context.defineSlot<string[]>('support.reports');
    context.set(product, { code: 'CONTROLLER' });
    const lens = defineLens('interpretation', { slots: { product, reports } });
    const view = context.through(lens);
    expect(view.slots.product).toEqual({ code: 'CONTROLLER' });
    expect(view.slots.reports).toBeUndefined();
    expect(context.through(lens)).toBe(view);
    const transaction = context.beginTurn();
    context.set(reports, ['new report']);
    expect(context.through(lens).slots.reports).toEqual(['new report']);
    transaction.rollback();
    expect(context.through(lens).slots.reports).toBeUndefined();
  });

  it('does not reuse another definition with the same display name', () => {
    const context = new ContextManager();
    context.addMessage('user', 'first');
    context.addMessage('assistant', 'second');
    const narrow = defineLens('reader', { messages: { last: 1 } });
    const wide = defineLens('reader', { messages: { last: 2 } });
    const narrowView = context.through(narrow);
    expect(context.through(wide).messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(context.through(narrow)).toBe(narrowView);
    context.addMessage('user', 'third');
    expect(context.through(narrow).messages.map((message) => message.content)).toEqual(['third']);
  });

  it('isolates definition options and lets a replacement closure have its own cache', () => {
    const context = new ContextManager();
    context.addMessage('user', 'first');
    context.addMessage('assistant', 'second');
    const messages = { last: 1 };
    const lens = defineLens('reader', { messages });
    messages.last = 2;
    expect(context.through(lens).messageCount).toBe(1);
    expect(Object.isFrozen(lens.messages)).toBe(true);
    const user = defineLens('role', { messages: { filter: (message) => message.role === 'user' } });
    const assistant = defineLens('role', { messages: { filter: (message) => message.role === 'assistant' } });
    expect(context.through(user).messages[0]?.content).toBe('first');
    expect(context.through(assistant).messages[0]?.content).toBe('second');
  });

  it('keeps current, rolling and cumulative views distinct across a long chat and reload', () => {
    let context = new ContextManager({ maxMessages: 0 });
    const current = defineLens('current', { messages: { turns: 'current' } });
    const rolling = defineLens('rolling', { messages: { turns: { last: 3 } } });
    const cumulative = defineLens('cumulative', {});
    for (let turn = 0; turn < 160; turn++) {
      if (turn > 0) context.nextTurn();
      context.addMessage('user', `question ${turn}`);
      context.addMessage('assistant', `answer ${turn}`);
      expect(context.through(current).messages.map((message) => message.turn)).toEqual([turn, turn]);
      if (turn === 79) {
        const snapshot = JSON.parse(JSON.stringify(context.snapshot()));
        context = new ContextManager({ maxMessages: 0 });
        context.restore(snapshot);
      }
    }
    expect(context.turnCount).toBe(159);
    expect(context.through(cumulative).messageCount).toBe(320);
    expect(context.through(rolling).messages.map((message) => message.turn)).toEqual([157, 157, 158, 158, 159, 159]);
    expect(context.through(current).messages.map((message) => message.content)).toEqual(['question 159', 'answer 159']);
    expect(context.snapshot().messages[0]?.turn).toBe(0);
  });

  it('counts actual chat turns, not messages, and never renumbers after retention', () => {
    const context = new ContextManager({ maxMessages: 3 });
    const current = defineLens('current', { messages: { turns: 'current' } });
    const lastTwo = defineLens('rolling', { messages: { turns: { last: 2 } } });
    context.addMessage('user', 'turn zero');
    context.nextTurn();
    context.addMessage('user', 'turn one');
    context.nextTurn();
    context.nextTurn();
    expect(context.through(current).messages).toEqual([]);
    expect(context.through(lastTwo).messages).toEqual([]);
    context.addMessage('user', 'photo');
    context.addMessage('user', 'caption');
    context.addMessage('assistant', 'reply');
    expect(context.through(current).messages.map((message) => message.turn)).toEqual([3, 3, 3]);
    expect(context.through(defineLens('last message', { messages: { turns: 'current', last: 1 } })).messages[0]?.content).toBe('reply');
    expect(context.through(defineLens('empty', { messages: { turns: { last: 0 } } })).messages).toEqual([]);
    context.nextTurn();
    context.addMessage('user', 'next');
    expect(context.allMessages().map((message) => message.turn)).toEqual([3, 3, 4]);
  });

  it('preserves old messages without inventing a turn and rejects corrupt turn metadata before restore', () => {
    const context = new ContextManager();
    context.restore({
      messages: [{ role: 'user', content: 'legacy', timestamp: new Date(0).toISOString() }],
      slots: {},
      turnCount: 9,
    });
    const current = defineLens('current', { messages: { turns: 'current' } });
    expect(context.through(current).messages).toEqual([]);
    expect(context.allMessages()[0]?.turn).toBeUndefined();
    context.addMessage('user', 'known turn');
    expect(context.through(current).messages.map((message) => message.turn)).toEqual([9]);
    const valid = context.snapshot();
    for (const turn of [-1, 1.5, 10]) {
      expect(() => context.restore({ ...valid, messages: [{ ...valid.messages[1]!, turn }] })).toThrow();
      expect(context.snapshot()).toEqual(valid);
    }
  });
});
