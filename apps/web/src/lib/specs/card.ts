import { specCriteria } from '@buildd/spec-contract/requirements';

/**
 * A spec as the decision evals saw it (Living Specs §13, §17): the title, the
 * opening prose line, then its criteria. Shared by the duplicate check and the
 * area classifier, and by core code that ranks specs without a model, so it
 * lives in core and the decisions module imports it.
 */
export interface SpecCard { title: string; summary: string; criteria: string[] }

/** A spec as the eval saw it: title, the opening paragraph, then its criteria. */
export function specCard(title: string, body: string): SpecCard {
  const criteria = specCriteria(body).map((c) => `${c.id}: ${c.text}`);
  const prose = body.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l) && !/^\s*([-*+]|\d+\.)\s/.test(l));
  return { title: title.trim(), summary: (prose[0] ?? '').trim().slice(0, 400), criteria };
}

export const cardTokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g)?.filter((t) => t.length > 2) ?? [];
export const cardText = (c: SpecCard) => [c.title, c.summary, ...c.criteria].join('\n');

/** Rank `pool` by TF-IDF cosine to `query`, best first, above `floor`, at most `k`. Pure, in process. */
export function tfidfRank<T extends { card: SpecCard }>(query: SpecCard, pool: readonly T[], k: number, floor: number): Array<T & { score: number }> {
  const docs = [query, ...pool.map((p) => p.card)].map((c) => cardTokens(cardText(c)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const vec = (d: string[]) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, f] of tf) v.set(t, (1 + Math.log(f)) * Math.log((1 + n) / (1 + (df.get(t) ?? 0)) + 1));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
  const q = vec(docs[0]!);
  const qn = norm(q);
  return pool
    .map((p, i) => {
      const v = vec(docs[i + 1]!);
      let dot = 0;
      for (const [t, w] of q) dot += w * (v.get(t) ?? 0);
      return { ...p, score: dot / (qn * norm(v)) };
    })
    .filter((p) => p.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
