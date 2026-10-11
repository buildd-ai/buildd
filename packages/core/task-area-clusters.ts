/**
 * Layer 2 of the task-estimates model: area clusters.
 *
 * Completed work tasks are grouped by WHERE they landed. A cluster is a
 * directory prefix that enough tasks touched; its label is that prefix. Per
 * cluster, and per (kind, complexity), we keep quantiles of agent minutes and
 * tokens plus how often the work needed repair (CI / conflict / review
 * retries). A new task is mapped to clusters before it starts and the cluster
 * stats become an estimate that does not depend on text similarity.
 *
 * Pure: rows in, a model out. The DB reads are `./task-area-clusters-source.ts`.
 * `asOf` makes the model reproducible at any past date with the same cutoff the
 * backtest replay uses — a task created at or after `asOf` is invisible.
 *
 * Derivation. Every file goes to the DEEPEST ancestor directory (at least
 * `minDepth` segments, at most `maxDepth`) that `minSamples` distinct tasks
 * touched. That is what separates `apps/web/src/app/app/(protected)/missions`
 * from `packages/core/drizzle` while keeping every cluster sampled. Then
 * sibling clusters that are touched by nearly the same tasks (Jaccard ≥
 * `mergeJaccard`) merge into their parent — two dirs that always change
 * together are one area — and clusters still under `minSamples` roll up to
 * their parent, or vanish at `minDepth`. A lone file never makes a cluster.
 * A task belongs to a cluster with weight = its files there / its files.
 */
import { pathCovers } from './task-area-prediction';

export interface ClusterTask {
  id: string;
  createdAt: Date;
  kind: string | null;
  complexity: string | null;
  /** Agent minutes (sum of worker spans). */
  minutes: number;
  tokens: number;
  /** CI + conflict + review retry attempts the task needed. */
  repairs: number;
  /** Files the task's diff touched. */
  files: readonly string[];
}

export interface ClusterOptions {
  asOf?: Date;
  /** Distinct tasks a cluster needs. Default 3. */
  minSamples?: number;
  /** Path segments: `apps/web` is 2. Defaults 2 and 8 (the missions page is 7 deep). */
  minDepth?: number;
  maxDepth?: number;
  mergeJaccard?: number;
}

export interface Quantiles { p50: number; p80: number }

export interface ClusterGroupStats {
  n: number;
  minutes: Quantiles;
  tokens: Quantiles;
  /** Repair attempts per task. */
  repairRate: number;
}

export interface AreaCluster {
  /** Common directory prefix, also the human label. */
  label: string;
  /** Tasks with any weight here. */
  n: number;
  /** All tasks in the cluster. */
  overall: ClusterGroupStats;
  /** Keyed `${kind}/${complexity}`; 'unknown' where unset. */
  byGroup: Record<string, ClusterGroupStats>;
}

export interface ClusterModel {
  asOf: Date | null;
  /** Tasks that had a diff and were considered. */
  tasks: number;
  clusters: AreaCluster[];
}

export const groupKey = (kind: string | null | undefined, complexity: string | null | undefined) =>
  `${kind || 'unknown'}/${complexity || 'unknown'}`;

const DEFAULTS = { minSamples: 3, minDepth: 2, maxDepth: 8, mergeJaccard: 0.75 };

export function normalisePath(raw: string): string {
  return raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

const parentOf = (dir: string) => dir.slice(0, dir.lastIndexOf('/'));
const depthOf = (dir: string) => (dir ? dir.split('/').length : 0);

/** Ancestor directories of a file, minDepth..maxDepth segments, shallow first. */
function ancestorDirs(file: string, minDepth: number, maxDepth: number): string[] {
  const segs = file.split('/').slice(0, -1);
  const out: string[] = [];
  for (let d = minDepth; d <= Math.min(segs.length, maxDepth); d++) out.push(segs.slice(0, d).join('/'));
  return out;
}

/** Weighted quantile: first value whose cumulative weight reaches q of the total. */
export function weightedQuantile(items: ReadonlyArray<{ value: number; weight: number }>, q: number): number {
  const xs = items.filter(i => i.weight > 0 && Number.isFinite(i.value)).sort((a, b) => a.value - b.value);
  if (xs.length === 0) return 0;
  const total = xs.reduce((s, i) => s + i.weight, 0);
  let cum = 0;
  for (const i of xs) {
    cum += i.weight;
    if (cum >= q * total - 1e-9) return i.value;
  }
  return xs[xs.length - 1].value;
}

function statsOf(members: ReadonlyArray<{ task: ClusterTask; weight: number }>): ClusterGroupStats {
  const w = members.reduce((s, m) => s + m.weight, 0);
  const q = (pick: (t: ClusterTask) => number, p: number) =>
    weightedQuantile(members.map(m => ({ value: pick(m.task), weight: m.weight })), p);
  return {
    n: members.length,
    minutes: { p50: q(t => t.minutes, 0.5), p80: q(t => t.minutes, 0.8) },
    tokens: { p50: q(t => t.tokens, 0.5), p80: q(t => t.tokens, 0.8) },
    repairRate: w > 0 ? members.reduce((s, m) => s + m.weight * m.task.repairs, 0) / w : 0,
  };
}

export function deriveClusters(allTasks: readonly ClusterTask[], opts: ClusterOptions = {}): ClusterModel {
  const { minSamples, minDepth, maxDepth, mergeJaccard } = { ...DEFAULTS, ...opts };
  const asOf = opts.asOf ?? null;

  const tasks: Array<{ task: ClusterTask; files: string[] }> = [];
  for (const t of allTasks) {
    if (asOf && t.createdAt.getTime() >= asOf.getTime()) continue;
    const files = [...new Set(t.files.map(normalisePath).filter(Boolean))];
    if (files.length > 0) tasks.push({ task: t, files });
  }

  // Which tasks touch each directory.
  const support = new Map<string, Set<number>>();
  tasks.forEach(({ files }, i) => {
    for (const f of files) for (const d of ancestorDirs(f, minDepth, maxDepth)) {
      const s = support.get(d) ?? new Set<number>();
      s.add(i);
      support.set(d, s);
    }
  });

  // counts[taskIdx] : label -> files assigned. Deepest sampled ancestor wins.
  const counts: Array<Map<string, number>> = tasks.map(() => new Map());
  tasks.forEach(({ files }, i) => {
    for (const f of files) {
      const dirs = ancestorDirs(f, minDepth, maxDepth);
      for (let k = dirs.length - 1; k >= 0; k--) {
        if ((support.get(dirs[k])?.size ?? 0) >= minSamples) {
          counts[i].set(dirs[k], (counts[i].get(dirs[k]) ?? 0) + 1);
          break;
        }
      }
    }
  });

  const relabel = (from: string, to: string | null) => {
    for (const c of counts) {
      const n = c.get(from);
      if (n === undefined) continue;
      c.delete(from);
      if (to) c.set(to, (c.get(to) ?? 0) + n);
    }
  };
  const membersOf = () => {
    const m = new Map<string, Set<number>>();
    counts.forEach((c, i) => { for (const l of c.keys()) (m.get(l) ?? m.set(l, new Set()).get(l)!).add(i); });
    return m;
  };

  for (let changed = true; changed;) {
    changed = false;
    const m = membersOf();
    // Roll up / drop under-sampled clusters.
    for (const [label, set] of m) {
      if (set.size >= minSamples) continue;
      relabel(label, depthOf(label) > minDepth ? parentOf(label) : null);
      changed = true;
      break;
    }
    if (changed) continue;
    // Merge siblings touched by nearly the same tasks.
    const byParent = new Map<string, string[]>();
    for (const label of m.keys()) {
      const p = parentOf(label);
      if (depthOf(p) >= minDepth) (byParent.get(p) ?? byParent.set(p, []).get(p)!).push(label);
    }
    outer: for (const [parent, labels] of byParent) {
      for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
        const A = m.get(labels[a])!, B = m.get(labels[b])!;
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        if (inter / (A.size + B.size - inter) >= mergeJaccard) {
          relabel(labels[a], parent);
          relabel(labels[b], parent);
          changed = true;
          break outer;
        }
      }
    }
  }

  const final = membersOf();
  const clusters: AreaCluster[] = [];
  for (const [label, set] of final) {
    const members = [...set].map(i => ({
      task: tasks[i].task,
      weight: (counts[i].get(label) ?? 0) / tasks[i].files.length,
    }));
    const groups = new Map<string, typeof members>();
    for (const mem of members) {
      const k = groupKey(mem.task.kind, mem.task.complexity);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(mem);
    }
    clusters.push({
      label,
      n: members.length,
      overall: statsOf(members),
      byGroup: Object.fromEntries([...groups].map(([k, v]) => [k, statsOf(v)])),
    });
  }
  clusters.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  return { asOf, tasks: tasks.length, clusters };
}

// ── Mapping a new task to clusters ───────────────────────────────────────────

export interface ClusterWeight { label: string; weight: number }

/** Manifest entries may be globs (`apps/web/**`); keep the literal directory part. */
function literalPrefix(raw: string): string {
  const segs = normalisePath(raw).split('/');
  const i = segs.findIndex(s => /[*?[\]{}]/.test(s) && !/^\(.*\)$/.test(s) && !/^\[.+\]$/.test(s));
  return (i === -1 ? segs : segs.slice(0, i)).join('/');
}

/**
 * Clusters a set of paths falls in, weights summing to 1. A file path goes to
 * its deepest cluster; a directory broader than clusters splits across the
 * clusters under it. Paths in no cluster are ignored; no match → [].
 */
export function mapPathsToClusters(paths: readonly string[], model: Pick<ClusterModel, 'clusters'>): ClusterWeight[] {
  const labels = model.clusters.map(c => c.label);
  const acc = new Map<string, number>();
  for (const raw of paths) {
    const p = literalPrefix(raw);
    if (!p) continue;
    const ancestors = labels.filter(l => p === l || p.startsWith(l + '/')).sort((a, b) => b.length - a.length);
    const hit = ancestors.length ? [ancestors[0]] : labels.filter(l => l.startsWith(p + '/'));
    for (const l of hit) acc.set(l, (acc.get(l) ?? 0) + 1 / hit.length);
  }
  const total = [...acc.values()].reduce((s, x) => s + x, 0);
  return total > 0 ? [...acc].map(([label, w]) => ({ label, weight: w / total })).sort((a, b) => b.weight - a.weight) : [];
}

export const NEW_TASK_PATH_SOURCES = ['manifest', 'neighbours', 'none'] as const;
export type NewTaskPathSource = (typeof NEW_TASK_PATH_SOURCES)[number];

/**
 * Before the task starts: its declared pathManifest if it has one, else the
 * files its neighbours' diffs touched (the area `task-area-prediction.ts`
 * predicts). Never written back to `tasks.path_manifest`.
 */
export function mapNewTaskToClusters(
  input: { pathManifest?: readonly string[] | null; neighbourPaths?: readonly string[] },
  model: Pick<ClusterModel, 'clusters'>,
): { source: NewTaskPathSource; clusters: ClusterWeight[] } {
  const manifest = (input.pathManifest ?? []).filter(p => typeof p === 'string' && p.trim());
  if (manifest.length) {
    const mapped = mapPathsToClusters(manifest, model);
    if (mapped.length) return { source: 'manifest', clusters: mapped };
  }
  const mapped = mapPathsToClusters(input.neighbourPaths ?? [], model);
  return mapped.length ? { source: 'neighbours', clusters: mapped } : { source: 'none', clusters: [] };
}

export interface ClusterEstimate {
  minutes: number;
  p80Minutes: number;
  tokens: number;
  repairRate: number;
  /** Cluster labels that contributed. */
  clusters: string[];
}

/**
 * Cluster-alone estimate: weighted median across the mapped clusters of each
 * one's quantiles for this (kind, complexity), falling back to the cluster's
 * overall stats when that group has fewer than `minGroupN` tasks there.
 */
export function estimateFromClusters(
  mapped: readonly ClusterWeight[],
  model: Pick<ClusterModel, 'clusters'>,
  task: { kind?: string | null; complexity?: string | null },
  minGroupN = 2,
): ClusterEstimate | null {
  const byLabel = new Map(model.clusters.map(c => [c.label, c]));
  const key = groupKey(task.kind, task.complexity);
  const rows: Array<{ s: ClusterGroupStats; weight: number; label: string }> = [];
  for (const m of mapped) {
    const c = byLabel.get(m.label);
    if (!c) continue;
    const g = c.byGroup[key];
    rows.push({ s: g && g.n >= minGroupN ? g : c.overall, weight: m.weight, label: c.label });
  }
  if (!rows.length) return null;
  const q = (pick: (s: ClusterGroupStats) => number) => weightedQuantile(rows.map(r => ({ value: pick(r.s), weight: r.weight })), 0.5);
  const w = rows.reduce((s, r) => s + r.weight, 0);
  return {
    minutes: q(s => s.minutes.p50),
    p80Minutes: q(s => s.minutes.p80),
    tokens: q(s => s.tokens.p50),
    repairRate: rows.reduce((s, r) => s + r.weight * r.s.repairRate, 0) / w,
    clusters: rows.map(r => r.label),
  };
}
