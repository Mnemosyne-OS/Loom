/** Milestones (doc 140 §19): numbered docs from the history, memory notes from a listing. */
import { describe, it, expect } from 'vitest';
import { docMarks, memoryMarks, noteDescription } from './marks';
import type { Commit } from './types';

const c = (at: number, files: string[]): Commit => ({
  sha: String(at).padStart(40, '0'), at, author: '', parents: 1, subject: '', type: null, scope: null, files,
});

describe('docMarks', () => {
  it('marks the commit that FIRST carried each numbered doc, whatever order git listed them in', () => {
    const commits = [
      c(30, ['docs/architecture/140_project-history-timeline.md']),
      c(10, ['docs/architecture/140_project-history-timeline.md', 'apps/x/a.ts']),
      c(20, ['docs/adr/0007-use-sqlite.md', 'docs/notes.md', 'README.md']),
    ];
    const marks = docMarks(commits);
    expect(marks.map((m) => [m.commit, m.number, m.title])).toEqual([
      [1, '140', 'project history timeline'],
      [2, '0007', 'use sqlite'],
    ]);
  });

  it('ignores a DATED file and the parts of a numbered folder (measured: 115 false milestones)', () => {
    expect(docMarks([c(1, [
      'docs/reflections/2026-04-18_resonance_ignition_chronicle.md',
      'docs/architecture/108_multimodal-creation/01-the-channel.md',
      'docs/architecture/108_multimodal-creation.md',
    ])]).map((m) => m.path)).toEqual(['docs/architecture/108_multimodal-creation.md']);
  });

  it('ignores documents without a number and folders not named like documentation', () => {
    expect(docMarks([c(1, ['docs/guide.md', 'src/12_x.md', 'documentation/3-intro.md'])]).map((m) => m.path))
      .toEqual(['documentation/3-intro.md']);
  });
});

describe('memoryMarks', () => {
  it('keeps one mark per note (the most recent folder wins) and counts the undated ones', () => {
    const { marks, undated } = memoryMarks([
      { path: '/a/memory/x.md', name: 'x.md', mtime: 100 },
      { path: '/wt/memory/x.md', name: 'x.md', mtime: 200 },
      { path: '/a/memory/y.md', name: 'y.md' },
      { path: '/a/memory/z.txt', name: 'z.txt', mtime: 5 },
    ]);
    expect(marks).toEqual([{ kind: 'memory', at: 200, path: '/wt/memory/x.md', name: 'x' }]);
    expect(undated).toBe(1);
  });
});

describe('noteDescription', () => {
  it('reads the description of the front matter, quotes removed', () => {
    expect(noteDescription('---\nname: a\ndescription: "the fact"\n---\nbody')).toBe('the fact');
    expect(noteDescription('---\r\nname: a\r\ndescription: plain\r\n---\r\n')).toBe('plain');
  });
  it('says there is none when there is none', () => {
    expect(noteDescription('# just a title')).toBeNull();
    expect(noteDescription('---\nname: a\n---\n')).toBeNull();
  });
});
