import { describe, expect, it } from 'bun:test';
import { estimateTokens, TokenBudget } from '../src/token-budget';

describe('TokenBudget.compile() sectionUsage', () => {
  it('returns sectionUsage with per-section token counts that sum to usage.used', () => {
    const budget = new TokenBudget({ limit: 8192, countTokens: estimateTokens });

    budget.reserve('system', 'You are a helpful assistant.', { priority: 'fixed' });
    budget.reserve('history', 'User asked about elevators.', { priority: 'high', strategy: 'tail' });
    budget.reserve('knowledge', 'Elevator specs: max load 1000kg.', { priority: 'medium', strategy: 'rank' });
    budget.reserve('state', 'Product: MODEL-A', { priority: 'low', droppable: true });

    const result = budget.compile();

    // sectionUsage should exist
    expect(result.sectionUsage).toBeDefined();

    // Should have entries for all sections
    expect(result.sectionUsage).toHaveProperty('system');
    expect(result.sectionUsage).toHaveProperty('history');
    expect(result.sectionUsage).toHaveProperty('knowledge');
    expect(result.sectionUsage).toHaveProperty('state');

    // Each section's token count should be positive
    expect(result.sectionUsage.system).toBeGreaterThan(0);
    expect(result.sectionUsage.history).toBeGreaterThan(0);
    expect(result.sectionUsage.knowledge).toBeGreaterThan(0);
    expect(result.sectionUsage.state).toBeGreaterThan(0);

    // Sum of all section usages should equal usage.used
    const totalFromSections = Object.values(result.sectionUsage).reduce((sum, v) => sum + v, 0);
    expect(totalFromSections).toBe(result.usage.used);
  });

  it('includes entries for dropped sections showing 0', () => {
    // Create a very tight budget that forces dropping
    const budget = new TokenBudget({ limit: 30, countTokens: estimateTokens });

    budget.reserve('system', 'System prompt that takes many tokens to fill up the budget significantly.', { priority: 'fixed' });
    budget.reserve('state', 'Some low-priority state context that will be dropped.', { priority: 'low', droppable: true });

    const result = budget.compile();

    // sectionUsage should include all reserved sections
    expect(result.sectionUsage).toHaveProperty('system');
    expect(result.sectionUsage).toHaveProperty('state');

    // Dropped section should show 0
    if (result.dropped.includes('state')) {
      expect(result.sectionUsage.state).toBe(0);
    }

    // Non-dropped sections should have their token count
    expect(result.sectionUsage.system).toBeGreaterThan(0);
  });

  it('reflects post-shrink token count when sections are shrunk', () => {
    // Budget tight enough to force shrinking
    const budget = new TokenBudget({ limit: 40, countTokens: estimateTokens });

    budget.reserve('system', 'Fixed system prompt.', { priority: 'fixed' });
    budget.reserveItems(
      'history',
      [{ content: 'Message one about elevator maintenance procedures.' }, { content: 'Message two about motor diagnostics and testing.' }, { content: 'Message three about safety protocols.' }],
      { priority: 'high', strategy: 'tail' }
    );

    const result = budget.compile();

    // sectionUsage for shrunk sections should reflect actual fitted tokens, not original
    if (result.shrunk.includes('history')) {
      // The shrunk section should have fewer tokens than the original
      const originalTokens = estimateTokens('Message one about elevator maintenance procedures.Message two about motor diagnostics and testing.Message three about safety protocols.');
      expect(result.sectionUsage.history).toBeLessThan(originalTokens);
    }

    // Sum should still equal usage.used
    const totalFromSections = Object.values(result.sectionUsage).reduce((sum, v) => sum + v, 0);
    expect(totalFromSections).toBe(result.usage.used);
  });
});

describe('TokenBudget.compile() boundary conditions', () => {
  it('throws when a section name is reserved twice (names key the compile result)', () => {
    // Pins O5: duplicate names silently collided in compile()'s name-keyed
    // paths — the second reserve must fail fast and leave the first intact.
    const budget = new TokenBudget({ limit: 100, countTokens: estimateTokens });
    budget.reserve('system', 'first');
    expect(() => budget.reserve('system', 'second')).toThrow('Budget section "system" is already reserved');
    expect(() => budget.reserveItems('system', [{ content: 'third' }])).toThrow('Budget section "system" is already reserved');

    // The original reservation is untouched and still compiles.
    const result = budget.compile();
    expect(result.sections.system).toEqual(['first']);
  });

  it('keeps every section when the total exactly equals the limit (inclusive boundary)', () => {
    // Pins the <= boundary: an exact fit must not trigger the shrink/drop path.
    const budget = new TokenBudget({ limit: 25, countTokens: estimateTokens });
    budget.reserve('system', 'A'.repeat(40), { priority: 'fixed' }); // 10 tokens
    budget.reserve('history', 'B'.repeat(60), { priority: 'high', strategy: 'tail' }); // 15 tokens

    const result = budget.compile();
    expect(result.dropped).toHaveLength(0);
    expect(result.shrunk).toHaveLength(0);
    expect(result.sections.history).toEqual(['B'.repeat(60)]);
    expect(result.usage.used).toBe(25);
    expect(result.usage.utilization).toBe(1);
  });

  it('treats an empty section as free: present in sections, 0 in sectionUsage', () => {
    // Pins empty-section behavior: zero-token content must not be dropped or
    // count against the budget.
    const budget = new TokenBudget({ limit: 10, countTokens: estimateTokens });
    budget.reserve('empty', '', { priority: 'low' });
    budget.reserve('system', 'A'.repeat(40), { priority: 'fixed' }); // exactly 10 tokens

    const result = budget.compile();
    expect(result.sections.empty).toEqual(['']);
    expect(result.sectionUsage.empty).toBe(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('shrinks a single oversized item to an empty section with tail strategy (not dropped)', () => {
    // Pins the degenerate tail case: one item that alone exceeds the budget
    // shrinks to [], is reported as shrunk rather than dropped.
    const budget = new TokenBudget({ limit: 5, countTokens: estimateTokens });
    budget.reserveItems('history', [{ content: 'A'.repeat(400) }], { priority: 'high', strategy: 'tail' });

    const result = budget.compile();
    expect(result.shrunk).toContain('history');
    expect(result.dropped).not.toContain('history');
    expect(result.sections.history).toEqual([]);
    expect(result.sectionUsage.history).toBe(0);
    expect(result.usage.used).toBe(0);
  });
});

describe('TokenBudget rank overflow policy (onOverflow)', () => {
  // Same scenario for both tests: total 60 tokens over a limit of 20, so the
  // rank section shrinks to a 20-token target. Item A alone (40 tokens) cannot fit.
  const items = () => [
    { content: 'A'.repeat(160), score: 0.9 }, // 40 tokens — too big for the target
    { content: 'B'.repeat(40), score: 0.8 }, // 10 tokens
    { content: 'C'.repeat(40), score: 0.7 }, // 10 tokens
  ];

  it("best-fit skips the oversized high-scored item and packs the smaller ones", () => {
    // Pins the new opt-in policy: skip-and-continue fills the budget instead of
    // stopping at the first item that does not fit.
    const budget = new TokenBudget({ limit: 20, countTokens: estimateTokens });
    budget.reserveItems('chunks', items(), { priority: 'medium', strategy: 'rank', onOverflow: 'best-fit' });

    const result = budget.compile();
    expect(result.sections.chunks).toEqual(['B'.repeat(40), 'C'.repeat(40)]);
    expect(result.usage.used).toBe(20);
  });

  it("default 'prefix' keeps the historical break-on-first-overflow behavior", () => {
    // Regression guard: without onOverflow the result is a prefix of the
    // score-sorted list — A does not fit, so nothing after it is packed either.
    const budget = new TokenBudget({ limit: 20, countTokens: estimateTokens });
    budget.reserveItems('chunks', items(), { priority: 'medium', strategy: 'rank' });

    const result = budget.compile();
    expect(result.sections.chunks).toEqual([]);
    expect(result.shrunk).toContain('chunks');
    expect(result.usage.used).toBe(0);
  });
});

describe('TokenBudget rerank hook', () => {
  const items = () => [
    { content: 'low', score: 0.1 }, // 1 token each (3 chars)
    { content: 'mid', score: 0.5 },
    { content: 'top', score: 0.9 },
  ];

  it('is called exactly once when a rank section must shrink, and its output is packed', () => {
    // Pins the hook contract: fires under budget pressure, and returned
    // order/scores feed the stable sort + pack.
    const calls: string[][] = [];
    const budget = new TokenBudget({ limit: 2, countTokens: estimateTokens });
    budget.reserveItems('chunks', items(), {
      priority: 'medium',
      strategy: 'rank',
      rerank: (items) => {
        calls.push(items.map((i) => i.content));
        return items.map((i) => (i.content === 'low' ? { ...i, score: 0.99 } : i));
      },
    });

    const result = budget.compile();
    expect(calls).toEqual([['low', 'mid', 'top']]);
    // 'low' was boosted above 'top' by the reranker, so it packs first.
    expect(result.sections.chunks).toEqual(['low', 'top']);
  });

  it('is NOT called when the section fits without shrinking (cost paid only under pressure)', () => {
    // Pins the lazy-invocation contract: no overflow → no reranker call.
    let calls = 0;
    const budget = new TokenBudget({ limit: 10, countTokens: estimateTokens });
    budget.reserveItems('chunks', items(), {
      priority: 'medium',
      strategy: 'rank',
      rerank: (items) => {
        calls++;
        return items;
      },
    });

    const result = budget.compile();
    expect(calls).toBe(0);
    expect(result.sections.chunks).toEqual(['low', 'mid', 'top']);
  });
});

describe('TokenBudget tokenizer-aware truncate', () => {
  it('leaves content whole when it fits according to the real counter (no char-estimate cut)', () => {
    // Pins the O4 fix: the old char/4 estimate cut this content even though the
    // real counter says it fits the shrink target. Sublinear counter makes the
    // joined text cheaper per char than the estimate assumes.
    const sqrtTokens = (t: string) => Math.ceil(Math.sqrt(t.length));
    const a = 'a'.repeat(400); // 20 tokens
    const b = 'b'.repeat(400); // 20 tokens — joined: 801 chars → 29 tokens
    const budget = new TokenBudget({ limit: 55, countTokens: sqrtTokens });
    budget.reserveItems('doc', [ { content: a }, { content: b } ], { priority: 'low', droppable: false, strategy: 'truncate' });
    budget.reserve('fixed', 'f'.repeat(400), { priority: 'high' }); // 20 tokens; total 60, overflow 5 → target 35

    const result = budget.compile();
    // 29 <= 35: the joined content must survive untouched (old code cut it at 140 chars).
    expect(result.sections.doc).toEqual([`${a}\n${b}`]);
    expect(result.sectionUsage.doc).toBe(29);
  });

  it('cuts to a prefix that truly fits the target, ellipsis cost included', () => {
    // Pins the binary-search contract with a counter the char/4 estimate gets
    // wrong in the other direction: only '#' chars cost tokens.
    const hashTokens = (t: string) => (t.match(/#/g) ?? []).length;
    const budget = new TokenBudget({ limit: 9, countTokens: hashTokens });
    budget.reserve('doc', `${'#'.repeat(8)}${'x'.repeat(392)}`, { priority: 'medium', strategy: 'truncate' }); // 8 tokens
    budget.reserve('fixed', '## yy', { priority: 'high' }); // 2 tokens; total 10, overflow 1 → target 7

    const result = budget.compile();
    const truncated = result.sections.doc[0];
    // Exactly 7 '#' fit; the 8th would blow the target. Ellipsis adds no '#'.
    expect(truncated).toBe(`${'#'.repeat(7)}...`);
    expect(hashTokens(truncated)).toBeLessThanOrEqual(7);
    expect(truncated.endsWith('...')).toBe(true);
    expect(result.usage.used).toBe(9);
    expect(result.usage.used).toBeLessThanOrEqual(result.usage.limit);
  });

  it('emits an empty string when even the ellipsis exceeds the target', () => {
    // Pins the degenerate edge: target 2 tokens, '...' costs 3 — never exceed.
    const lengthTokens = (t: string) => t.length;
    const budget = new TokenBudget({ limit: 100, countTokens: lengthTokens });
    budget.reserve('doc', 'x'.repeat(100), { priority: 'medium', strategy: 'truncate' }); // 100 tokens
    budget.reserve('fixed', 'y'.repeat(98), { priority: 'high' }); // 98 tokens; overflow 98 → target 2

    const result = budget.compile();
    expect(result.sections.doc).toEqual(['']);
    expect(result.sectionUsage.doc).toBe(0);
  });

  it('never exceeds the target under a non-monotone counter (fit guarantee, not max retention)', () => {
    // Pins the honest truncate contract: real tokenizers are not monotone over
    // prefixes — 'international' merges into one cheap span below, mimicking
    // tiktoken BPE merges — so binary search may stop short of the longest
    // fitting prefix. What must ALWAYS hold: the emitted cut fits the target.
    const mergeTokens = (t: string) => t.replace(/international/g, 'I').length;
    const content = `international${'x'.repeat(50)}`; // full: 1 + 50 = 51 tokens
    const budget = new TokenBudget({ limit: 55, countTokens: mergeTokens });
    budget.reserve('doc', content, { priority: 'medium', strategy: 'truncate' });
    budget.reserve('fixed', 'y'.repeat(51), { priority: 'high' }); // 51 tokens; overflow 47 → target 4

    const result = budget.compile();
    const truncated = result.sections.doc[0];
    // Fit guarantee: never exceeds the shrink target, ellipsis included.
    expect(mergeTokens(truncated)).toBeLessThanOrEqual(4);
    // Non-maximality is accepted behavior: 'international...' would also cost
    // exactly 4 (1 + 3), yet the search legitimately lands on a shorter cut.
    expect(mergeTokens('international...')).toBe(4);
    expect(truncated.length).toBeLessThan('international...'.length);
    expect(truncated.endsWith('...')).toBe(true);
  });
});
