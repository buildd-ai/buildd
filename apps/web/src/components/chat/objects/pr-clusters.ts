/**
 * A list of PRs grouped the way a reader scans "what shipped": by mission,
 * else by the task's category ("Fixes", "Features"), else by area (its scope
 * chip, "fx"), else "Other". Biggest group
 * first, "Other" last; each group keeps the list's own order. Pure.
 */
import type { BuilddObjectRef } from '../chat-contract';

export interface PrCluster { key: string; label: string; refs: BuilddObjectRef[] }

const OTHER = 'Other';

/** tasks.category → a group heading. */
const CATEGORY_LABEL: Record<string, string> = {
  feature: 'Features', bug: 'Fixes', refactor: 'Refactors', chore: 'Chores', docs: 'Docs', test: 'Tests',
  infra: 'Infra', design: 'Design', review: 'Reviews', research: 'Research',
};

function clusterOf(r: BuilddObjectRef): { key: string; label: string } {
  if (r.kind !== 'pr') return { key: 'other', label: OTHER };
  if (r.missionTitle) return { key: `m:${r.missionId ?? r.missionTitle}`, label: r.missionTitle };
  if (r.category && CATEGORY_LABEL[r.category]) return { key: `c:${r.category}`, label: CATEGORY_LABEL[r.category] };
  if (r.area) return { key: `a:${r.area}`, label: r.area };
  return { key: 'other', label: OTHER };
}

export function prClusters(refs: readonly BuilddObjectRef[]): PrCluster[] {
  const byKey = new Map<string, PrCluster>();
  for (const r of refs) {
    const { key, label } = clusterOf(r);
    const c = byKey.get(key) ?? { key, label, refs: [] };
    c.refs.push(r);
    byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) =>
    (a.key === 'other' ? 1 : 0) - (b.key === 'other' ? 1 : 0) || b.refs.length - a.refs.length);
}
