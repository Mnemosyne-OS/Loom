/**
 * Milestones on the timeline (doc 140 §19, lot 3).
 *
 * Two kinds, both from what Loom already reads or lists — no file content is
 * read to place them:
 * - DOC: the commit that first brought a numbered design document into the
 *   repository (`docs/…/140_project-history-timeline.md`, or an ADR such as
 *   `docs/adr/0007-…md`). Drawn on that commit's own line. ⚠️ "First
 *   appearance in the history", not "created": git's name list does not say
 *   added from modified, and a renamed document appears twice.
 * - MEMORY: an agent's memory note (`<project folder>/memory/*.md`), at its
 *   last MODIFICATION time — the folder listing gives no creation date, and the
 *   screen says "modified", never "written".
 */
import type { Commit } from './types';

/** A numbered document under a top folder named like documentation. */
const NUMBERED_DOC = /^(?:docs?|documentation)\/(?:.*\/)?(\d+)[_\-. ]([^/]*)\.md$/i;
/**
 * A dated file name (`2026-04-18_…`): the year is not a document number.
 * Measured: 81 of the first 261 "milestones" were dated reflections.
 */
const DATED = /\/\d{4}-\d{2}-\d{2}[^/]*$/;
/** A file inside a NUMBERED folder (`108_multimodal-creation/01-…`) is a part of that doc, not a doc. */
const IN_NUMBERED_FOLDER = /\/\d+[_\-. ][^/]*\/[^/]+$/;

export interface DocMark {
  kind: 'doc';
  /** The commit that first carried it. */
  commit: number;
  at: number;
  path: string;
  /** `140` in `140_project-history-timeline.md`. */
  number: string;
  /** `project history timeline`. */
  title: string;
}

export interface MemoryMark {
  kind: 'memory';
  at: number;
  path: string;
  /** The note's file name without `.md`. */
  name: string;
}

export type Mark = DocMark | MemoryMark;

/** The commit that first carried each numbered document, oldest history first. */
export function docMarks(commits: readonly Commit[]): DocMark[] {
  const order = commits.map((_, i) => i).sort((a, b) => commits[a]!.at - commits[b]!.at || a - b);
  const seen = new Set<string>();
  const out: DocMark[] = [];
  for (const i of order) {
    const c = commits[i]!;
    for (const f of c.files) {
      const m = NUMBERED_DOC.exec(f);
      if (!m || seen.has(f) || DATED.test(f) || IN_NUMBERED_FOLDER.test(f)) continue;
      seen.add(f);
      out.push({
        kind: 'doc', commit: i, at: c.at, path: f,
        number: m[1]!,
        title: m[2]!.replace(/[_-]+/g, ' ').trim(),
      });
    }
  }
  return out;
}

/** One listed memory note. */
export interface ListedNote { path: string; name: string; mtime?: number }

/**
 * Memory notes as marks. A note listed in several folders (a project and its
 * worktrees) is one note: the most recent modification wins. A note whose
 * listing gave no date has no place on a timeline and is left out — counted
 * by the caller, never put at 1970.
 */
export function memoryMarks(notes: readonly ListedNote[]): { marks: MemoryMark[]; undated: number } {
  const byName = new Map<string, MemoryMark>();
  let undated = 0;
  for (const n of notes) {
    if (!n.name.toLowerCase().endsWith('.md')) continue;
    if (typeof n.mtime !== 'number' || !Number.isFinite(n.mtime)) { undated++; continue; }
    const name = n.name.slice(0, -3);
    const cur = byName.get(name);
    if (!cur || n.mtime > cur.at) byName.set(name, { kind: 'memory', at: n.mtime, path: n.path, name });
  }
  return { marks: [...byName.values()].sort((a, b) => a.at - b.at), undated };
}

/** `description:` from a note's front matter, or null. */
export function noteDescription(text: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const line = /^description:\s*(.+)$/m.exec(fm[1]!);
  return line ? line[1]!.trim().replace(/^["']|["']$/g, '') : null;
}

/** The line that carries the memory notes, after every other line. */
export const MEMORY_LANE = '\u0000memory';
