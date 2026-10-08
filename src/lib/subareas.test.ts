/** Sub-lines inside one app (doc 140 §17). */
import { describe, it, expect } from 'vitest';
import { buildTree, chooseLeaves, leafOf, prettyLeaf, primaryLeaf } from './subareas';
import { autoSplit, buildAreaLanes, isHeader, SUBHEADER_PREFIX } from './areas';
import type { Commit } from './types';

const times = (path: string, n: number) => Array.from({ length: n }, () => path);

describe('chooseLeaves', () => {
  it('keeps splitting the biggest folder, walking through single-child folders', () => {
    const paths = [
      ...times('src/renderer/src/components/widgets/chat/a.ts', 40),
      ...times('src/renderer/src/components/widgets/notes/b.ts', 30),
      ...times('src/renderer/src/i18n/fr.json', 20),
      ...times('src/main/ipc/x.ts', 10),
      ...times('package.json', 2),
    ];
    const leaves = chooseLeaves(buildTree(paths), 6, 0.06);
    // package.json (2 of 102 changes) is too small for a line of its own: it
    // shares the root's "rest" line.
    expect(leaves).toEqual([
      '*',
      'src/main/ipc',
      'src/renderer/src/components/widgets/chat',
      'src/renderer/src/components/widgets/notes',
      'src/renderer/src/i18n',
    ]);
  });

  it('stops at the cap: past it the smallest sub-folders share one "rest" line', () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((d, i) => times(`${d}/f.ts`, 10 + i));
    const leaves = chooseLeaves(buildTree(paths), 4);
    expect(leaves).toEqual(['*', 'd', 'e', 'f']);
    // Every file still lands on exactly one of them.
    for (const p of paths) expect(leaves).toContain(leafOf(p, leaves));
    expect(leafOf('a/f.ts', leaves)).toBe('*');
  });

  it('keeps a folder whole when none of its sub-folders is big enough', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}/f.ts`);
    expect(chooseLeaves(buildTree(paths))).toEqual(['']);
  });
});

describe('leafOf / primaryLeaf', () => {
  const leaves = ['.', 'src/main', 'src/renderer/widgets/chat', 'src/renderer/widgets'];
  it('puts a file in the deepest chosen folder holding it, root files on the root leaf', () => {
    expect(leafOf('src/renderer/widgets/chat/a.ts', leaves)).toBe('src/renderer/widgets/chat');
    expect(leafOf('src/renderer/widgets/todo/a.ts', leaves)).toBe('src/renderer/widgets');
    expect(leafOf('src/main/ipc/x.ts', leaves)).toBe('src/main');
    expect(leafOf('package.json', leaves)).toBe('.');
  });
  it('lets a rest line take only what no sibling took', () => {
    const l2 = ['src/a', 'src/*', 'src/.'];
    expect(leafOf('src/a/x.ts', l2)).toBe('src/a');
    expect(leafOf('src/b/x.ts', l2)).toBe('src/*');
    expect(leafOf('src/x.ts', l2)).toBe('src/.');
  });

  it('gives a commit the sub-line it touched most, ties by name', () => {
    expect(primaryLeaf(['src/main/a', 'src/main/b', 'package.json'], leaves)).toBe('src/main');
    expect(primaryLeaf(['src/main/a', 'package.json'], leaves)).toBe('.');
  });
});

describe('prettyLeaf', () => {
  it('drops the wrapper folders from the name', () => {
    expect(prettyLeaf('src/renderer/src/components/widgets/chat')).toEqual({ name: 'renderer › widgets › chat', ownFiles: false, rest: false });
    expect(prettyLeaf('src/main/.')).toEqual({ name: 'main', ownFiles: true, rest: false });
    expect(prettyLeaf('.')).toEqual({ name: '', ownFiles: true, rest: false });
    expect(prettyLeaf('src/renderer/*')).toEqual({ name: 'renderer', ownFiles: false, rest: true });
  });
});

describe('split apps in the lines', () => {
  const c = (files: string[]): Commit => ({ sha: 'x'.repeat(40), at: 0, author: '', parents: 1, subject: '', type: null, scope: null, files });
  const commits = [
    ...Array.from({ length: 6 }, () => c(['apps/big/src/main/a.ts'])),
    ...Array.from({ length: 4 }, () => c(['apps/big/src/renderer/b.ts'])),
    c(['apps/small/x.ts']),
  ];
  const ct = new Set(['apps']);

  it('splits an app holding more than a quarter of the commits by default', () => {
    expect([...autoSplit(commits, ct)]).toEqual(['apps/big']);
  });

  it('draws the app header, then its sub-lines; every commit on exactly one drawn line', () => {
    const lanes = buildAreaLanes(commits, ct, new Set(['apps/big']));
    const keys = lanes.map((l) => l.key);
    expect(keys).toContain(`${SUBHEADER_PREFIX}apps/big`);
    expect(keys).toContain('apps/big::src/main');
    expect(keys).toContain('apps/big::src/renderer');
    expect(keys.indexOf(`${SUBHEADER_PREFIX}apps/big`)).toBeLessThan(keys.indexOf('apps/big::src/main'));
    const drawn = lanes.filter((l) => !isHeader(l)).flatMap((l) => l.commits).sort((a, b) => a - b);
    expect(drawn).toEqual(commits.map((_, i) => i));
    // The app header carries all the app's commits, for its card.
    expect(lanes.find((l) => l.key === `${SUBHEADER_PREFIX}apps/big`)?.commits).toHaveLength(10);
  });
});
