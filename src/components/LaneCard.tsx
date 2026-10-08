/**
 * The card of one app (doc 140 §16): opened by a click on its name. The
 * timeline zooms onto the app's period at the same time.
 */
import { formatDuration } from '../lib/active';
import type { LaneStats } from '../lib/laneStats';
import { SessionRow } from './SessionRow';
import { LaneDigest } from './LaneDigest';
import type { Commit } from '../lib/types';
import { useI18n } from '../i18n/useI18n';

interface Props {
  name: string;
  stats: LaneStats;
  onClose: () => void;
  /** Splitting the app into sub-lines, or folding them back. Null: not an app. */
  split: { on: boolean; app: string; toggle: () => void } | null;
  /** The summary of this line: where it is kept, and the commits it is about. */
  digest: { cacheKey: string; commits: readonly Commit[] };
}

const MAX_CONVERSATIONS = 12;

/** The card of one line (an app or a sub-line): figures, summary, conversations, files. */
export function LaneCard({ name, stats, onClose, split, digest }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const date = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleDateString(lang, { dateStyle: 'medium' }));
  const peak = Math.max(1, ...stats.weeks);
  const pct = (n: number) => (stats.commits ? Math.round((n / stats.commits) * 100) : 0);

  return (
    <aside className="card lane-card" aria-label={name}>
      <header>
        <h2 className="lane-name">{name}</h2>
        <button type="button" className="ghost" onClick={onClose}>{t('card.close')}</button>
      </header>
      <p className="meta">{date(stats.first)} → {date(stats.last)}</p>
      {split && (
        <button type="button" className="split-toggle" onClick={split.toggle}>
          {split.on ? t('lane.fold', { app: split.app }) : t('lane.split')}
        </button>
      )}

      <div className="figures">
        <div><strong>{stats.commits}</strong><span>{t('lane.commits')}</span></div>
        <div><strong>{formatDuration(stats.activeMs, lang)}</strong><span>{t('lane.active')}</span></div>
        <div><strong>{stats.conversations.length}</strong><span>{t('lane.conversations')}</span></div>
      </div>

      <div className="family-bar" aria-hidden="true">
        {(['feat', 'fix', 'docs', 'other'] as const).map((f) => (
          stats.byFamily[f] > 0 && <i key={f} className={`seg ${f}`} style={{ flexGrow: stats.byFamily[f] }} />
        ))}
      </div>
      <p className="help">
        {t('types.feat')} {stats.byFamily.feat} · {t('types.fix')} {stats.byFamily.fix} · {t('types.docs')} {stats.byFamily.docs} · {t('types.other')} {stats.byFamily.other}
      </p>
      <p className="help">
        {t('lane.links', { rec: pct(stats.recorded), inf: pct(stats.inferredOnly), none: pct(stats.none) })}
      </p>

      <LaneDigest cacheKey={digest.cacheKey} laneName={name} commits={digest.commits} conversations={stats.conversations} />

      {stats.weeks.length > 1 && (
        <section>
          <h3>{t('lane.perWeek')}</h3>
          <svg className="weeks" viewBox={`0 0 ${stats.weeks.length} 20`} preserveAspectRatio="none" role="img" aria-label={t('lane.perWeek')}>
            {stats.weeks.map((n, i) => (
              <rect key={i} x={i + 0.1} width={0.8} y={20 - (n / peak) * 20} height={(n / peak) * 20} />
            ))}
          </svg>
        </section>
      )}

      {stats.conversations.length > 0 && (
        <section>
          <h3>{t('lane.topConversations')}</h3>
          <ul>
            {stats.conversations.slice(0, MAX_CONVERSATIONS).map((c) => (
              <SessionRow key={c.session.id} s={c.session} probable={!c.recorded} extra={t('lane.convCommits', { count: c.commits })} />
            ))}
          </ul>
          {stats.conversations.length > MAX_CONVERSATIONS && (
            <p className="help">{t('lane.more', { count: stats.conversations.length - MAX_CONVERSATIONS })}</p>
          )}
        </section>
      )}

      {stats.topFiles.length > 0 && (
        <section>
          <h3>{t('lane.topFiles')}</h3>
          <ul className="files">
            {stats.topFiles.map((f) => (
              <li key={f.file}><code title={f.file}>{f.file}</code> <span className="help">{f.commits}</span></li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
