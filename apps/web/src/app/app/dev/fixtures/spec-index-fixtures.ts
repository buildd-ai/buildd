/**
 * The `?state=spec-index` dev fixture (living-specs.md §19): a made-up
 * workspace's specs, about 30 across five areas of one product, with failing,
 * imported, filed-by-buildd, Unfiled and a possible area, plus the one-area
 * and no-area cases and a neighbour graph. Invented titles only; nothing is
 * fetched (seed scripts hit the prod API, so the index is shown from here).
 */
import type { SpecIndexInput } from '@/lib/specs/index-view';

export const SPEC_INDEX_FIXTURE_NOW = Date.parse('2026-10-01T12:00:00Z');
const day = (n: number) => new Date(SPEC_INDEX_FIXTURE_NOW - n * 86_400_000).toISOString();

let seq = 0;
function s(title: string, over: Partial<SpecIndexInput> = {}): SpecIndexInput {
  seq++;
  return {
    id: over.id ?? `fx-${seq}`, title, scope: 'feature', parentSpecId: null, status: 'approved',
    approvedRevision: 1, headRevision: 1, updatedAt: day(seq % 9), ...over,
  };
}
const area = (id: string, title: string) => s(title, { id, scope: 'domain', parentSpecId: 'fx-product' });
const draft = { status: 'draft', approvedRevision: null } as const;

export const SPEC_INDEX_FIXTURE_SPECS: SpecIndexInput[] = [
  s('Kitchen planner', { id: 'fx-product', scope: 'product' }),

  area('fx-recipes', 'Recipes'),
  s('Recipe import from a link', { parentSpecId: 'fx-recipes', filedBy: 'buildd' }),
  s('Scaling a recipe by servings', { parentSpecId: 'fx-recipes' }),
  s('Unit conversion', { id: 'fx-units', parentSpecId: 'fx-recipes', headRevision: 2 }),
  s('Metric and imperial switch', { parentSpecId: 'fx-units' }),
  s('Ingredient substitutions', { parentSpecId: 'fx-recipes', failing: 'a pinned task failed AC-4 (substitute keeps the allergen tag)' }),
  s('Step timers', { parentSpecId: 'fx-recipes' }),
  s('Recipe photos', { parentSpecId: 'fx-recipes', ...draft }),
  s('Printable recipe card', { parentSpecId: 'fx-recipes' }),
  s('Nutrition panel', { parentSpecId: 'fx-recipes', imported: true, ...draft }),

  area('fx-plans', 'Meal plans'),
  s('Weekly plan board', { parentSpecId: 'fx-plans' }),
  s('Leftovers carry forward', { parentSpecId: 'fx-plans', ...draft }),
  s('Plan from what is in the pantry', { parentSpecId: 'fx-plans' }),
  s('Household members and diets', { parentSpecId: 'fx-plans', failing: 'the design changed since approval' }),
  s('Plan sharing', { parentSpecId: 'fx-plans', ...draft }),
  s('Calendar export', { parentSpecId: 'fx-plans' }),

  area('fx-shopping', 'Shopping list'),
  s('List from a week of meals', { parentSpecId: 'fx-shopping' }),
  s('Aisle grouping', { parentSpecId: 'fx-shopping', imported: true, ...draft }),
  s('Shared list for a household', { parentSpecId: 'fx-shopping' }),
  s('Offline list', { parentSpecId: 'fx-shopping', ...draft }),

  area('fx-pantry', 'Pantry'),
  s('Barcode scan', { parentSpecId: 'fx-pantry' }),
  s('Use-by reminders', { parentSpecId: 'fx-pantry', ...draft }),
  s('Pantry stock levels', { parentSpecId: 'fx-pantry' }),

  area('fx-accounts', 'Accounts'),
  s('Sign in with email', { parentSpecId: 'fx-accounts' }),
  s('Delete my account', { parentSpecId: 'fx-accounts', imported: true, ...draft }),

  // Unfiled: one with an area to go under, two buildd thinks are a new area, two it could not place at all.
  s('Grocery delivery handoff', { id: 'fx-u1', ...draft, suggestion: { kind: 'parent', specId: 'fx-shopping', title: 'Shopping list', reason: 'Closest area by what it asks for' } }),
  s('Weekly digest email', { id: 'fx-u2', ...draft, suggestion: { kind: 'new_area', title: 'Notifications', reason: 'No area covers messages sent to people' } }),
  s('Push reminders to start cooking', { id: 'fx-u3', ...draft, suggestion: { kind: 'new_area', title: 'Notifications' } }),
  s('Accessibility statement', { id: 'fx-u4', ...draft }),
  s('Rate limits for the public API', { id: 'fx-u5' }),
];

/** One area: the map collapses to a line of words. */
export const SPEC_INDEX_ONE_AREA_FIXTURE: SpecIndexInput[] = [
  s('Runners', { id: 'fx1-area', scope: 'domain' }),
  ...Array.from({ length: 9 }, (_, i) => s(`Runner feature ${i + 1}`, { parentSpecId: 'fx1-area', ...(i % 3 === 0 ? draft : {}) })),
  s('Loose spec one', { ...draft }), s('Loose spec two', { ...draft }), s('Loose spec three'),
];

/** No area yet: the line says so and points at the taxonomy proposal. */
export const SPEC_INDEX_NO_AREA_FIXTURE: SpecIndexInput[] = Array.from({ length: 12 }, (_, i) => s(`Unplaced spec ${i + 1}`, i % 2 ? draft : {}));

/** The spec page's Related as a graph: a parent, two siblings and ten neighbours (the graph shows 8). */
export const SPEC_INDEX_GRAPH_FIXTURE = {
  spec: { id: 'fx-units', title: 'Unit conversion' },
  parent: { id: 'fx-recipes', title: 'Recipes' },
  siblings: [{ id: 'fx-scale', title: 'Scaling a recipe by servings' }, { id: 'fx-subs', title: 'Ingredient substitutions' }],
  nearby: [
    { specId: 'fx-n1', title: 'Nutrition panel', kind: 'overlaps' },
    { specId: 'fx-n2', title: 'Metric and imperial switch for the pantry', kind: 'shares_files' },
    { specId: 'fx-n3', title: 'Pantry stock levels', kind: 'shares_files' },
    { specId: 'fx-n4', title: 'Printable recipe card', kind: 'similar' },
    { specId: 'fx-n5', title: 'Aisle grouping', kind: 'similar' },
    { specId: 'fx-n6', title: 'Step timers', kind: 'similar' },
    { specId: 'fx-n7', title: 'Barcode scan', kind: 'similar' },
    { specId: 'fx-n8', title: 'Weekly plan board', kind: 'similar' },
    { specId: 'fx-n9', title: 'Calendar export', kind: 'similar' },
    { specId: 'fx-n10', title: 'Offline list', kind: 'similar' },
  ],
};
