/**
 * The shapes Loom works with (doc 140).
 *
 * A COMMIT comes from the host's `git:read` door. A SESSION is what Loom keeps
 * of one agent conversation after reading its transcript: never its text, only
 * when it ran, what it wrote and which commits it printed. A LINK joins the two
 * and always says how it was established.
 */

/** One commit, as `git.log` hands it. */
export interface Commit {
  sha: string;
  /** Commit time, ms since epoch. */
  at: number;
  author: string;
  parents: number;
  subject: string;
  type: string | null;
  scope: string | null;
  files: string[];
}

/** What Loom keeps of one conversation. */
export interface Session {
  /** The transcript's own id (its file name without `.jsonl`). */
  id: string;
  /** Absolute path of the main transcript, what `agent.exportConversation` needs. */
  transcript: string;
  title: string | null;
  /** First and last event, ms since epoch. */
  start: number;
  end: number;
  /** Active intervals, flat `[start, end, …]` ms: events closer than 15 min joined (lib/active). */
  active: number[];
  /** Repo-relative, lowercase paths this conversation wrote, by origin. */
  toolFiles: string[];
  shellFiles: string[];
  /** Short shas the conversation printed after `git commit` (`[branch sha] …`). */
  shas: string[];
  /** First lines of the messages of its own `git commit` commands (quiet commits print no sha). */
  commitSubjects: string[];
}

/**
 * How a commit is tied to a conversation. Never merged into one kind
 * (doc 140 §4): a recorded link is a fact the transcript wrote down, an
 * inferred one is a coincidence of files and time.
 */
export type LinkKind = 'recorded' | 'inferred';

export interface CommitLinks {
  recorded: string[];
  /** Sessions inferred and NOT already recorded. */
  inferred: string[];
}

/** One line of the timeline. */
export interface Lane {
  /** The scope, or OTHERS_LANE for everything folded together. */
  key: string;
  /** Commits drawn on this line, by index into the commit list. */
  commits: number[];
}

export const OTHERS_LANE = '\u0000others';
export const NO_SCOPE_LANE = '\u0000none';
