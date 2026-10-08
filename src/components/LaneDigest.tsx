/**
 * The summary of one app (doc 140 §18), in three presses' worth of honesty:
 * 1. "Prepare": the person's messages are read again from the tied transcripts
 *    (Loom keeps no text) and the prompt is built — nothing is sent yet;
 * 2. the card says what WOULD be sent (characters, about how many tokens, how
 *    many commits and conversations out of how many) and to which model;
 * 3. "Send": one inference, kept in the cache, shown with its date.
 *
 * A kept summary is read back without spending anything, and says when it was
 * written and whether newer commits arrived since.
 */
import { useEffect, useRef, useState } from 'react';
import { approxTokens, buildDigestPrompt, type DigestConversation, type DigestPrompt, type StoredDigest } from '../lib/digest';
import { loadDigest, saveDigest } from '../lib/cache';
import { inferText, readHumanTurns } from '../lib/host';
import type { LaneConversation } from '../lib/laneStats';
import type { Commit } from '../lib/types';
import { useI18n } from '../i18n/useI18n';

interface Props {
  /** The cache key: repository and line. */
  cacheKey: string;
  laneName: string;
  commits: readonly Commit[];
  conversations: readonly LaneConversation[];
}

type State =
  | { kind: 'idle' }
  | { kind: 'reading'; done: number; total: number }
  | { kind: 'ready'; built: DigestPrompt; unread: number; capped: number }
  | { kind: 'sending'; built: DigestPrompt }
  | { kind: 'failed'; reason: string };

/** Conversations read for one summary, newest first. More would not fit the budget anyway. */
const MAX_READS = 40;

/** The summary of one line: prepare, say what would be sent, send, keep. */
export function LaneDigest({ cacheKey, laneName, commits, conversations }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const [kept, setKept] = useState<StoredDigest | null | undefined>(undefined);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [saveFailed, setSaveFailed] = useState(false);
  const alive = useRef(true);
  const cancel = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The kept summary of this line, if any (three states: undefined = asking).
  useEffect(() => {
    let live = true;
    setKept(undefined);
    setState({ kind: 'idle' });
    setSaveFailed(false);
    loadDigest(cacheKey)
      .then((d) => { if (live) setKept(d); })
      .catch((err: unknown) => { console.warn('[Loom] kept summary unreadable:', err); if (live) setKept(null); });
    return () => { live = false; };
  }, [cacheKey]);

  const newest = commits.reduce<Commit | null>((m, c) => (!m || c.at > m.at ? c : m), null);
  const outdated = !!kept && !!newest && kept.lastSha !== newest.sha;

  const prepare = async () => {
    cancel.current = false;
    const pick = [...conversations].sort((a, b) => b.session.start - a.session.start).slice(0, MAX_READS);
    const read: DigestConversation[] = [];
    let unread = 0;
    let capped = 0;
    for (let i = 0; i < pick.length; i++) {
      if (cancel.current || !alive.current) return;
      setState({ kind: 'reading', done: i, total: pick.length });
      const c = pick[i]!;
      try {
        const got = await readHumanTurns(c.session.transcript);
        if (got === null) { unread++; continue; }
        if (got.capped) capped++;
        read.push({ title: c.session.title, start: c.session.start, turns: got.turns });
      } catch (err) {
        console.warn('[Loom] a conversation could not be read for the summary:', err);
        unread++;
      }
    }
    if (!alive.current) return;
    const built = buildDigestPrompt({ lane: laneName, commits, conversations: read, lang });
    // Every conversation tied to the line counts in the "out of": the ones
    // past MAX_READS were not read, and the screen must not hide them.
    setState({ kind: 'ready', built: { ...built, conversationsTotal: conversations.length }, unread, capped });
  };

  const send = async (built: DigestPrompt) => {
    setState({ kind: 'sending', built });
    try {
      const text = await inferText(built.prompt, built.systemPrompt);
      const digest: StoredDigest = {
        text, at: Date.now(), from: built.from, to: built.to,
        commitsUsed: built.commitsUsed, commitsTotal: built.commitsTotal,
        conversationsUsed: built.conversationsUsed, conversationsTotal: built.conversationsTotal,
        lastSha: newest?.sha ?? null,
      };
      const ok = await saveDigest(cacheKey, digest);
      if (!alive.current) return;
      setKept(digest);
      setSaveFailed(!ok);
      setState({ kind: 'idle' });
    } catch (err) {
      console.error('[Loom] the summary failed:', err);
      if (alive.current) setState({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const date = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleDateString(lang, { dateStyle: 'medium' }));

  return (
    <section className="digest">
      <h3>{t('digest.title')}</h3>

      {kept === undefined && <p className="help">…</p>}

      {kept && state.kind === 'idle' && (
        <>
          <p className="digest-text">{kept.text}</p>
          <p className="help">
            {t('digest.writtenOn', { date: new Date(kept.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) })}
            {' · '}{t('digest.covered', { from: date(kept.from), to: date(kept.to) })}
            {' · '}{t('digest.basedOn', { c: kept.commitsUsed, ct: kept.commitsTotal, v: kept.conversationsUsed, vt: kept.conversationsTotal })}
          </p>
          {outdated && <p className="help">{t('digest.outdated')}</p>}
          {saveFailed && <p className="error-line">{t('digest.notKept')}</p>}
        </>
      )}

      {state.kind === 'idle' && kept !== undefined && (
        <button type="button" className="pill" onClick={() => void prepare()}>
          {kept ? t('digest.redo') : t('digest.prepare')}
        </button>
      )}

      {state.kind === 'reading' && (
        <>
          <p className="help">{t('digest.reading', { done: state.done, total: state.total })}</p>
          <button type="button" className="pill ghost" onClick={() => { cancel.current = true; setState({ kind: 'idle' }); }}>{t('digest.cancel')}</button>
        </>
      )}

      {(state.kind === 'ready' || state.kind === 'sending') && (
        <div className="digest-confirm">
          <p>
            {t('digest.willSend', {
              chars: state.built.chars.toLocaleString(lang),
              tokens: approxTokens(state.built.chars).toLocaleString(lang),
            })}
          </p>
          <p className="help">
            {t('digest.basedOn', { c: state.built.commitsUsed, ct: state.built.commitsTotal, v: state.built.conversationsUsed, vt: state.built.conversationsTotal })}
            {state.kind === 'ready' && state.unread > 0 && <> · {t('digest.unread', { count: state.unread })}</>}
            {state.kind === 'ready' && state.capped > 0 && <> · {t('digest.capped', { count: state.capped, max: 40 })}</>}
          </p>
          <p className="help">{t('digest.what')}</p>
          {state.kind === 'ready' ? (
            <div className="row">
              <button type="button" className="pill primary" onClick={() => void send(state.built)} disabled={!state.built.commitsUsed && !state.built.conversationsUsed}>
                {t('digest.send')}
              </button>
              <button type="button" className="pill ghost" onClick={() => setState({ kind: 'idle' })}>{t('digest.cancel')}</button>
            </div>
          ) : <p className="help">{t('digest.sending')}</p>}
        </div>
      )}

      {state.kind === 'failed' && (
        <>
          <p className="error-line">{t('digest.failed', { reason: state.reason })}</p>
          <button type="button" className="pill" onClick={() => setState({ kind: 'idle' })}>{t('digest.back')}</button>
        </>
      )}
    </section>
  );
}
