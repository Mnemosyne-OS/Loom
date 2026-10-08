/**
 * The card of one commit (doc 140 §1, §4): what it is, and which conversations
 * are tied to it — recorded links and probable ones in two separate lists,
 * never one.
 */
import { SessionRow } from './SessionRow';
import type { Commit, CommitLinks, Session } from '../lib/types';
import type { DocMark } from '../lib/marks';
import { useI18n } from '../i18n/useI18n';

interface Props {
  commit: Commit;
  links: CommitLinks;
  sessions: ReadonlyMap<string, Session>;
  /** Numbered documents this commit first brought into the repository. */
  docs?: readonly DocMark[];
  onClose: () => void;
}

/** The card of one commit, its tied conversations in two lists (recorded / probable). */
export function CommitCard({ commit, links, sessions, docs = [], onClose }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const recorded = links.recorded.map((id) => sessions.get(id)).filter((s): s is Session => !!s);
  const inferred = links.inferred.map((id) => sessions.get(id)).filter((s): s is Session => !!s);
  return (
    <aside className="card" aria-label={commit.subject}>
      <header>
        <code className="sha">{commit.sha.slice(0, 9)}</code>
        <button type="button" className="ghost" onClick={onClose}>{t('card.close')}</button>
      </header>
      <h2>{commit.subject}</h2>
      <p className="meta">
        {new Date(commit.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })}
        {' · '}{commit.author}
        {' · '}{t('card.files', { count: commit.files.length })}
        {commit.parents > 1 && <>{' · '}{t('card.merge')}</>}
      </p>

      {docs.length > 0 && (
        <section>
          <h3>{t('marks.firstSeen')}</h3>
          <ul>{docs.map((d) => <li key={d.path}><i className="diamond doc" /> {t('marks.docLabel', { number: d.number, title: d.title })}</li>)}</ul>
        </section>
      )}

      {recorded.length > 0 && (
        <section>
          <h3>{t('card.recorded')}</h3>
          <p className="help">{t('card.recordedHelp')}</p>
          <ul>{recorded.map((s) => <SessionRow key={s.id} s={s} />)}</ul>
        </section>
      )}
      {inferred.length > 0 && (
        <section className="inferred">
          <h3>{t('card.inferred')}</h3>
          <p className="help">{t('card.inferredHelp')}</p>
          <ul>{inferred.map((s) => <SessionRow key={s.id} s={s} probable />)}</ul>
        </section>
      )}
      {recorded.length === 0 && inferred.length === 0 && <p className="help">{t('card.noLink')}</p>}

      {commit.files.length > 0 && (
        <ul className="files">
          {commit.files.slice(0, 40).map((f) => <li key={f}><code>{f}</code></li>)}
          {commit.files.length > 40 && <li className="help">+ {commit.files.length - 40}</li>}
        </ul>
      )}
    </aside>
  );
}
