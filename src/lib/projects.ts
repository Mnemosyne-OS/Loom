/**
 * Which conversation folders belong to the repository (doc 140 §3).
 *
 * Claude Code keeps one folder per working directory under `~/.claude/projects`,
 * named after the path with every non-alphanumeric character turned into `-`.
 * 🪤 A worktree gets its OWN folder (`<project>--claude-worktrees-<name>`):
 * reading only the repository's folder lost 71 conversations and a month of
 * history when this was measured.
 *
 * So Loom lists the folders, groups each worktree folder with its project, and
 * PRESELECTS the group whose name ends like the repository's folder. The
 * person can change the selection: the folder name is a hint, not a proof.
 */

/** The folder name Claude Code derives from a path segment. */
export function encodeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-');
}

const WORKTREE_MARK = '--claude-worktrees-';

/** The project a conversation folder belongs to: itself, or the project of a worktree. */
export function projectOf(folderName: string): string {
  const i = folderName.indexOf(WORKTREE_MARK);
  return i >= 0 ? folderName.slice(0, i) : folderName;
}

export interface ProjectGroup {
  /** The project folder name (the group key). */
  key: string;
  /** Every folder in the group: the project's own and its worktrees'. */
  folders: string[];
}

/**
 * The groups of one added folder. A folder holding transcripts directly IS a
 * project: one group, whose single folder is the root itself (`''`).
 */
export function groupsOfRoot(root: string, listing: { folders: string[]; hasTranscripts: boolean }): ProjectGroup[] {
  if (listing.hasTranscripts) {
    const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;
    return [{ key: name, folders: [''] }];
  }
  return groupFolders(listing.folders);
}

export function groupFolders(folderNames: readonly string[]): ProjectGroup[] {
  const groups = new Map<string, string[]>();
  for (const f of folderNames) {
    const k = projectOf(f);
    const list = groups.get(k);
    if (list) list.push(f); else groups.set(k, [f]);
  }
  return [...groups.entries()]
    .map(([key, folders]) => ({ key, folders: folders.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The groups that look like the repository: their project folder ends with the
 * encoded repository name. Several can match (two checkouts of one repo, or two
 * repos with the same folder name); all are proposed, none is hidden.
 */
export function matchingGroups(groups: readonly ProjectGroup[], repoName: string): string[] {
  const tail = encodeSegment(repoName).toLowerCase();
  if (!tail) return [];
  return groups
    .filter((g) => {
      // The previous path separator became a dash, so a whole segment is
      // preceded by one. `mnemosyne-os` must not match `my-mnemosyne-os`'s
      // neighbour `xmnemosyne-os`.
      const k = g.key.toLowerCase();
      return k === tail || k.endsWith(`-${tail}`);
    })
    .map((g) => g.key);
}
