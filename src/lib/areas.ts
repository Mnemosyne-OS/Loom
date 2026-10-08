/**
 * Lines by APP rather than by commit scope (doc 140 §14).
 *
 * The scope a commit message carries is free text: this repository has 653 of
 * them, and the 15 busiest leave 4 865 commits in "others". What a commit
 * touched is not free text: its file paths. In a monorepo they say which app
 * or package it belongs to (`apps/infinity-edition/…`, `packages/core-engine/…`).
 *
 * So Loom finds the CONTAINER folders of the repository (the folders whose
 * sub-folders are the apps), from the paths alone, and gives each app its line.
 * A commit goes on the line of the area it touched most; a merge or a commit
 * without files goes on its own line. Nothing is read beyond the file NAMES the
 * `git:read` door already hands over.
 */
import type { Commit, Lane } from './types';
import { buildTree, chooseLeaves, primaryLeaf, SUB_SEP } from './subareas';

/** Folder names that hold one app per sub-folder in most monorepos. */
const KNOWN_CONTAINERS = new Set(['apps', 'packages', 'libs', 'services', 'modules', 'plugins', 'crates', 'projects', 'extensions']);
/** An unknown top folder is a container once commits touched this many distinct sub-folders of it. */
const MIN_CHILDREN = 8;

export const ROOT_AREA = '\u0000root';
export const NO_FILES_AREA = '\u0000nofiles';
export const HEADER_PREFIX = '\u0000h:';
/**
 * The line of an app that is split into sub-lines: its name, its count and its
 * time, no points (they are drawn on the sub-lines below). It carries ALL the
 * app's commits, so a click on it opens the app's card.
 */
export const SUBHEADER_PREFIX = '\u0000s:';
/** An app holding more than this share of all commits is split by default. */
export const AUTO_SPLIT_SHARE = 0.25;
/** The group of the top-level folders that are not containers (docs, scripts…). */
export const REPO_GROUP = '\u0000repo';

/**
 * The container folders of this history. A known name counts as soon as one
 * commit reached inside a sub-folder of it; any other name needs MIN_CHILDREN
 * distinct sub-folders, so `docs/` with two sub-folders stays one line.
 */
export function detectContainers(commits: readonly Commit[]): Set<string> {
  const children = new Map<string, Set<string>>();
  for (const c of commits) {
    for (const f of c.files) {
      const parts = f.split('/');
      if (parts.length < 3) continue;
      const top = parts[0]!;
      let set = children.get(top);
      if (!set) { set = new Set(); children.set(top, set); }
      set.add(parts[1]!);
    }
  }
  const out = new Set<string>();
  for (const [top, set] of children) {
    if (KNOWN_CONTAINERS.has(top.toLowerCase()) || set.size >= MIN_CHILDREN) out.add(top);
  }
  return out;
}

/** The area one file belongs to: `apps/x` inside a container, its top folder otherwise. */
export function areaOf(file: string, containers: ReadonlySet<string>): string {
  const parts = file.split('/');
  if (parts.length === 1) return ROOT_AREA;
  const top = parts[0]!;
  if (containers.has(top) && parts.length >= 3) return `${top}/${parts[1]}`;
  return top;
}

/**
 * The area a commit touched most. Ties go to the alphabetical first, so the
 * answer never depends on the order git listed the files in.
 */
export function primaryArea(c: Commit, containers: ReadonlySet<string>): string {
  if (!c.files.length) return NO_FILES_AREA;
  const count = new Map<string, number>();
  for (const f of c.files) {
    const a = areaOf(f, containers);
    count.set(a, (count.get(a) ?? 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const [a, n] of count) {
    if (n > bestN || (n === bestN && a < best)) { best = a; bestN = n; }
  }
  return best;
}

/** The group an area is drawn under: its container, or the repository's other folders. */
export function groupOfArea(area: string, containers: ReadonlySet<string>): string {
  const top = area.split('/')[0]!;
  return containers.has(top) && area.includes('/') ? top : REPO_GROUP;
}

/**
 * Every area on its own line, under a header per group. Groups: containers by
 * their total commits (busiest first), then the repository's other folders,
 * then root files and commits without files at the very end. Inside a group,
 * busiest first, ties by name.
 */
export function buildAreaLanes(
  commits: readonly Commit[],
  containers: ReadonlySet<string>,
  split: ReadonlySet<string> = new Set(),
): Lane[] {
  const byArea = new Map<string, number[]>();
  commits.forEach((c, i) => {
    const a = primaryArea(c, containers);
    const list = byArea.get(a);
    if (list) list.push(i); else byArea.set(a, [i]);
  });

  const groups = new Map<string, Array<[string, number[]]>>();
  const tail: Array<[string, number[]]> = [];
  for (const entry of byArea) {
    if (entry[0] === ROOT_AREA || entry[0] === NO_FILES_AREA) { tail.push(entry); continue; }
    const g = groupOfArea(entry[0], containers);
    const list = groups.get(g);
    if (list) list.push(entry); else groups.set(g, [entry]);
  }

  const total = (list: Array<[string, number[]]>) => list.reduce((n, [, idx]) => n + idx.length, 0);
  const order = [...groups.keys()].sort((a, b) => {
    if (a === REPO_GROUP) return 1;
    if (b === REPO_GROUP) return -1;
    return total(groups.get(b)!) - total(groups.get(a)!) || a.localeCompare(b);
  });

  const lanes: Lane[] = [];
  for (const g of order) {
    lanes.push({ key: `${HEADER_PREFIX}${g}`, commits: [] });
    const list = groups.get(g)!.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [key, idx] of list) {
      if (split.has(key)) lanes.push(...subLanes(key, idx, commits));
      else lanes.push({ key, commits: idx });
    }
  }
  tail.sort((a, b) => (a[0] === ROOT_AREA ? -1 : b[0] === ROOT_AREA ? 1 : 0));
  for (const [key, idx] of tail) lanes.push({ key, commits: idx });
  return lanes;
}

/** The app's header line followed by its sub-lines, busiest first. */
function subLanes(area: string, idx: readonly number[], commits: readonly Commit[]): Lane[] {
  const prefix = `${area}/`;
  const inArea = (c: Commit) => c.files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  const leaves = chooseLeaves(buildTree(idx.flatMap((i) => inArea(commits[i]!))));
  const byLeaf = new Map<string, number[]>();
  for (const i of idx) {
    const leaf = primaryLeaf(inArea(commits[i]!), leaves);
    const list = byLeaf.get(leaf);
    if (list) list.push(i); else byLeaf.set(leaf, [i]);
  }
  const out: Lane[] = [{ key: `${SUBHEADER_PREFIX}${area}`, commits: [...idx] }];
  [...byLeaf.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .forEach(([leaf, list]) => out.push({ key: `${area}${SUB_SEP}${leaf}`, commits: list }));
  return out;
}

/** Areas busy enough to be split without being asked: more than AUTO_SPLIT_SHARE of all commits. */
export function autoSplit(commits: readonly Commit[], containers: ReadonlySet<string>): Set<string> {
  const count = new Map<string, number>();
  for (const c of commits) {
    const a = primaryArea(c, containers);
    if (a.includes('/')) count.set(a, (count.get(a) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => commits.length && n / commits.length > AUTO_SPLIT_SHARE).map(([a]) => a));
}

/** A group header or an app header: no points of its own on the line. */
export function isHeader(lane: Lane): boolean {
  return lane.key.startsWith(HEADER_PREFIX) || lane.key.startsWith(SUBHEADER_PREFIX);
}

/** A group header only (APPS, PACKAGES…): not clickable, no count. */
export function isGroupHeader(lane: Lane): boolean {
  return lane.key.startsWith(HEADER_PREFIX);
}

/** An app split into sub-lines: its header line (clickable, counted, no points). */
export function isSubHeader(lane: Lane): boolean {
  return lane.key.startsWith(SUBHEADER_PREFIX);
}

/** The app a line belongs to (`apps/x`), or null for lines that are not an app. */
export function areaOfLane(lane: Lane): string | null {
  if (lane.key.startsWith(SUBHEADER_PREFIX)) return lane.key.slice(SUBHEADER_PREFIX.length);
  if (lane.key.startsWith('\u0000')) return null;
  const i = lane.key.indexOf(SUB_SEP);
  return i >= 0 ? lane.key.slice(0, i) : lane.key;
}
