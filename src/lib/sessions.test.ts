import { describe, it, expect } from 'vitest';
import { absoluteFrom, commandSubjects, commitMessageOf, mergeInto, printedShas, summarise, toRepoRelative } from './sessions';

const line = (o: unknown) => JSON.stringify(o);

describe('printedShas', () => {
  it('reads `[branch sha]` from tool results only', () => {
    const text = [
      // A made-up sha: a REAL one in a fixture credits every session that reads this file.
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: '[main abcdef123] docs(1): x' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: '[feat/x (root-commit) abcdef1] first' }] } }),
      // Typed by a person, not printed by git: not a commit of this conversation.
      line({ type: 'user', message: { content: 'look at [main deadbee] please' } }),
    ].join('\n');
    expect(printedShas(text).sort()).toEqual(['abcdef1', 'abcdef123']);
  });

  it('reads the commit line only at the START of a line of output, never quoted mid-line', () => {
    const text = [
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok\n[main 1111111] first' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: "const f = '[main 2222222] quoted in a file';" }] } }),
    ].join('\n');
    expect(printedShas(text)).toEqual(['1111111']);
  });
});

describe('toRepoRelative', () => {
  it('cuts at the repository folder and folds worktrees in', () => {
    expect(toRepoRelative('C:\\Users\\me\\_MNEMOSYNE OS\\apps\\x.ts', '_MNEMOSYNE OS')).toBe('apps/x.ts');
    expect(toRepoRelative('C:/Users/me/_MNEMOSYNE OS/.claude/worktrees/w1/apps/x.ts', '_mnemosyne os')).toBe('apps/x.ts');
    expect(toRepoRelative('C:/Users/me/elsewhere/x.ts', '_MNEMOSYNE OS')).toBeNull();
  });
});

describe('absoluteFrom', () => {
  it('keeps absolute paths, turns Git Bash /c/ into C:/, resolves relative ones', () => {
    expect(absoluteFrom('C:\\a\\b.ts', null)).toBe('C:/a/b.ts');
    expect(absoluteFrom('/c/Users/x.ts', null)).toBe('c:/Users/x.ts');
    expect(absoluteFrom('docs/../src/a.ts', 'C:\\repo')).toBe('C:/repo/src/a.ts');
    expect(absoluteFrom('./a.ts', 'C:/repo/')).toBe('C:/repo/a.ts');
  });

  it('refuses a relative path with no base, and a home path, rather than guessing', () => {
    expect(absoluteFrom('a.ts', null)).toBeNull();
    expect(absoluteFrom('~/a.ts', 'C:/repo')).toBeNull();
  });
});

describe('summarise', () => {
  const ts = (m: number) => new Date(Date.UTC(2026, 9, 7, 12, m)).toISOString();
  const transcript = [
    line({ type: 'user', timestamp: ts(0), cwd: 'C:\\Users\\me\\_MNEMOSYNE OS', sessionId: 's1', message: { role: 'user', content: 'go' } }),
    line({
      type: 'assistant', timestamp: ts(5), cwd: 'C:\\Users\\me\\_MNEMOSYNE OS', sessionId: 's1',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: { file_path: 'C:\\Users\\me\\_MNEMOSYNE OS\\src\\a.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi > docs/note.md' } },
        { type: 'tool_use', name: 'Write', input: { file_path: 'C:\\Users\\me\\elsewhere\\x.ts' } },
      ] },
    }),
    line({ type: 'user', timestamp: ts(9), sessionId: 's1', message: { content: [{ type: 'tool_result', content: '[main abc1234] feat: a' }] } }),
  ].join('\n');

  it('keeps dates, repo-relative files by origin and printed shas, never the text', () => {
    const s = summarise('s1.jsonl', '/p/s1.jsonl', transcript, transcript.length, '_MNEMOSYNE OS');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('s1');
    expect(s!.start).toBe(Date.parse(ts(0)));
    expect(s!.end).toBe(Date.parse(ts(9)));
    expect(s!.toolFiles).toEqual(['src/a.ts']);
    expect(s!.shas).toEqual(['abc1234']);
    expect(JSON.stringify(s)).not.toContain('echo hi');
  });

  it('places a relative shell write in the conversation folder when the harness recorded one', () => {
    const s = summarise('s1.jsonl', '/p/s1.jsonl', transcript, transcript.length, '_MNEMOSYNE OS');
    // projectPath comes from the connector; when it is absent the write is dropped, not guessed.
    expect(s!.shellFiles.every((f) => f === 'docs/note.md')).toBe(true);
  });

  it('returns null for a transcript without any dated event', () => {
    const undated = line({ type: 'user', message: { content: 'x' } });
    expect(summarise('u.jsonl', '/p/u.jsonl', undated, undated.length, 'r')).toBeNull();
  });
});

describe('commit commands', () => {
  it('reads the first line of the message in the shapes agents write it', () => {
    expect(commitMessageOf('git commit -q -m "feat(x): one\n\nbody"')).toBe('feat(x): one');
    expect(commitMessageOf("git commit -m 'fix: two'")).toBe('fix: two');
    expect(commitMessageOf("git commit -m @'\nfeat: three\n'@")).toBe('feat: three');
    expect(commitMessageOf('git commit -m "$(cat <<\'EOF\'\ndocs: four\nEOF\n)"')).toBe('docs: four');
    expect(commitMessageOf('git commit -F msg.txt')).toBeNull();
    // A doc heredoc BEFORE the commit in the same command is not the message.
    expect(commitMessageOf("cat >> doc.md <<'EOF'\n## 22. A section\nEOF\ngit commit -q -m \"feat(loom): the real one\"")).toBe('feat(loom): the real one');
    expect(commitMessageOf('git status')).toBeNull();
  });

  it('takes them from shell tool calls only', () => {
    const text = [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git add a && git commit -q -m "feat: quiet"' } }] } }),
      line({ type: 'user', message: { content: 'please git commit -m "not a command"' } }),
    ].join('\n');
    expect(commandSubjects(text)).toEqual(['feat: quiet']);
  });
});

describe('mergeInto', () => {
  it('folds a subagent into its parent: window, files, shas', () => {
    const p = { id: 'p', transcript: 'p', title: 'P', start: 10, end: 20, active: [10, 20], toolFiles: ['a'], shellFiles: ['b'], shas: ['1111111'], commitSubjects: ['a'] };
    const c = { id: 'c', transcript: 'c', title: null, start: 5, end: 30, active: [5, 8, 25, 30], toolFiles: ['b'], shellFiles: ['d'], shas: ['2222222'], commitSubjects: ['b'] };
    const m = mergeInto(p, c);
    expect(m).toMatchObject({ id: 'p', title: 'P', start: 5, end: 30, transcript: 'p' });
    expect(m.toolFiles.sort()).toEqual(['a', 'b']);
    expect(m.shellFiles).toEqual(['d']);
    expect(m.shas.sort()).toEqual(['1111111', '2222222']);
    expect(m.commitSubjects.sort()).toEqual(['a', 'b']);
  });
});
