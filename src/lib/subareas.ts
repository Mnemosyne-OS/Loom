/**
 * Sub-lines inside one app (doc 140 §17).
 *
 * `apps/infinity-edition` carries 43 % of this repository's commits. A fixed
 * cut would not help: `src/renderer` holds 95 % of its files, and
 * `components/widgets` alone 4 000 file changes. So the cut ADAPTS to the
 * app: start from its root and keep splitting the folder that holds the most
 * file changes, as long as it has sub-folders, until there are MAX_SUB lines or
 * the biggest one is small enough. A folder with a single sub-folder is walked
 * through, so `src/renderer/src` never becomes three lines of one.
 *
 * Counting unit: one file touched by one commit. A commit goes on the sub-line
 * it touched most (ties: alphabetical), like `primaryArea` one level up.
 */

export const MAX_SUB = 16;
/** Stop splitting once the biggest line holds less than this share of the app. */
const MIN_SHARE = 0.06;
/**
 * A sub-folder earns its own line when it holds at least this share of the
 * folder being split… Measured on infinity-edition: with a share of the WHOLE
 * app instead, `widgets › chat` (837 changes, 20 % of widgets, 3.9 % of the
 * app) never got a line.
 */
const MIN_OF_PARENT = 0.1;
/** …and at least this share of the app, so a tiny folder never splits into crumbs. */
const MIN_OF_APP = 0.015;
/** A sub-line key: `<area>::<folder inside it>`; a folder's own files are `<folder>/.`. */
export const SUB_SEP = '::';
const OWN_FILES = '.';

interface Node {
  count: number;
  /** Changes to files sitting directly in this folder. */
  own: number;
  children: Map<string, Node>;
}

const newNode = (): Node => ({ count: 0, own: 0, children: new Map() });

/** The folder tree of an app, from paths relative to its root (`src/main/x.ts`). */
export function buildTree(relPaths: Iterable<string>): Node {
  const root = newNode();
  for (const p of relPaths) {
    const parts = p.split('/');
    let n = root;
    n.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let c = n.children.get(seg);
      if (!c) { c = newNode(); n.children.set(seg, c); }
      c.count++;
      n = c;
    }
    n.own++;
  }
  return root;
}

/** A leaf gathering the sub-folders of a split folder that did not get a line of their own. */
const REST = '*';

/**
 * The folders that get their own line, as paths relative to the app root
 * (`''` = the app's root folder itself). A path ending in `/.` means "files
 * directly in that folder" once the folder itself was split; one ending in
 * `/*` gathers the sub-folders of a split folder past the cap, so a folder
 * with thirty sub-folders gives at most MAX_SUB lines, never thirty.
 */
export function chooseLeaves(root: Node, max = MAX_SUB, minShare = MIN_SHARE): string[] {
  const total = root.count || 1;
  // `fixed` leaves (own files, the rest) are never split again.
  type Leaf = { path: string; node: Node; fixed: boolean };
  let leaves: Leaf[] = [{ path: '', node: root, fixed: false }];
  const join = (base: string, seg: string) => (base ? `${base}/${seg}` : seg);
  const splittable = (l: Leaf) => !l.fixed && l.node.children.size > 0;
  while (leaves.length < max) {
    const candidates = leaves.filter(splittable).sort((a, b) => b.node.count - a.node.count || a.path.localeCompare(b.path));
    const big = candidates[0];
    if (!big || big.node.count / total < minShare) break;

    // Walk through a folder that holds a single sub-folder and nothing else.
    const descend = (l: Leaf): Leaf => {
      let cur = l;
      while (!cur.fixed && cur.node.own === 0 && cur.node.children.size === 1) {
        const [seg, child] = [...cur.node.children][0]!;
        cur = { path: join(cur.path, seg), node: child, fixed: false };
      }
      return cur;
    };
    const parts: Leaf[] = [...big.node.children]
      .map(([seg, child]) => descend({ path: join(big.path, seg), node: child, fixed: false }))
      .sort((a, b) => b.node.count - a.node.count || a.path.localeCompare(b.path));

    // Only a sub-folder big enough earns a line; the small ones, and the
    // folder's own files when they are few, share one "rest" line. Otherwise
    // `scripts` (13 changes) takes a line while `components` (1 224) stays whole.
    // `minShare` (above) decides WHETHER a folder is split; these two decide
    // which of its sub-folders get a line.
    const room = max - (leaves.length - 1);
    const big1 = (n: number) => n / big.node.count >= MIN_OF_PARENT && n / total >= MIN_OF_APP;
    const ownBig = big1(big.node.own);
    let keep = parts.filter((l) => big1(l.node.count));
    const slots = room - (ownBig ? 1 : 0);
    const restAfter = (k: Leaf[]) => parts.filter((l) => !k.includes(l));
    if (keep.length + (restAfter(keep).length || (!ownBig && big.node.own) ? 1 : 0) > slots) {
      keep = keep.slice(0, Math.max(0, slots - 1));
    }
    const rest = restAfter(keep);
    const restCount = rest.reduce((n, l) => n + l.node.count, 0) + (ownBig ? 0 : big.node.own);
    const next: Leaf[] = [...keep];
    if (ownBig) next.push({ path: join(big.path, OWN_FILES), node: { count: big.node.own, own: big.node.own, children: new Map() }, fixed: true });
    if (restCount > 0) next.push({ path: join(big.path, REST), node: { count: restCount, own: 0, children: new Map() }, fixed: true });
    // One sub-folder holds everything: walk into it, it costs no line.
    if (next.length === 1 && keep.length === 1) { leaves = leaves.filter((l) => l !== big).concat(keep); continue; }
    // Nothing big enough inside: splitting would only rename the folder. Keep it whole.
    if (keep.length === 0 || next.length < 2) { big.fixed = true; continue; }
    leaves = leaves.filter((l) => l !== big).concat(next);
  }
  return leaves.map((l) => l.path).sort();
}

/**
 * The leaf a file falls in: the deepest chosen folder holding it. A folder's
 * own-files leaf wins for a file sitting directly in it; a rest leaf (`/*`)
 * takes what no sibling took, the folder's own files included when they got no line.
 */
export function leafOf(relPath: string, leaves: readonly string[]): string {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  let best = '';
  let bestScore = -1;
  const inside = (folder: string) => folder === '' || dir === folder || dir.startsWith(`${folder}/`);
  for (const l of leaves) {
    let score = -1;
    if (l === OWN_FILES || l.endsWith(`/${OWN_FILES}`)) {
      const folder = l === OWN_FILES ? '' : l.slice(0, -(OWN_FILES.length + 1));
      if (dir === folder) score = folder.length + 0.75;
    } else if (l === REST || l.endsWith(`/${REST}`)) {
      const folder = l === REST ? '' : l.slice(0, -(REST.length + 1));
      if (inside(folder)) score = folder.length + 0.5;
    } else if (inside(l)) {
      score = l.length;
    }
    if (score > bestScore) { best = l; bestScore = score; }
  }
  return best;
}

/** The sub-line a commit belongs to inside its area. */
export function primaryLeaf(relPaths: readonly string[], leaves: readonly string[]): string {
  const count = new Map<string, number>();
  for (const p of relPaths) {
    const l = leafOf(p, leaves);
    count.set(l, (count.get(l) ?? 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const [l, n] of count) if (n > bestN || (n === bestN && l < best)) { best = l; bestN = n; }
  return best;
}

/** Folder names that only wrap the real structure, dropped from a sub-line's name. */
const WRAPPERS = new Set(['src', 'lib', 'source', 'app', 'components']);

/** A sub-line's name for the eye: `src/renderer/src/components/widgets/chat` → `renderer › widgets › chat`. */
export function prettyLeaf(path: string): { name: string; ownFiles: boolean; rest: boolean } {
  const ownFiles = path === OWN_FILES || path.endsWith(`/${OWN_FILES}`);
  const rest = path === REST || path.endsWith(`/${REST}`);
  const folder = ownFiles || rest ? path.slice(0, Math.max(0, path.length - 2)) : path;
  const parts = folder.split('/').filter((s) => s && !WRAPPERS.has(s.toLowerCase()));
  return { name: parts.join(' › '), ownFiles, rest };
}
