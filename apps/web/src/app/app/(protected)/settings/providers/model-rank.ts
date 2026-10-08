import { fuzzyFilter } from '@/components/ui/listbox';
import type { SelectOption } from '@/components/ui/Select';

/**
 * Search order for the endpoint model picker. Model ids share long prefixes
 * (`fireworks_ai/deepseek-…`), so a plain fuzzy score can bury the one the
 * person typed in full. Order: the exact id, ids that start with the query,
 * the model name after the last `/` exactly, then starting with it, then the
 * fuzzy matches by score. Ties keep the input order.
 */
export function rankModelOptions<O extends Pick<SelectOption, 'label' | 'description'>>(options: readonly O[], query: string): O[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const tier = (o: O): number => {
    const id = o.label.toLowerCase();
    const name = id.slice(id.lastIndexOf('/') + 1);
    if (id === q) return 0;
    if (id.startsWith(q)) return 1;
    if (name === q) return 2;
    if (name.startsWith(q)) return 3;
    return 4;
  };
  // fuzzyFilter drops non-matches and orders the rest by score; a stable sort
  // by tier then lifts the exact and prefix hits above it.
  const matched = fuzzyFilter(options, q, (o) => `${o.label} ${o.description ?? ''}`);
  return matched
    .map((o, i) => ({ o, i, t: tier(o) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.o);
}
