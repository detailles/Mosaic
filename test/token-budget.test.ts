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
