import { describe, it, expect } from 'vitest';
import { _bundlesForTest, keysOf } from './useI18n';

const LANGS = Object.keys(_bundlesForTest) as Array<keyof typeof _bundlesForTest>;

describe('locales', () => {
  it('ships the seven languages of the app', () => {
    expect([...LANGS].sort()).toEqual(['de', 'en', 'es', 'fr', 'pt', 'ru', 'zh']);
  });

  it('every language carries exactly the keys of en', () => {
    const en = keysOf(_bundlesForTest.en).sort();
    for (const l of LANGS) expect(keysOf(_bundlesForTest[l]).sort(), l).toEqual(en);
  });

  it('keeps the same placeholders in every language', () => {
    const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();
    const get = (b: Record<string, unknown>, k: string) => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], b) as string;
    for (const k of keysOf(_bundlesForTest.en)) {
      for (const l of LANGS) expect(vars(get(_bundlesForTest[l], k)), `${l} ${k}`).toEqual(vars(get(_bundlesForTest.en, k)));
    }
  });

  it('leaves no English sentence behind in another language', () => {
    const get = (b: Record<string, unknown>, k: string) => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], b) as string;
    // Short labels can be the same word in two languages (Loom, commits, docs, merge…);
    // a whole sentence identical to the English one is a missed translation.
    for (const l of LANGS.filter((x) => x !== 'en')) {
      for (const k of keysOf(_bundlesForTest.en)) {
        const en = get(_bundlesForTest.en, k);
        if (en.split(' ').length < 4) continue;
        expect(get(_bundlesForTest[l], k), `${l} ${k}`).not.toBe(en);
      }
    }
  });

  it('has a sentence for every refusal code the git door returns', () => {
    for (const code of ['CANCELED', 'NOT_A_REPO', 'GIT_NOT_FOUND', 'GIT_TIMEOUT', 'GIT_OUTPUT_TOO_LARGE', 'GIT_FAILED', 'REPO_GONE',
      'UNKNOWN_REPO', 'TOO_MANY_REPOS', 'STORE_UNREADABLE', 'STORE_WRITE_FAILED']) {
      expect(keysOf(_bundlesForTest.en)).toContain(`error.${code}`);
    }
  });
});
