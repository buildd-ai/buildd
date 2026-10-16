import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const {
  candidateAreaNames, candidateAreas, specListForState, taxonomyState, interpretName, namesToDrop, foldedTitle, assembleTaxonomy,
  proposeSpecTaxonomy, specTaxonomyKind, targetAreas, featureDigestOf, NAME_SLOTS, SPEC_LIST_CHARS, UNPLACED_P, MIN_AREAS, MAX_AREAS,
} = await import('./spec-taxonomy-decision');
const { specCard } = await import('./specs/card');
import type { TaxonomyItem } from './specs/areas';

const item = (specId: string, title: string, summary: string, domainHint: string | null = null): TaxonomyItem => ({
  specId, title, domainHint, card: specCard(title, `# ${title}\n${summary}\n- **AC-1** ${summary}\n`),
});

describe('candidate names', () => {
  it('lists domain values first, then nouns two titles share as plurals, then generic names, each once', () => {
    const names = candidateAreaNames([
      { title: 'Task Page', domain: 'billing' }, { title: 'Waiting task reservation', domain: 'billing' },
      { title: 'Runner login', domain: 'surfaces' }, { title: 'Runner presence', domain: null }, { title: 'Settings › Models', domain: null },
    ]);
    expect(names.slice(0, 3)).toEqual(['Billing', 'Runners', 'Tasks']);
    // `surfaces` names a kind of code, not a part of the product; a one-title word is not a name.
    expect(names).not.toContain('Surfaces');
    expect(names).not.toContain('Logins');
    expect(names).toContain('Platform and operations');
    // A generic name sharing a word with an earlier candidate is skipped ("Billing and cost" after "Billing").
    expect(names).not.toContain('Billing and cost');
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(NAME_SLOTS);
    expect(candidateAreas([{ title: 'Task one', domain: null }, { title: 'Task two', domain: null }]).slice(0, 2)).toEqual([{ name: 'Tasks', source: 'title' }, { name: 'Accounts and access', source: 'generic' }]);
  });

  it('never holds more than the slots, however many domain values there are', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `Spec ${i}`, domain: `domain${i}` }));
    expect(candidateAreaNames(many)).toHaveLength(NAME_SLOTS);
  });
});

describe('the state', () => {
  const specs = [{ title: 'Task Page', summary: 'The page for one task.', domain: null }, { title: 'Runner login', summary: 'A runner signs in.', domain: 'runners' }];

  it('holds every spec, the spec to place and the numbered names', () => {
    const s = taxonomyState({ specs, omitted: 0, focus: { title: 'Runner login', summary: 'A runner signs in.', domain: 'runners', criteria: ['AC-1: it signs in'] }, names: ['Tasks', 'Runners'] });
    expect(s).toContain('Specs in this workspace (2 shown):\n- Task Page: The page for one task.\n- Runner login: A runner signs in. (domain: runners)\n');
    expect(s).toContain('Spec to place: Runner login\nA runner signs in.\nThe repo file names its domain: runners (a hint only).\n- AC-1: it signs in\n');
    expect(s).toContain('Area names (2):\n[1] Tasks\n[2] Runners\n');
  });

  it('stops the spec list at the budget and says how many it left out', () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ title: `Spec number ${i}`, summary: 'x'.repeat(150), domain: null }));
    const { specs: shown, omitted } = specListForState(big);
    expect(shown.length + omitted).toBe(400);
    expect(omitted).toBeGreaterThan(0);
    const s = taxonomyState({ specs: shown, omitted, focus: { title: 'a', summary: 'b', domain: null, criteria: [] }, names: ['A', 'B'] });
    expect(s).toContain(`${omitted} more not shown`);
    expect(s.length).toBeLessThan(SPEC_LIST_CHARS + 1_500);
  });
});

describe('the decision kind', () => {
  it('is live under its own capability, measured on Jev only, with a slot per name and unsure', async () => {
    expect(specTaxonomyKind.kind).toBe('buildd.spec_taxonomy');
    expect(specTaxonomyKind.binding).toMatchObject({ capability: 'spec_taxonomy', mode: 'live' });
    const { isMeasuredForKind } = await import('@buildd/core/decision-kinds');
    expect(isMeasuredForKind(specTaxonomyKind.binding, 'typesafe/jev-1')).toBe(true);
    expect(isMeasuredForKind(specTaxonomyKind.binding, 'clef')).toBe(false);
    expect(Object.keys(specTaxonomyKind.questions.area.criteria)).toEqual([...Array.from({ length: NAME_SLOTS }, (_, i) => `name_${i + 1}`), 'unsure']);
  });

  it('a number past the list reads as unsure', () => {
    const f = { names: ['Tasks', 'Runners'] };
    expect(interpretName({ area: { choice: 'name_2', probabilities: { name_2: 0.9 } } }, f)).toMatchObject({ decision: 'name_2', confidence: 0.9 });
    expect(interpretName({ area: { choice: 'name_9', probabilities: { name_9: 0.99 } } }, f)).toMatchObject({ decision: 'unsure', reasonCode: 'model_out_of_list' });
  });

  it('aims for about 1.5 x the square root of the spec count, from four to eight areas', () => {
    expect([targetAreas(3), targetAreas(16), targetAreas(30), targetAreas(500)]).toEqual([MIN_AREAS, 6, 8, MAX_AREAS]);
  });
});

describe('grouping', () => {
  const picks = (xs: Array<[string, string | null, number]>) => new Map(xs.map(([specId, name, p]) => [specId, { specId, name, p }]));

  it('drops the smallest name first, a generic one before the workspace\'s own among single-spec groups', () => {
    const p = picks([['a', 'Tasks', 0.9], ['b', 'Tasks', 0.9], ['c', 'Runners', 0.5], ['d', 'Projects', 0.95]]);
    expect(namesToDrop(p, ['Tasks', 'Runners', 'Projects'], 2, new Set(['Projects']))).toEqual(['Projects']);
    expect(namesToDrop(p, ['Tasks', 'Runners', 'Projects'], 2)).toEqual(['Runners']);
    expect(namesToDrop(p, ['Tasks', 'Runners', 'Projects'], 3)).toEqual([]);
  });

  it('folds a dropped name into the title it joined, never past four words or a second "and"', () => {
    expect(foldedTitle('Tasks', 'Missions')).toBe('Tasks and missions');
    expect(foldedTitle('Auth', 'MCP')).toBe('Auth and MCP');
    expect(foldedTitle('Platform and operations', 'Releases')).toBe('Platform and operations');
    expect(foldedTitle('Developer tools', 'Data and storage')).toBe('Developer tools');
  });

  it('puts every spec in exactly one area or in unplaced, and a weak or unsure answer in unplaced', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, `Spec ${id}`, 'About it.'));
    const final = picks([['a', 'Tasks', 0.9], ['b', 'Tasks', 0.8], ['c', 'Runners', 0.7], ['d', 'Runners', UNPLACED_P - 0.01], ['e', null, 0.9]]);
    const p = assembleTaxonomy(items, { title: 'Shop' }, final, ['Tasks', 'Runners'], new Map([['Tasks', 'Tasks and missions']]));
    expect(p.areas.map((a) => [a.title, a.members.map((m) => m.specId)])).toEqual([['Tasks and missions', ['a', 'b']], ['Runners', ['c']]]);
    expect(p.unplaced!.map((u) => u.specId)).toEqual(['d', 'e']);
    const all = [...p.areas.flatMap((a) => a.members.map((m) => m.specId)), ...p.unplaced!.map((u) => u.specId)];
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(p.areas[0]!.charter).toBe('Specs about tasks and missions, such as "Spec a" and "Spec b".');
    expect(new Set(p.areas.map((a) => a.key)).size).toBe(2);
  });
});

describe('proposeSpecTaxonomy', () => {
  // Domain values give the names: three task specs, two mission specs, three runner and three settings specs, and a test spec.
  const items = [
    ...[1, 2, 3].map((i) => item(`t${i}`, `Task ${i}`, 'About a task.', 'tasks')),
    ...[1, 2].map((i) => item(`m${i}`, `Mission ${i}`, 'About a mission.', 'missions')),
    ...[1, 2, 3].map((i) => item(`r${i}`, `Runner ${i}`, 'About a runner.', 'runners')),
    ...[1, 2, 3].map((i) => item(`s${i}`, `Settings ${i}`, 'About settings.', 'settings')),
    item('x1', 'Test spec', 'A spec to try the editor.'),
  ];
  // A fake model: picks by the spec id's letter; a mission spec prefers "Missions" while it stands, else "Tasks".
  const want: Record<string, string[]> = { t: ['Tasks'], m: ['Missions', 'Tasks'], r: ['Runners'], s: ['Settings'] };
  const judge = (calls: string[][] = []) => async (f: any, specId: string) => {
    calls.push([specId, ...f.names]);
    const name = want[specId[0]!]?.find((n) => f.names.includes(n));
    return name
      ? { decision: `name_${f.names.indexOf(name) + 1}` as any, confidence: 0.9, source: 'model', fallbackCause: null, model: 'typesafe/jev-1' }
      : { decision: 'unsure' as const, confidence: 0.8, source: 'model', fallbackCause: null, model: 'typesafe/jev-1' };
  };

  it('asks every spec against the candidates and leaves the unsure one unplaced', async () => {
    const calls: string[][] = [];
    const r = await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: judge(calls) });
    if (!r.ran) throw new Error(r.reason);
    expect(r.model).toBe('typesafe/jev-1');
    // 12 specs aim for 5 areas; four names hold specs, so none is dropped.
    expect(r.proposal.areas.map((a) => a.title).sort()).toEqual(['Missions', 'Runners', 'Settings', 'Tasks']);
    expect(r.proposal.unplaced!.map((u) => u.specId)).toEqual(['x1']);
    // Domain values by frequency, ties alphabetical.
    expect(calls[0]!.slice(1, 5)).toEqual(['Runners', 'Settings', 'Tasks', 'Missions']);
    expect(new Set(calls.map((c) => c[0])).size).toBe(items.length);
  });

  it('past the target the smallest name goes; its specs, asked again, fold it into the title of the area they join', async () => {
    const calls: string[][] = [];
    const r = await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: judge(calls), target: 3 });
    if (!r.ran) throw new Error(r.reason);
    expect(r.proposal.areas.map((a) => [a.title, a.members.length])).toEqual([['Tasks and missions', 5], ['Runners', 3], ['Settings', 3]]);
    // The mission specs were asked again against the names still standing, without "Missions".
    const again = calls.filter((c) => c[0] === 'm1');
    expect(again).toHaveLength(2);
    expect(again[1]).not.toContain('Missions');
  });

  it('reuses an answer recorded for the same input, so the accept and the spec index see the dry run\'s proposal; cachedOnly never asks', async () => {
    // A dry run with the live model: remember each answer under the digest the ledger records it by.
    const recorded = new Map<string, { decision: string; confidence: number; model: string | null }>();
    const first = await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, {
      judge: async (f: any, id: string) => { const r = await judge()(f, id); recorded.set(featureDigestOf(f), { decision: r.decision, confidence: r.confidence!, model: r.model }); return r; },
    });
    if (!first.ran) throw new Error(first.reason);
    // The index page: only recorded answers, the ledger as the source, no team lookup failing it.
    const again = await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' }, cachedOnly: true }, { teamOf: async () => 'team', recorded: async () => recorded });
    expect(again).toEqual(first);
    // Nothing recorded yet: no model proposal, and nothing was asked.
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' }, cachedOnly: true }, { teamOf: async () => 'team', recorded: async () => new Map() }))
      .toEqual({ ran: false, reason: 'no model proposal yet: run organize to ask the decision model' });
  });

  it('does not run when the first answer is not a model\'s, and says why; nor when most answers fail', async () => {
    const fb = (cause: string) => async () => ({ decision: 'unsure' as const, confidence: null, source: 'fallback', fallbackCause: cause, model: null });
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: fb('no_provider') })).toEqual({ ran: false, reason: 'this team has no decision-model key' });
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: fb('unmeasured_model') })).toMatchObject({ ran: false, reason: expect.stringContaining('not measured') });
    let n = 0;
    const flaky = async (f: any, id: string) => (n++ === 0 ? judge()(f, id) : fb('provider_failure')());
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: flaky })).toMatchObject({ ran: false });
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items, product: { title: 'Shop' } }, { judge: async () => { throw new Error('boom'); } })).toEqual({ ran: false, reason: 'the taxonomy proposal failed' });
    expect(await proposeSpecTaxonomy({ workspaceId: 'ws', items: items.slice(0, 1), product: { title: 'Shop' } }, { judge: judge() })).toMatchObject({ ran: false });
  });
});
