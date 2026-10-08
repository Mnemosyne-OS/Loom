/** Lanes, conversation folders and the camera: the pure parts of the screen. */
import { describe, it, expect } from 'vitest';
import { buildLanes, familyOf, foldedScopes, laneKeyOf } from './lanes';
import { encodeSegment, groupFolders, groupsOfRoot, matchingGroups, projectOf } from './projects';
import { fit, MAX_MS_PER_PX, MIN_MS_PER_PX, panBy, ticks, tOf, xOf, zoomAt } from './view';
import { NO_SCOPE_LANE, OTHERS_LANE, type Commit } from './types';

const c = (scope: string | null, at = 0, type: string | null = 'feat'): Commit => ({
  sha: 'x'.repeat(40), at, author: '', parents: 1, subject: '', type, scope, files: [],
});

describe('lanes', () => {
  it('ranks busiest first, folds the rest into one line', () => {
    const commits = [c('a'), c('a'), c('a'), c('b'), c('b'), c('c'), c('d')];
    const lanes = buildLanes(commits, 2);
    expect(lanes.map((l) => l.key)).toEqual(['a', 'b', OTHERS_LANE]);
    expect(lanes[2]?.commits).toEqual([5, 6]);
    expect(foldedScopes(commits, lanes)).toBe(2);
  });

  it('does not fold a single leftover scope into "others"', () => {
    expect(buildLanes([c('a'), c('a'), c('b')], 1).map((l) => l.key)).toEqual(['a', 'b']);
  });

  it('breaks ties by name, so the order never depends on arrival order', () => {
    const one = buildLanes([c('b'), c('a')], 5).map((l) => l.key);
    const two = buildLanes([c('a'), c('b')], 5).map((l) => l.key);
    expect(one).toEqual(['a', 'b']);
    expect(two).toEqual(one);
  });

  it('expanded puts every scope on its own line', () => {
    expect(buildLanes([c('a'), c('b'), c('c')], 1, true)).toHaveLength(3);
  });

  it('puts scopeless and non-conventional commits on one "no scope" line', () => {
    expect(laneKeyOf(c(''))).toBe(NO_SCOPE_LANE);
    expect(laneKeyOf(c(null, 0, null))).toBe(NO_SCOPE_LANE);
  });

  it('maps types to four colour families', () => {
    expect([familyOf('feat'), familyOf('fix'), familyOf('hotfix'), familyOf('docs'), familyOf('chore'), familyOf(null)])
      .toEqual(['feat', 'fix', 'fix', 'docs', 'other', 'other']);
  });
});

describe('conversation folders', () => {
  const names = [
    'C--Users-me-Documents-TRAVAIL--MNEMOSYNE-OS',
    'C--Users-me-Documents-TRAVAIL--MNEMOSYNE-OS--claude-worktrees-happy-ellis-9c1efa',
    'C--Users-me-Documents-TRAVAIL--MNEMOSYNE-OS--claude-worktrees-keen-pike-eac758',
    'C--Users-me-Documents-other',
    'C--Users-me-Documents-XMNEMOSYNE-OS',
  ];

  it('encodes a folder name the way Claude Code does', () => {
    expect(encodeSegment('_MNEMOSYNE OS')).toBe('-MNEMOSYNE-OS');
  });

  it('groups each worktree folder with its project', () => {
    expect(projectOf(names[1]!)).toBe(names[0]);
    const g = groupFolders(names);
    expect(g.find((x) => x.key === names[0])?.folders).toHaveLength(3);
    expect(g).toHaveLength(3);
  });

  it('takes a folder that holds transcripts directly as ONE project, read from its root', () => {
    expect(groupsOfRoot('D:\\backup\\my-proj\\', { folders: ['abc'], hasTranscripts: true })).toEqual([{ key: 'my-proj', folders: [''] }]);
    expect(groupsOfRoot('C:/x/projects', { folders: names, hasTranscripts: false })).toHaveLength(3);
  });

  it('preselects the project whose name ends with the repository folder, on a segment boundary', () => {
    expect(matchingGroups(groupFolders(names), '_MNEMOSYNE OS')).toEqual([names[0]]);
    expect(matchingGroups(groupFolders(names), 'other')).toEqual(['C--Users-me-Documents-other']);
    expect(matchingGroups(groupFolders(names), 'nothing-here')).toEqual([]);
    // M37: 'mnemosyne-os' must not match 'xmnemosyne-os' (no segment boundary).
    expect(matchingGroups(groupFolders(['C--x-xmnemosyne-os', 'C--x-mnemosyne-os']), 'mnemosyne-os')).toEqual(['C--x-mnemosyne-os']);
  });
});

describe('view', () => {
  it('keeps the instant under the pointer in place when zooming', () => {
    const v = { t0: 1_000_000, msPerPx: 600_000 };
    const before = tOf(v, 300);
    const z = zoomAt(v, 300, 2);
    expect(tOf(z, 300)).toBeCloseTo(before, 3);
    expect(z.msPerPx).toBe(300_000);
  });

  it('clamps the zoom at both ends', () => {
    expect(zoomAt({ t0: 0, msPerPx: MIN_MS_PER_PX }, 0, 100).msPerPx).toBe(MIN_MS_PER_PX);
    expect(zoomAt({ t0: 0, msPerPx: MAX_MS_PER_PX }, 0, 0.001).msPerPx).toBe(MAX_MS_PER_PX);
  });

  it('fits the whole range inside the width', () => {
    const v = fit(0, 100 * 3_600_000, 1000);
    expect(xOf(v, 0)).toBeGreaterThan(0);
    expect(xOf(v, 100 * 3_600_000)).toBeLessThan(1000);
  });

  it('pans the content with the pointer', () => {
    const v = panBy({ t0: 0, msPerPx: 10 }, 50);
    expect(xOf(v, 0)).toBe(50);
  });

  it('places ticks on local midnights, at least 80 px apart', () => {
    const start = new Date(2026, 8, 1, 13).getTime();
    const v = { t0: start, msPerPx: 3_600_000 / 4 };
    const tk = ticks(v, 2000);
    expect(tk.length).toBeGreaterThan(1);
    for (const x of tk) {
      const d = new Date(x.t);
      expect(d.getHours()).toBe(0);
    }
    for (let i = 1; i < tk.length; i++) expect(xOf(v, tk[i]!.t) - xOf(v, tk[i - 1]!.t)).toBeGreaterThanOrEqual(80);
  });
});

describe('buildLaneData', () => {
  it('orders a line by time and draws each tied conversation once', async () => {
    const { buildLaneData } = await import('./laneData');
    const commits = [c('a', 30), c('a', 10), c('a', 20)];
    const lanes = [{ key: 'a', commits: [0, 1, 2] }];
    const links = [{ recorded: ['s'], inferred: [] }, { recorded: [], inferred: ['s'] }, { recorded: [], inferred: [] }];
    const sessions = new Map([['s', { id: 's', transcript: '', title: null, start: 5, end: 35, active: [5, 35], toolFiles: [], shellFiles: [], shas: [], commitSubjects: [] }]]);
    const [d] = buildLaneData(commits, lanes, links, sessions);
    expect([...d!.times]).toEqual([10, 20, 30]);
    expect([...d!.idx]).toEqual([1, 2, 0]);
    expect([...d!.tied]).toEqual([1, 0, 1]);
    expect([...d!.bars]).toEqual([5, 35]);
  });
});

describe('lines by app', () => {
  const at = (files: string[], i = 0): Commit => ({ ...c(null, i), files });

  it('finds the container folders of a monorepo from the paths alone', async () => {
    const { detectContainers } = await import('./areas');
    const commits = [
      at(['apps/a/x.ts']), at(['packages/p/y.ts']), at(['docs/arch/1.md', 'docs/rel/2.md']), at(['README.md']),
    ];
    expect([...detectContainers(commits)].sort()).toEqual(['apps', 'packages']);
    const many = Array.from({ length: 8 }, (_, i) => at([`stuff/s${i}/f.ts`]));
    expect(detectContainers(many).has('stuff')).toBe(true);
  });

  it('puts a commit on the area it touched most, ties by name, no files on its own line', async () => {
    const { primaryArea, NO_FILES_AREA, ROOT_AREA } = await import('./areas');
    const ct = new Set(['apps', 'packages']);
    expect(primaryArea(at(['apps/a/1', 'apps/a/2', 'packages/p/1']), ct)).toBe('apps/a');
    expect(primaryArea(at(['apps/b/1', 'apps/a/1']), ct)).toBe('apps/a');
    expect(primaryArea(at(['docs/x.md']), ct)).toBe('docs');
    expect(primaryArea(at(['CLAUDE.md']), ct)).toBe(ROOT_AREA);
    expect(primaryArea(at(['apps/readme.md']), ct)).toBe('apps');
    expect(primaryArea(at([]), ct)).toBe(NO_FILES_AREA);
  });

  it('draws a header per group, busiest group first, the rest of the repository after, root and merges last', async () => {
    const { buildAreaLanes, HEADER_PREFIX, REPO_GROUP, ROOT_AREA, NO_FILES_AREA } = await import('./areas');
    const ct = new Set(['apps', 'packages']);
    const commits = [
      at(['packages/p/1']), at(['apps/a/1']), at(['apps/a/2']), at(['apps/b/1']),
      at(['docs/x.md']), at(['CLAUDE.md']), at([]),
    ];
    const keys = buildAreaLanes(commits, ct).map((l) => l.key);
    expect(keys).toEqual([
      `${HEADER_PREFIX}apps`, 'apps/a', 'apps/b',
      `${HEADER_PREFIX}packages`, 'packages/p',
      `${HEADER_PREFIX}${REPO_GROUP}`, 'docs',
      ROOT_AREA, NO_FILES_AREA,
    ]);
    // Every commit is on exactly one line.
    const placed = buildAreaLanes(commits, ct).flatMap((l) => l.commits).sort();
    expect(placed).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('active time', () => {
  it('joins events closer than 15 min and splits on a longer silence', async () => {
    const { activeIntervals, IDLE_GAP_MS } = await import('./active');
    const m = 60_000;
    expect(activeIntervals([0, 5 * m, 10 * m])).toEqual([0, 10 * m]);
    expect(activeIntervals([0, 5 * m, 5 * m + IDLE_GAP_MS + 1])).toEqual([0, 5 * m, 5 * m + IDLE_GAP_MS + 1, 5 * m + IDLE_GAP_MS + 1]);
    expect(activeIntervals([10 * m, 0])).toEqual([0, 10 * m]);
    expect(activeIntervals([])).toEqual([]);
  });

  it('never counts the same minute twice across conversations', async () => {
    const { unionIntervals, totalMs } = await import('./active');
    expect(unionIntervals([[0, 10], [5, 20], [30, 40]])).toEqual([0, 20, 30, 40]);
    expect(totalMs(unionIntervals([[0, 10], [0, 10]]))).toBe(10);
  });

  it('says not measured as a dash, never zero', async () => {
    const { formatDuration } = await import('./active');
    expect(formatDuration(null, 'fr')).toBe('—');
    expect(formatDuration(25 * 60_000, 'fr')).toBe('25 min');
    expect(formatDuration(3.5 * 3_600_000, 'fr')).toBe('3,5 h');
    expect(formatDuration(412.4 * 3_600_000, 'en')).toBe('412 h');
  });

  it('a line and its group header carry the union of their conversations', async () => {
    const { buildLaneData } = await import('./laneData');
    const { HEADER_PREFIX } = await import('./areas');
    const commits = [c('a', 10), c('b', 20)];
    const lanes = [{ key: `${HEADER_PREFIX}apps`, commits: [] }, { key: 'apps/a', commits: [0] }, { key: 'apps/b', commits: [1] }];
    const links = [{ recorded: ['s1'], inferred: [] }, { recorded: ['s2'], inferred: [] }];
    const S = (id: string, active: number[]) => ({ id, transcript: '', title: null, start: active[0]!, end: active.at(-1)!, active, toolFiles: [], shellFiles: [], shas: [], commitSubjects: [] });
    const sessions = new Map([['s1', S('s1', [0, 100])], ['s2', S('s2', [50, 150])]]);
    const d = buildLaneData(commits, lanes, links, sessions);
    expect(d.map((x) => x.activeMs)).toEqual([150, 100, 100]);
    expect(buildLaneData(commits, lanes, links, new Map()).map((x) => x.activeMs)).toEqual([null, null, null]);
  });
});

describe('laneStats', () => {
  it('counts types, links, weeks, conversations and files of one line', async () => {
    const { laneStats } = await import('./laneStats');
    const W = 7 * 24 * 3_600_000;
    const commits = [
      { ...c('a', 0, 'feat'), files: ['x.ts', 'y.ts'] },
      { ...c('a', 1, 'fix'), files: ['x.ts'] },
      { ...c('a', 2 * W, 'docs'), files: [] },
    ];
    const links = [{ recorded: ['s1'], inferred: ['s2'] }, { recorded: [], inferred: ['s2'] }, { recorded: [], inferred: [] }];
    const S = (id: string, active: number[]) => ({ id, transcript: '', title: null, start: active[0]!, end: active.at(-1)!, active, toolFiles: [], shellFiles: [], shas: [], commitSubjects: [] });
    const sessions = new Map([['s1', S('s1', [0, 10])], ['s2', S('s2', [5, 40])]]);
    const st = laneStats({ key: 'a', commits: [0, 1, 2] }, commits, links, sessions);
    expect(st).toMatchObject({ commits: 3, first: 0, last: 2 * W, recorded: 1, inferredOnly: 1, none: 1, activeMs: 40 });
    expect(st.byFamily).toEqual({ feat: 1, fix: 1, docs: 1, other: 0 });
    expect(st.weeks).toEqual([2, 0, 1]);
    expect(st.conversations.map((x) => [x.session.id, x.commits, x.recorded])).toEqual([['s2', 2, false], ['s1', 1, true]]);
    expect(st.topFiles[0]).toEqual({ file: 'x.ts', commits: 2 });
  });

  it('says not measured when no conversation was read', async () => {
    const { laneStats } = await import('./laneStats');
    expect(laneStats({ key: 'a', commits: [0] }, [c('a', 5)], [{ recorded: [], inferred: [] }], new Map()).activeMs).toBeNull();
  });
});
