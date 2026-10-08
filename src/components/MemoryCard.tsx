/**
 * The card of one agent memory note (doc 140 §19): its name, when it was last
 * modified (the listing gives no creation date), its description from the
 * front matter, and a button that opens the file. The note is read on the
 * click that opens the card, never before.
 */
import { useEffect, useState } from 'react';
import { noteDescription, type MemoryMark } from '../lib/marks';
import { sdk } from '../lib/host';
import { useI18n } from '../i18n/useI18n';

interface Props {
  mark: MemoryMark;
  onClose: () => void;
}

/** The card of one agent memory note, read on the click that opens it. */
export function MemoryCard({ mark, onClose }: Props): JSX.Element {
  const { t, lang } = useI18n();
  // undefined = reading, null = no description in it, string = the description.
  const [desc, setDesc] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDesc(undefined);
    setError(null);
    sdk.readFile(mark.path)
      .then((res) => {
        if (!live) return;
        if (!res?.success || typeof res.content !== 'string') { setError(res?.error ?? 'READ_REFUSED'); setDesc(null); return; }
        setDesc(noteDescription(res.content));
      })
      .catch((err: unknown) => {
        console.warn('[Loom] a memory note could not be read:', err);
        if (live) { setError(err instanceof Error ? err.message : String(err)); setDesc(null); }
      });
    return () => { live = false; };
  }, [mark.path]);

  return (
    <aside className="card" aria-label={mark.name}>
      <header>
        <span className="chip">{t('memory.kind')}</span>
        <button type="button" className="ghost" onClick={onClose}>{t('card.close')}</button>
      </header>
      <h2>{mark.name}</h2>
      <p className="meta">{t('memory.modified', { date: new Date(mark.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
      {desc === undefined && <p className="help">…</p>}
      {typeof desc === 'string' && <p>{desc}</p>}
      {desc === null && !error && <p className="help">{t('memory.noDescription')}</p>}
      {error && <p className="error-line">{t('card.openFailed', { reason: error })}</p>}
      <button
        type="button"
        onClick={async () => {
          try {
            const res = await sdk.openInOS(mark.path);
            if (!res?.success) setError(res?.error ?? 'OPEN_REFUSED');
          } catch (err) {
            console.error('[Loom] could not open a memory note:', err);
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        {t('card.open')}
      </button>
    </aside>
  );
}
