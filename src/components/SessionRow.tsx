/**
 * One conversation in a list: its title, when it started, its active time, and
 * a button that opens it as a readable document. Shared by the commit card and
 * the app card.
 */
import { useState } from 'react';
import { openConversation } from '../lib/host';
import { formatDuration, totalMs } from '../lib/active';
import type { Session } from '../lib/types';
import { useI18n } from '../i18n/useI18n';

interface Props {
  s: Session;
  /** Tied only by a probable link: drawn dashed, never as a record. */
  probable?: boolean;
  /** One more fact after the active time (e.g. how many commits it made here). */
  extra?: string;
}

/** One conversation in a list, with its active time and an Open button. */
export function SessionRow({ s, probable = false, extra }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const [state, setState] = useState<'idle' | 'opening' | { error: string }>('idle');
  const title = s.title?.trim() || t('card.untitled');
  const when = new Date(s.start).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li className={probable ? 'session-row probable' : 'session-row'}>
      <div className="session-text">
        <span className="session-title" title={title}>{title}</span>
        <span className="session-when">
          {when} · {t('card.active', { time: formatDuration(totalMs(s.active), lang) })}
          {extra ? ` · ${extra}` : ''}
        </span>
        {typeof state === 'object' && <span className="error-line">{t('card.openFailed', { reason: state.error })}</span>}
      </div>
      <button
        type="button"
        disabled={state === 'opening'}
        onClick={async () => {
          setState('opening');
          try {
            await openConversation(s.transcript, title);
            setState('idle');
          } catch (err) {
            console.error('[Loom] could not open a conversation:', err);
            setState({ error: err instanceof Error ? err.message : String(err) });
          }
        }}
      >
        {state === 'opening' ? t('card.opening') : t('card.open')}
      </button>
    </li>
  );
}
