/**
 * useI18n — Loom follows the app's language, in the app's seven
 * (en, fr, es, de, pt, ru, zh).
 *
 * Same structure as Ember's: the host broadcasts its locale over the bridge
 * (`onHostConfig`), and the frame's query string carries it at mount, because
 * a cartridge that only listens sits in English until the person changes a
 * setting.
 */
import { useEffect, useState } from 'react';
import en from './locales/en.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import de from './locales/de.json';
import pt from './locales/pt.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';

export type LangCode = 'en' | 'fr' | 'es' | 'de' | 'pt' | 'ru' | 'zh';

const BUNDLES: Record<LangCode, Record<string, unknown>> = { en, fr, es, de, pt, ru, zh };

function isLang(v: unknown): v is LangCode {
  return typeof v === 'string' && v in BUNDLES;
}

function initialLang(): LangCode {
  try {
    const base = new URLSearchParams(window.location.search).get('lang')?.split('-')[0]?.toLowerCase();
    if (isLang(base)) return base;
  } catch (err) {
    // No location outside a browser (tests): English is the honest default.
    console.warn('[Loom] no frame location to read the language from:', err);
  }
  return 'en';
}

let _lang: LangCode = typeof window === 'undefined' ? 'en' : initialLang();
const _listeners = new Set<() => void>();

/** Take the shell's language if Loom ships it; otherwise stay put. */
export function adoptHostLang(lang: unknown): void {
  const base = typeof lang === 'string' ? lang.split('-')[0]?.toLowerCase() : undefined;
  if (!isLang(base) || base === _lang) return;
  _lang = base;
  if (typeof document !== 'undefined') document.documentElement.lang = base;
  _listeners.forEach((fn) => fn());
}

export function currentLang(): LangCode {
  return _lang;
}

function lookup(bundle: Record<string, unknown>, path: string): string | null {
  let cur: unknown = bundle;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/** Missing keys fall back to English, then to the key itself (visibly wrong). */
export function translate(key: string, vars?: Record<string, string | number>): string {
  const raw = lookup(BUNDLES[_lang], key) ?? lookup(BUNDLES.en, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function useI18n(): { t: typeof translate; lang: LangCode } {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
  return { t: translate, lang: _lang };
}

/** Every key path of a bundle, for the parity test. */
export function keysOf(bundle: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(bundle).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
}

export const _bundlesForTest = BUNDLES;
