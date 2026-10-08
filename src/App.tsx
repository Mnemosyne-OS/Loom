/**
 * Loom (doc 140): choose a repository and conversation folders, read them,
 * draw the history.
 *
 * Layout: a glass bar on top (title, counts, Sources, Read), a Sources sheet
 * that is open until the first reading and folds away after, and the timeline
 * over the whole height below.
 *
 * Nothing is read before the person presses "Read". The repository comes from
 * the host's folder dialog (`git.declareRepo`); every conversation folder from
 * `dialog.selectFolder`, as many as the person adds. A pass is all or nothing
 * on screen: a stopped pass draws nothing rather than a timeline that looks
 * complete and is not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONNECTORS } from '@mnemosyne_os/agent-transcripts';
import {
  declareRepo, errorCodeOf, forgetRepo, hasHost, invoke, listRepos, sdk, type RepoRef,
} from './lib/host';
import { groupsOfRoot, matchingGroups, type ProjectGroup } from './lib/projects';
import { listFolders, listMemoryNotes, listTranscripts, loadCommits, readTranscripts, type ReadStats, type TranscriptFile } from './lib/scan';
import { coverageOf, linkCommits } from './lib/links';
import { loadFileCache, loadHistory, saveFileCache, saveHistory } from './lib/cache';
import { buildLanes, DEFAULT_LANES, foldedScopes } from './lib/lanes';
import { tiedActiveMs } from './lib/laneData';
import { formatDuration } from './lib/active';
import { areaOfLane, autoSplit, buildAreaLanes, detectContainers, HEADER_PREFIX, NO_FILES_AREA, REPO_GROUP, ROOT_AREA, SUBHEADER_PREFIX } from './lib/areas';
import { prettyLeaf, SUB_SEP } from './lib/subareas';
import { NO_SCOPE_LANE, OTHERS_LANE, type Commit, type Lane, type Session } from './lib/types';
import { Timeline } from './components/Timeline';
import { CommitCard } from './components/CommitCard';
import { MemoryCard } from './components/MemoryCard';
import { docMarks, MEMORY_LANE, memoryMarks, type ListedNote, type Mark } from './lib/marks';
import { LaneCard } from './components/LaneCard';
import { laneStats } from './lib/laneStats';
import { useI18n } from './i18n/useI18n';

type Phase =
  | { kind: 'idle' }
  | { kind: 'commits'; read: number; total: number | null; startedAt: number }
  | { kind: 'listing'; startedAt: number }
  | { kind: 'transcripts'; stats: ReadStats; startedAt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; code: string; reason: string };

interface Loaded {
  commits: Commit[];
  cut: boolean;
  /** Commits taken from the cache instead of git this time. */
  reusedCommits: number;
  sessions: Session[];
  stats: ReadStats | null;
  /** Agent memory notes listed beside the conversation folders. Null = no folder chosen. */
  memory: ListedNote[] | null;
  /** Ticked conversation folders that could not be listed: said, never dropped. */
  unlistable: number;
}

/** One conversation folder the person added, and what it holds once listed. */
interface Root {
  path: string;
  groups: ProjectGroup[] | null;
  error: string | null;
}

/** A tick is a group INSIDE a root: two roots can hold projects with the same name. */
const tickKey = (root: string, group: string) => `${root}\u0001${group}`;

/** Per-viewer conveniences (which folders, which ticks). Never state that must survive. */
function remember(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { console.warn('[Loom] could not remember a choice:', err); }
}
function recall<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch (err) { console.warn('[Loom] could not read a remembered choice:', err); return null; }
}

/** The folders remembered for a repository, including the single one of version 0.1. */
function recallRoots(repoId: string): string[] {
  const list = recall<string[]>(`loom:convRoots:${repoId}`);
  if (Array.isArray(list)) return list.filter((p) => typeof p === 'string');
  const single = recall<string>(`loom:convRoot:${repoId}`);
  return typeof single === 'string' ? [single] : [];
}

/** Indices into the full mark list of the marks the timeline was given (those with a row). */
function markIndexMap(rows: ReadonlyArray<{ row: number }>): number[] {
  const out: number[] = [];
  rows.forEach((m, i) => { if (m.row >= 0) out.push(i); });
  return out;
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(0);
const secs = (ms: number) => (ms / 1000).toFixed(1);

export default function App(): JSX.Element {
  const { t, lang } = useI18n();
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roots, setRoots] = useState<Root[]>([]);
  /**
   * The repository `roots` were loaded for. 🪤 The automatic reading at opening
   * once ran in the same flush as the effect that loads the roots, saw the
   * initial EMPTY list as "everything listed", and read the history with no
   * conversation at all: every point hollow, no time anywhere. It now waits
   * until the roots in state are this repository's.
   */
  const [rootsRepo, setRootsRepo] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  /** Lines by app (folders) or by commit scope. Null = not chosen: by app when the repository has apps. */
  const [laneMode, setLaneMode] = useState<'areas' | 'scopes' | null>(() => recall<'areas' | 'scopes'>('loom:laneMode'));
  const [selected, setSelected] = useState<number | null>(null);
  /** Apps split into sub-lines. Null = never chosen: the busiest apps are split (areas.autoSplit). */
  const [splitChoice, setSplitChoice] = useState<string[] | null>(() => recall<string[]>('loom:split'));
  /** Milestones shown on the timeline (remembered per viewer). */
  const [showMarks, setShowMarks] = useState<boolean>(() => recall<boolean>('loom:marks') !== false);
  /** The memory note whose card is open, by index into model.marks. */
  const [selectedMark, setSelectedMark] = useState<number | null>(null);
  /** The app (line) whose card is open, by key: line indices change when the mode does. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [, setTick] = useState(0);
  /** The automatic reading at opening runs once per repository, never in a loop. */
  const autoReadFor = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Folders whose listing is in flight: another folder answering must not start them again. */
  const listing = useRef(new Set<string>());

  const repo = repos?.find((r) => r.id === repoId) ?? null;

  /** A refusal as a sentence: a known code gets its own, anything else is shown as it came. */
  const errorLine = useCallback((code: string, reason?: string) => {
    if (/^[A-Z_]+$/.test(code) && code !== 'generic') {
      const key = `error.${code}`;
      const s = t(key);
      if (s !== key) return s;
    }
    return t('error.generic', { reason: reason ?? code });
  }, [t]);

  // The repositories this cartridge was given (three states: loading, error, list).
  const refreshRepos = useCallback(async () => {
    try {
      const list = await listRepos();
      setRepos(list);
      setReposError(null);
      setRepoId((cur) => (cur && list.some((r) => r.id === cur) ? cur : list.find((r) => !r.missing)?.id ?? list[0]?.id ?? null));
    } catch (err) {
      console.error('[Loom] could not list repositories:', err);
      setReposError(errorCodeOf(err));
    }
  }, []);

  useEffect(() => { if (hasHost()) void refreshRepos(); }, [refreshRepos]);

  // A new repository starts from its own remembered folders and ticks. No
  // repository left (the only one was forgotten): nothing of it stays drawn.
  useEffect(() => {
    if (!repoId) {
      setRoots([]);
      setRootsRepo(null);
      setLoaded(null);
      setSelected(null);
      setFocusKey(null);
      setSourcesOpen(true);
      return;
    }
    setRoots(recallRoots(repoId).map((path) => ({ path, groups: null, error: null })));
    setRootsRepo(repoId);
    const stored = recall<string[]>(`loom:ticks:${repoId}`);
    setTicked(new Set(Array.isArray(stored) ? stored : []));
    setLoaded(null);
    setSelected(null);
    setSourcesOpen(true);
  }, [repoId]);

  // List every root that has not been listed yet (no transcript is read here).
  const repoName = repo?.name ?? null;
  useEffect(() => {
    if (!repoName || !repoId) return;
    const pending = roots.filter((r) => r.groups === null && r.error === null && !listing.current.has(r.path));
    if (!pending.length) return;
    let alive = true;
    for (const r of pending) {
      listing.current.add(r.path);
      listFolders(invoke, r.path)
        .finally(() => listing.current.delete(r.path))
        .then((listing) => {
          if (!alive) return;
          const groups = groupsOfRoot(r.path, listing);
          setRoots((cur) => cur.map((x) => (x.path === r.path ? { ...x, groups } : x)));
          // A root seen for the first time gets the groups that look like the
          // repository ticked; a root the person already ticked keeps their choice.
          const stored = recall<string[]>(`loom:ticks:${repoId}`);
          const touched = Array.isArray(stored) && stored.some((k) => k.startsWith(`${r.path}\u0001`));
          if (!touched) {
            const guess = listing.hasTranscripts ? groups.map((g) => g.key) : matchingGroups(groups, repoName);
            setTicked((cur) => {
              const next = new Set(cur);
              guess.forEach((g) => next.add(tickKey(r.path, g)));
              remember(`loom:ticks:${repoId}`, [...next]);
              return next;
            });
          }
        })
        .catch((err: unknown) => {
          console.error('[Loom] could not list a conversations folder:', err);
          if (alive) setRoots((cur) => cur.map((x) => (x.path === r.path ? { ...x, error: errorCodeOf(err) } : x)));
        });
    }
    return () => { alive = false; };
  }, [roots, repoName, repoId]);

  // A clock for the elapsed time while a pass runs (rule 13: stopped with it).
  const running = phase.kind === 'commits' || phase.kind === 'listing' || phase.kind === 'transcripts';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [running]);

  const pickRepo = async () => {
    setActionError(null);
    try {
      const r = await declareRepo();
      await refreshRepos();
      setRepoId(r.id);
    } catch (err) {
      const code = errorCodeOf(err);
      if (code !== 'CANCELED') setActionError(code);
    }
  };

  const saveRoots = (list: Root[]) => {
    if (repoId) remember(`loom:convRoots:${repoId}`, list.map((r) => r.path));
  };

  const addRoot = async () => {
    setActionError(null);
    try {
      const hint = CONNECTORS['claude-code'].folderHint;
      const chosen = await sdk.selectFolder(hint ? { startIn: hint } : undefined);
      if (!chosen || roots.some((r) => r.path === chosen)) return;
      const next = [...roots, { path: chosen, groups: null, error: null }];
      setRoots(next);
      saveRoots(next);
    } catch (err) {
      console.error('[Loom] folder choice failed:', err);
      setActionError(errorCodeOf(err));
    }
  };

  const removeRoot = (path: string) => {
    const next = roots.filter((r) => r.path !== path);
    setRoots(next);
    saveRoots(next);
    setTicked((cur) => {
      const kept = new Set([...cur].filter((k) => !k.startsWith(`${path}\u0001`)));
      if (repoId) remember(`loom:ticks:${repoId}`, [...kept]);
      return kept;
    });
  };

  const toggle = (key: string) => {
    setTicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (repoId) remember(`loom:ticks:${repoId}`, [...next]);
      return next;
    });
  };

  const read = async () => {
    if (!repo) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setActionError(null);
    setSelected(null);
    const startedAt = Date.now();
    try {
      setPhase({ kind: 'commits', read: 0, total: null, startedAt });
      const history = await loadHistory(repo.id);
      const { commits, cut, total, reused } = await loadCommits(invoke, repo.id,
        (n, total) => setPhase({ kind: 'commits', read: n, total, startedAt }), ctrl.signal, history);
      if (!cut) void saveHistory(repo.id, { commits, total });

      let sessions: Session[] = [];
      let stats: ReadStats | null = null;
      let memory: ListedNote[] | null = null;
      let unlistable = 0;
      const chosen = roots.map((r) => ({
        root: r.path,
        folders: (r.groups ?? []).filter((g) => ticked.has(tickKey(r.path, g.key))).flatMap((g) => g.folders),
      })).filter((x) => x.folders.length);
      if (chosen.length) {
        setPhase({ kind: 'listing', startedAt });
        const files: TranscriptFile[] = [];
        for (const c of chosen) {
          const listed = await listTranscripts(invoke, c.root, c.folders, ctrl.signal);
          files.push(...listed.files);
          unlistable += listed.unlistable;
        }
        const fileCache = await loadFileCache(repo.name);
        const res = await readTranscripts(invoke, files, repo.name,
          (s) => setPhase({ kind: 'transcripts', stats: s, startedAt }), ctrl.signal, undefined, fileCache);
        sessions = res.sessions;
        stats = res.stats;
        await saveFileCache(repo.name, fileCache, res.seen);
        memory = [];
        for (const c of chosen) memory.push(...(await listMemoryNotes(invoke, c.root, c.folders, ctrl.signal)));
        console.log(`[Loom] ${stats.read} transcripts read (${mb(stats.bytes)} MB), ${stats.cached} from the cache, in ${secs(stats.elapsedMs)} s`);
      }
      setLoaded({ commits, cut, reusedCommits: reused, sessions, stats, memory, unlistable });
      setPhase({ kind: 'idle' });
      setSourcesOpen(false);
      // A complete reading happened: from now on, opening Loom reads again on
      // its own (through the cache, so only what changed is actually read).
      remember(`loom:readOnce:${repo.id}`, true);
      setFitToken((n) => n + 1);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') { setPhase({ kind: 'stopped' }); return; }
      console.error('[Loom] reading failed:', err);
      setPhase({ kind: 'failed', code: errorCodeOf(err), reason: err instanceof Error ? err.message : String(err) });
    }
  };

  // Stop a pass that is still running when the window goes away.
  useEffect(() => () => abort.current?.abort(), []);

  // At opening: if a complete reading already happened for this repository,
  // read again on its own once every folder is listed. The person pressed
  // "Read" once for these folders; this is the same reading, served mostly
  // from the cache. Never before a first press.
  useEffect(() => {
    if (!repo || repo.missing || loaded || phase.kind !== 'idle') return;
    if (autoReadFor.current === repo.id) return;
    if (recall<boolean>(`loom:readOnce:${repo.id}`) !== true) return;
    if (rootsRepo !== repo.id) return;
    if (roots.some((r) => r.groups === null && r.error === null)) return;
    autoReadFor.current = repo.id;
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, roots, rootsRepo, loaded, phase.kind]);

  const model = useMemo(() => {
    if (!loaded) return null;
    const index = linkCommits(loaded.commits, loaded.sessions);
    const containers = detectContainers(loaded.commits);
    const mode = laneMode ?? (containers.size > 0 ? 'areas' : 'scopes');
    const split = splitChoice ? new Set(splitChoice) : autoSplit(loaded.commits, containers);
    const lanes = mode === 'areas' ? buildAreaLanes(loaded.commits, containers, split) : buildLanes(loaded.commits, DEFAULT_LANES, expanded);
    // Milestones (doc 140 §19): a doc on the line of the commit that brought it,
    // memory notes on a line of their own after every other.
    const docs = docMarks(loaded.commits);
    const mem = memoryMarks(loaded.memory ?? []);
    // The memory line only exists while milestones are shown: hidden, it would
    // be an empty line counted "0" at the bottom of the board.
    if (showMarks && mem.marks.length) lanes.push({ key: MEMORY_LANE, commits: [] });
    const rowOfCommit = new Map<number, number>();
    lanes.forEach((l, row) => l.commits.forEach((ci) => rowOfCommit.set(ci, row)));
    const marks: Mark[] = [...docs, ...mem.marks];
    const markRows = marks.map((m) => ({
      row: m.kind === 'doc' ? rowOfCommit.get(m.commit) ?? -1 : lanes.length - 1,
      at: m.at,
      kind: m.kind,
    }));
    const byId = new Map(loaded.sessions.map((s) => [s.id, s]));
    const convFrom = loaded.sessions.length ? Math.min(...loaded.sessions.map((s) => s.start)) : null;
    const since = convFrom === null ? [] : loaded.commits.flatMap((c, i) => (c.at >= convFrom ? [i] : []));
    return {
      links: index.byCommit, lanes, byId, convFrom, mode, split, marks, markRows, memoryUndated: mem.undated,
      activeTotal: tiedActiveMs(index.byCommit, byId),
      coverage: coverageOf(index.byCommit, since),
      folded: foldedScopes(loaded.commits, lanes),
    };
  }, [loaded, expanded, laneMode, splitChoice, showMarks]);

  const laneLabel = useCallback((lane: Lane) => {
    if (lane.key === OTHERS_LANE) return t('lanes.others', { count: model?.folded ?? 0 });
    if (lane.key === NO_SCOPE_LANE) return t('lanes.none');
    if (lane.key === ROOT_AREA) return t('lanes.root');
    if (lane.key === NO_FILES_AREA) return t('lanes.noFiles');
    if (lane.key === MEMORY_LANE) return t('lanes.memory');
    if (lane.key.startsWith(SUBHEADER_PREFIX)) {
      const area = lane.key.slice(SUBHEADER_PREFIX.length);
      return area.slice(area.indexOf('/') + 1);
    }
    if (lane.key.includes(SUB_SEP)) {
      const { name, ownFiles, rest } = prettyLeaf(lane.key.slice(lane.key.indexOf(SUB_SEP) + SUB_SEP.length));
      if (rest) return name ? t('lanes.restOf', { folder: name }) : t('lanes.rest');
      if (ownFiles) return name ? t('lanes.ownFiles', { folder: name }) : t('lanes.appRoot');
      return name || t('lanes.appRoot');
    }
    if (lane.key.startsWith(HEADER_PREFIX)) {
      const g = lane.key.slice(HEADER_PREFIX.length);
      return g === REPO_GROUP ? t('lanes.repoGroup') : g;
    }
    // An app line shows the app's name; its container is the header above it.
    return lane.key.includes('/') ? lane.key.slice(lane.key.indexOf('/') + 1) : lane.key;
  }, [t, model?.folded]);

  const focusRow = model && focusKey !== null ? model.lanes.findIndex((l) => l.key === focusKey) : -1;
  const focus = useMemo(() => {
    if (!model || !loaded || focusRow < 0) return null;
    const lane = model.lanes[focusRow]!;
    return { row: focusRow, lane, stats: laneStats(lane, loaded.commits, model.links, model.byId) };
  }, [model, loaded, focusRow]);

  if (!hasHost()) return <main className="loom"><div className="glass empty-card"><p>{t('app.noHost')}</p></div></main>;

  const elapsedMs = running ? Date.now() - (phase as { startedAt: number }).startedAt : 0;
  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

  const progress = (() => {
    if (phase.kind === 'commits') {
      return {
        line: phase.total !== null ? t('scan.commits', { read: phase.read, total: phase.total }) : t('scan.commitsNoTotal', { read: phase.read }),
        value: phase.total ? phase.read / phase.total : null,
      };
    }
    if (phase.kind === 'listing') return { line: t('scan.listing'), value: null };
    if (phase.kind === 'transcripts') {
      const s = phase.stats;
      const rate = s.elapsedMs > 0 ? (s.bytes / 1_048_576) / (s.elapsedMs / 1000) : null;
      return {
        line: t('scan.transcripts', { read: s.read, files: s.files, mb: mb(s.bytes) })
          + (rate !== null ? ` · ${t('scan.rate', { rate: rate.toFixed(0) })}` : ''),
        value: s.files ? (s.read + s.refused + s.tooLarge + s.cached) / s.files : null,
      };
    }
    return null;
  })();

  return (
    <main className="loom">
      <div className="aurora" aria-hidden="true" />

      <header className="glass bar">
        <div className="brand">
          <h1>{t('app.title')}</h1>
          <span className="sub">{repo ? repo.name : t('app.subtitle')}</span>
        </div>

        {loaded && model ? (
          <div className="chips">
            <span className="chip">{t('stats.commits', { count: loaded.commits.length })}</span>
            {loaded.stats && <span className="chip">{t('stats.sessions', { count: loaded.sessions.length })}</span>}
            {model.activeTotal !== null && (
              <span className="chip" title={t('stats.activeHelp')}>{t('stats.active', { time: formatDuration(model.activeTotal, lang) })}</span>
            )}
            {loaded.stats && model.coverage.commits > 0 && (
              <>
                <span className="chip k-recorded">{t('stats.linkRecorded', { pct: pct(model.coverage.recorded, model.coverage.commits) })}</span>
                <span className="chip k-inferred">{t('stats.linkInferred', { pct: pct(model.coverage.inferredOnly, model.coverage.commits) })}</span>
                <span className="chip k-none">{t('stats.linkNone', { pct: pct(model.coverage.none, model.coverage.commits) })}</span>
              </>
            )}
          </div>
        ) : <div />}

        <div className="actions">
          {loaded && (
            <button type="button" className="pill" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((o) => !o)}>
              {sourcesOpen ? t('setup.hide') : t('setup.sources')}
            </button>
          )}
          {repo && !running && (
            <button type="button" className="pill primary" onClick={read} disabled={repo.missing}>{t('setup.read')}</button>
          )}
          {running && <button type="button" className="pill" onClick={() => abort.current?.abort()}>{t('scan.stop')}</button>}
        </div>

        {progress && (
          <div className="progress" role="status">
            <div className="track">
              <div className={progress.value === null ? 'fill sweep' : 'fill'} style={progress.value === null ? undefined : { width: `${Math.round(progress.value * 100)}%` }} />
            </div>
            <span>{progress.line} · {t('scan.elapsed', { s: secs(elapsedMs) })}</span>
          </div>
        )}
      </header>

      {(phase.kind === 'stopped' || phase.kind === 'failed' || actionError) && (
        <div className="glass notice">
          {phase.kind === 'stopped' && <p className="help">{t('scan.stopped')}</p>}
          {phase.kind === 'failed' && <p className="error-line">{errorLine(phase.code, phase.reason)}</p>}
          {actionError && <p className="error-line">{errorLine(actionError)}</p>}
        </div>
      )}

      {(sourcesOpen || !loaded) && (
        <section className="sources">
          <div className="glass panel">
            <h2>{t('setup.repoTitle')}</h2>
            <p className="help">{t('setup.repoHelp')}</p>
            {reposError && <p className="error-line">{errorLine(reposError)}</p>}
            {repos === null && !reposError && <p className="help">…</p>}
            {repos && repos.length > 1 && (
              <select value={repoId ?? ''} onChange={(e) => setRepoId(e.target.value)} disabled={running}>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
            {repo && (
              <p className="repo-name">
                <strong>{repo.name}</strong>
                {repo.missing && <span className="error-line"> {t('setup.repoMissing')}</span>}
              </p>
            )}
            <div className="row">
              <button type="button" className="pill" onClick={pickRepo} disabled={running}>{repo ? t('setup.repoChange') : t('setup.repoPick')}</button>
              {repo && (
                <button type="button" className="pill ghost" disabled={running} onClick={async () => {
                  try { await forgetRepo(repo.id); await refreshRepos(); } catch (err) { setActionError(errorCodeOf(err)); }
                }}>{t('setup.forget')}</button>
              )}
            </div>
          </div>

          {repo && (
            <div className="glass panel">
              <div className="panel-head">
                <h2>{t('setup.convTitle')}</h2>
                <span className="help">{t('setup.tickedTotal', { count: ticked.size })}</span>
              </div>
              <p className="help">{t('setup.convHelp')}</p>

              {roots.length === 0 && <p className="help">{t('setup.skipConv')}</p>}
              <div className="roots">
                {roots.map((r) => {
                  const fits = r.groups ? new Set(matchingGroups(r.groups, repo.name)) : new Set<string>();
                  return (
                    <div key={r.path} className="root">
                      <div className="root-head">
                        <code title={r.path}>{r.path}</code>
                        <button type="button" className="pill ghost small" disabled={running} onClick={() => removeRoot(r.path)}>{t('setup.removeFolder')}</button>
                      </div>
                      {r.error && <p className="error-line">{errorLine(r.error)}</p>}
                      {r.groups === null && !r.error && <p className="help">…</p>}
                      {r.groups && r.groups.length === 0 && <p className="help">{t('setup.folderEmpty')}</p>}
                      {r.groups && r.groups.length > 0 && (
                        <ul className="groups">
                          {[...r.groups]
                            .sort((a, b) => Number(ticked.has(tickKey(r.path, b.key))) - Number(ticked.has(tickKey(r.path, a.key))) || a.key.localeCompare(b.key))
                            .map((g) => (
                              <li key={g.key} className={fits.has(g.key) ? 'fits' : undefined}>
                                <label>
                                  <input type="checkbox" checked={ticked.has(tickKey(r.path, g.key))} onChange={() => toggle(tickKey(r.path, g.key))} disabled={running} />
                                  <code>{g.key}</code>
                                  {g.folders.length > 1 && <span className="help">{t('setup.worktrees', { count: g.folders.length - 1 })}</span>}
                                </label>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
              <button type="button" className="pill add" onClick={addRoot} disabled={running}>{t('setup.addFolder')}</button>
            </div>
          )}
        </section>
      )}

      {loaded && model && (
        <section className="glass board">
          <div className="board-bar">
            <button type="button" className="pill" onClick={() => { setFocusKey(null); setFitToken((n) => n + 1); }}>{t('view.fit')}</button>
            <div className="segmented" role="group" aria-label={t('lanes.modeLabel')}>
              {(['areas', 'scopes'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={model.mode === m} onClick={() => { setLaneMode(m); remember('loom:laneMode', m); }}>
                  {t(m === 'areas' ? 'lanes.byArea' : 'lanes.byScope')}
                </button>
              ))}
            </div>
            {model.mode === 'scopes' && (
              <button type="button" className="pill" aria-pressed={expanded} onClick={() => setExpanded((e) => !e)}>
                {expanded ? t('lanes.collapse', { count: DEFAULT_LANES }) : t('lanes.expand')}
              </button>
            )}
            <button type="button" className="pill" aria-pressed={showMarks} onClick={() => { setShowMarks((v) => { remember('loom:marks', !v); return !v; }); }}>
              {t('marks.toggle')}
            </button>
            <span className="legend">
              <i className="dot feat" />{t('types.feat')}
              <i className="dot fix" />{t('types.fix')}
              <i className="dot docs" />{t('types.docs')}
              <i className="dot other" />{t('types.other')}
              {showMarks && <><i className="diamond doc" />{t('marks.doc')} <i className="diamond memory" />{t('marks.memory')}</>}
            </span>
            <span className="help hint">{t('view.hint')}</span>
          </div>
          {loaded.stats && (
            <p className="help read-stats">
              {t('stats.readTime', { files: loaded.stats.read, mb: mb(loaded.stats.bytes), s: secs(loaded.stats.elapsedMs) })}
              {loaded.stats.cached > 0 && <> · {t('stats.cached', { count: loaded.stats.cached })}</>}
              {loaded.reusedCommits > 0 && <> · {t('stats.historyReused', { count: loaded.reusedCommits })}</>}
              {loaded.stats.tooLarge > 0 && <> · {t('stats.tooLarge', { count: loaded.stats.tooLarge })}</>}
              {loaded.stats.refused > 0 && <> · {t('stats.refused', { count: loaded.stats.refused })}</>}
              {loaded.stats.undated > 0 && <> · {t('stats.undated', { count: loaded.stats.undated })}</>}
              {loaded.unlistable > 0 && <> · {t('stats.unlistable', { count: loaded.unlistable })}</>}
              {loaded.stats.firstError && (loaded.stats.refused > 0 || loaded.stats.tooLarge > 0) && <> · {t('stats.firstError', { reason: loaded.stats.firstError })}</>}
              {model.convFrom !== null && <> · {t('stats.noConvBefore', { date: new Date(model.convFrom).toLocaleDateString() })}</>}
            </p>
          )}
          {loaded.cut && <p className="error-line">{t('stats.cut', { count: loaded.commits.length })}</p>}
          <div className="board-body">
            <Timeline
              commits={loaded.commits}
              lanes={model.lanes}
              laneLabel={laneLabel}
              links={model.links}
              sessions={model.byId}
              convFrom={model.convFrom}
              selected={selected}
              onSelect={setSelected}
              fitToken={fitToken}
              onSelectLane={(row) => {
                setSelectedMark(null);
                const key = model.lanes[row]?.key ?? null;
                setSelected(null);
                setFocusKey((cur) => (cur === key ? null : key));
              }}
              focusRow={focus ? focus.row : null}
              marks={showMarks ? model.markRows.filter((m) => m.row >= 0) : []}
              markLabel={(i) => {
                const m = model.marks[(showMarks ? markIndexMap(model.markRows) : [])[i] ?? -1];
                if (!m) return '';
                return m.kind === 'doc'
                  ? t('marks.docLabel', { number: m.number, title: m.title })
                  : t('marks.memoryLabel', { name: m.name, date: new Date(m.at).toLocaleDateString(lang) });
              }}
              onSelectMark={(i) => {
                const mi = markIndexMap(model.markRows)[i] ?? -1;
                const m = model.marks[mi];
                if (!m) return;
                setFocusKey(null);
                if (m.kind === 'doc') { setSelectedMark(null); setSelected(m.commit); }
                else { setSelected(null); setSelectedMark(mi); }
              }}
              fitTo={focus && focus.stats.first !== null && focus.stats.last !== null ? { from: focus.stats.first, to: focus.stats.last } : null}
            />
            {selected === null && selectedMark !== null && model.marks[selectedMark]?.kind === 'memory' && (
              <MemoryCard
                mark={model.marks[selectedMark]}
                onClose={() => setSelectedMark(null)}
              />
            )}
            {selected === null && selectedMark === null && focus && (
              <LaneCard
                name={laneLabel(focus.lane)}
                stats={focus.stats}
                digest={{
                  cacheKey: `${repo?.id ?? ''}|${focus.lane.key}`,
                  commits: focus.lane.commits.map((i) => loaded.commits[i]).filter((c): c is Commit => !!c),
                }}
                onClose={() => setFocusKey(null)}
                split={(() => {
                  const area = model.mode === 'areas' ? areaOfLane(focus.lane) : null;
                  if (!area || !area.includes('/')) return null;
                  const on = model.split.has(area);
                  return {
                    on,
                    app: area.slice(area.indexOf('/') + 1),
                    toggle: () => {
                      const next = new Set(model.split);
                      if (on) next.delete(area); else next.add(area);
                      setSplitChoice([...next]);
                      remember('loom:split', [...next]);
                      // The card follows the app: its header when split, its line when not.
                      setFocusKey(on ? area : `${SUBHEADER_PREFIX}${area}`);
                    },
                  };
                })()}
              />
            )}
            {selected !== null && loaded.commits[selected] && model.links[selected] && (
              <CommitCard
                commit={loaded.commits[selected]}
                links={model.links[selected]}
                sessions={model.byId}
                docs={model.marks.filter((m): m is Extract<Mark, { kind: 'doc' }> => m.kind === 'doc' && m.commit === selected)}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </section>
      )}
    </main>
  );
}
