/** The summary prompt (doc 140 §18): what goes in, what is left out, and that it is said. */
import { describe, it, expect } from 'vitest';
import { approxTokens, buildDigestPrompt, DIGEST_BUDGET } from './digest';
import type { Commit } from './types';

const D = 86_400_000;
const commit = (i: number, subject = `feat(x): change ${i}`): Commit => ({
  sha: String(i).padStart(40, '0'), at: i * D, author: '', parents: 1, subject, type: 'feat', scope: 'x', files: [],
});
const conv = (i: number, turns: string[]) => ({ title: `conv ${i}`, start: i * D, turns: turns.map((text) => ({ at: i * D, text })) });

describe('buildDigestPrompt', () => {
  it('sends commit messages and the person\'s words, oldest first, and counts them', () => {
    const p = buildDigestPrompt({ lane: 'chat', commits: [commit(2), commit(1)], conversations: [conv(3, ['make it faster'])], lang: 'fr' });
    expect(p.systemPrompt).toContain('French');
    expect(p.prompt.indexOf('change 1')).toBeLessThan(p.prompt.indexOf('change 2'));
    expect(p.prompt).toContain('- make it faster');
    expect(p).toMatchObject({ commitsUsed: 2, commitsTotal: 2, conversationsUsed: 1, conversationsTotal: 1, from: D, to: 3 * D });
    expect(p.chars).toBe(p.systemPrompt.length + p.prompt.length);
  });

  it('keeps the NEWEST material when the budget is short, and says how much was left out', () => {
    const commits = Array.from({ length: 200 }, (_, i) => commit(i));
    const p = buildDigestPrompt({ lane: 'x', commits, conversations: [], lang: 'en', budget: 2000 });
    expect(p.commitsUsed).toBeLessThan(200);
    expect(p.commitsTotal).toBe(200);
    expect(p.prompt).toContain(`(${p.commitsUsed} of 200`);
    expect(p.prompt).toContain('change 199');
    expect(p.prompt).not.toContain('change 0\n');
  });

  it('keeps HALF the budget for the person\'s words on a line with thousands of commits (M63)', () => {
    // infinity-edition carries ~3 100 commits (~190 000 characters of subjects):
    // without the half, no word the person typed would reach the model.
    const commits = Array.from({ length: 3000 }, (_, i) => commit(i, `feat(x): commit number ${i} with a subject long enough to count`));
    const turns = Array.from({ length: 30 }, (_, i) => `the person typed message ${i} about what should be built here`);
    const p = buildDigestPrompt({ lane: 'x', commits, conversations: [conv(3001, turns)], lang: 'en' });
    expect(p.conversationsUsed).toBe(1);
    const commitChars = p.prompt.split('\n# What the person typed')[0]!.length;
    expect(commitChars).toBeLessThanOrEqual(Math.floor(DIGEST_BUDGET / 2) + 100);
  });

  it('cuts one very long message instead of letting it eat the budget', () => {
    const p = buildDigestPrompt({ lane: 'x', commits: [], conversations: [conv(1, ['a'.repeat(5000)])], lang: 'en' });
    expect(p.prompt).toContain(`${'a'.repeat(600)}…`);
    expect(p.prompt).not.toContain('a'.repeat(601));
  });

  it('skips a conversation in which the person typed nothing', () => {
    const p = buildDigestPrompt({ lane: 'x', commits: [], conversations: [conv(1, ['  ']), conv(2, ['hi'])], lang: 'en' });
    expect(p.conversationsUsed).toBe(1);
    expect(p.conversationsTotal).toBe(2);
  });

  it('forbids numbers and invented outcomes in the instructions', () => {
    const p = buildDigestPrompt({ lane: 'x', commits: [commit(1)], conversations: [], lang: 'en' });
    expect(p.systemPrompt).toMatch(/No numbers/);
    expect(p.systemPrompt).toMatch(/Never invent an outcome/);
    expect(p.systemPrompt).toMatch(/never saw the agent's replies/);
  });

  it('says nothing was sent as null dates, never an epoch', () => {
    const p = buildDigestPrompt({ lane: 'x', commits: [], conversations: [], lang: 'en' });
    expect(p.from).toBeNull();
    expect(p.to).toBeNull();
  });

  it('estimates tokens at about four characters each', () => {
    expect(approxTokens(4000)).toBe(1000);
  });
});
