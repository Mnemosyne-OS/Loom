/**
 * What Loom keeps of one transcript (doc 140 §4).
 *
 * The transcript is read by `readSession` from `@mnemosyne_os/agent-transcripts`
 * — the reader Ariadne uses, so the files a conversation wrote (by a tool AND
 * by a shell) are found the same way on both screens. Loom adds one thing the
 * package does not read: the commits a conversation PRINTED.
 *
 * Nothing of the conversation's text is kept. A session is dates, file names
 * and short shas.
 */
import { CONNECTORS, readSession } from '@mnemosyne_os/agent-transcripts';
import type { Session } from './types';
import { activeIntervals, unionIntervals } from './active';

/**
 * `git commit` prints `[<branch> <sha>] <subject>`, with `(root-commit)` in
 * between for a first commit. Measured on this repository (doc 140 §10): 1 897
 * commits found this way across 259 conversations.
 *
 * 🚨 ANCHORED at the start of a line of output: in the raw transcript that is
 * right after the opening quote of a JSON string or after an escaped newline
 * (`\n`). Unanchored, a test fixture quoting a real sha credited every
 * conversation that READ that test file with the commit (doc 140 §22: the doc
 * 140 commit "made" in three conversations, two of which never touched Loom).
 */
const COMMIT_LINE = /(?:"|\\n)\[([A-Za-z0-9._/+-]+)(?: \(root-commit\))? ([0-9a-f]{7,12})\] /g;

/** A shell tool call, its command as a JSON string body. */
const SHELL_CALL = /"name":"(?:Bash|PowerShell)","input":\{"command":"((?:[^"\\]|\\.)*)"/g;

/**
 * The first line of the message of a `git commit` command, in the shapes
 * agents write it: `-m "…"`, `-m '…'`, a PowerShell here-string `-m @'…'@`,
 * or a heredoc `-m "$(cat <<'EOF' …)"`. Null for `-F file` or no message.
 */
export function commitMessageOf(command: string): string | null {
  const at = /\bgit\b[^\n]*?\bcommit\b/.exec(command);
  if (!at) return null;
  // 🪤 Only what FOLLOWS `git commit`: the same command often appends to a doc
  // with its own `<<'EOF'` heredoc first, and its first line is not the message.
  const tail = command.slice(at.index);
  const tries = [
    /-m\s+"\$\(cat\s+<<-?\s*['"]?EOF['"]?\s*\r?\n([^\r\n]+)/,
    /-m\s+@['"]\s*\r?\n([^\r\n]+)/,
    /-m\s+"([^"\r\n]+)/,
    /-m\s+'([^'\r\n]+)/,
  ];
  for (const re of tries) {
    const m = re.exec(tail);
    const line = m?.[1]?.trim();
    if (line && !line.startsWith('$(')) return line.slice(0, 200);
  }
  return null;
}

/**
 * The commit messages this conversation's own `git commit` commands carried.
 * 🚨 This is how a QUIET commit is recognised: `git commit -q` prints no
 * `[branch sha]`, and 5 243 commits of this repository's conversations were
 * made that way (doc 140 §22) — the conversation made them for certain, and
 * without this the timeline could only say "probably".
 */
export function commandSubjects(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('commit')) continue;
    SHELL_CALL.lastIndex = 0;
    for (const m of line.matchAll(SHELL_CALL)) {
      let command: string;
      // A body that is not a valid JSON string cannot be read as a command: skipped, not guessed.
      try { command = JSON.parse(`"${m[1]}"`) as string; } catch { continue; }
      const subject = commitMessageOf(command);
      if (subject) out.add(subject);
    }
  }
  return [...out];
}

/**
 * Short shas printed by `git commit` in this transcript. Only lines that carry
 * a tool RESULT are read: the same pattern quoted in a message the human or the
 * model typed is not a commit this conversation made.
 */
export function printedShas(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('tool_result') && !line.includes('toolUseResult')) continue;
    COMMIT_LINE.lastIndex = 0;
    for (const m of line.matchAll(COMMIT_LINE)) if (m[2]) out.add(m[2]);
  }
  return [...out];
}

/**
 * An absolute path a conversation wrote, made relative to the repository, or
 * null when it is outside. The repository is known by its folder NAME only
 * (the host never hands Loom its path), so the cut is at `/<name>/`; a path
 * inside one of its worktrees (`.claude/worktrees/<w>/`) is the same file.
 *
 * ⚠️ Two repositories with the same folder name are not told apart here. The
 * folders the person ticks on the setup screen are what keeps that rare.
 */
export function toRepoRelative(path: string, repoName: string): string | null {
  const abs = path.replace(/\\/g, '/').toLowerCase();
  const marker = `/${repoName.toLowerCase()}/`;
  const i = abs.indexOf(marker);
  if (i < 0) return null;
  let rel = abs.slice(i + marker.length);
  const wt = /^\.claude\/worktrees\/[^/]+\//.exec(rel);
  if (wt) rel = rel.slice(wt[0].length);
  return rel || null;
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * First and last dated line of the transcript, EVERY line included.
 *
 * 🪤 Not `readSession`'s `lastEventAt`: it stops at the last message, and the
 * line where git prints a commit is a tool RESULT that usually comes after it.
 * A window that ends before the commit line cannot contain the commit, and the
 * inferred link is lost exactly where it was most likely. Lot 0 read every
 * line too (doc 140 §10).
 */
export function windowOf(text: string): { start: number | null; end: number | null; active: number[] } {
  let start: number | null = null;
  let end: number | null = null;
  const times: number[] = [];
  for (const line of text.split('\n')) {
    const m = TIMESTAMP.exec(line);
    if (!m?.[1]) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    times.push(t);
    if (start === null || t < start) start = t;
    if (end === null || t > end) end = t;
  }
  return { start, end, active: activeIntervals(times) };
}

/**
 * A path a shell command named, made absolute against the conversation's
 * folder. The reader keeps a relative target as written (it does not guess a
 * working directory); Loom resolves it against `projectPath`, the folder the
 * harness recorded for the session.
 *
 * ⚠️ An approximation: a session that `cd`s mid-way wrote relative to another
 * folder. Lot 0 resolved per line and found the same order of gain (doc 140 §10).
 */
export function absoluteFrom(path: string, base: string | null): string | null {
  const p = path.replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/');
  if (/^([a-zA-Z]:\/|\/)/.test(p)) return p;
  if (!base || p.startsWith('~')) return null;
  const parts = base.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * One transcript, summarised. Null when the reader found no event with a
 * date: a conversation with no time cannot be placed on a timeline, and
 * placing it at 1970 would be a fabricated point.
 */
export function summarise(
  file: string,
  path: string,
  text: string,
  sizeBytes: number,
  repoName: string,
): Session | null {
  const st = readSession(CONNECTORS['claude-code'], file, path, text, sizeBytes);
  if (!st) return null;
  const { start, end, active } = windowOf(text);
  if (start === null || end === null) return null;

  const toolFiles = new Set<string>();
  const shellFiles = new Set<string>();
  for (const a of st.artifacts) {
    const abs = absoluteFrom(a.path, st.projectPath);
    const rel = abs ? toRepoRelative(abs, repoName) : null;
    if (!rel) continue;
    (a.origin === 'tool' ? toolFiles : shellFiles).add(rel);
  }
  return {
    id: file.replace(/\.jsonl$/i, ''),
    transcript: path,
    title: st.title,
    start,
    end,
    active,
    toolFiles: [...toolFiles],
    shellFiles: [...shellFiles].filter((f) => !toolFiles.has(f)),
    shas: printedShas(text),
    commitSubjects: commandSubjects(text),
  };
}

/**
 * A subagent transcript folded into its parent conversation: its writes and its
 * commits are the parent's, and its time stretches the parent's window.
 */
export function mergeInto(parent: Session, child: Session): Session {
  const tool = new Set([...parent.toolFiles, ...child.toolFiles]);
  return {
    ...parent,
    start: Math.min(parent.start, child.start),
    end: Math.max(parent.end, child.end),
    // A subagent runs INSIDE its parent's time: the union, never the sum.
    active: unionIntervals([parent.active, child.active]),
    toolFiles: [...tool],
    shellFiles: [...new Set([...parent.shellFiles, ...child.shellFiles])].filter((f) => !tool.has(f)),
    shas: [...new Set([...parent.shas, ...child.shas])],
    commitSubjects: [...new Set([...parent.commitSubjects, ...child.commitSubjects])],
  };
}
