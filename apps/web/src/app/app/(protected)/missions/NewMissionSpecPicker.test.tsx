/**
 * Choosing the specs a new mission makes true (Living Specs D-41).
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/missions',
  useSearchParams: () => new URLSearchParams('new=1'),
}));

const { ChosenSpecList, choosableSpecs, chosenProblem, outcomeSpecPayload, pinnedRevisionOf, default: NewMissionSpecPicker } = await import('./NewMissionSpecPicker');
const { changedCriteria } = await import('@/lib/specs/selection-scope');

const spec = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Spec ${id}`, status: 'approved', headRevision: 4, approvedRevision: 3, ...over });

describe('the new-mission spec choice', () => {
  it('pins the approved revision, else the head', () => {
    expect(pinnedRevisionOf(spec('a'))).toBe(3);
    expect(pinnedRevisionOf(spec('a', { approvedRevision: null }))).toBe(4);
  });

  it('offers neither retired, superseded nor already chosen specs', () => {
    const all = [spec('a'), spec('b', { status: 'retired' }), spec('c', { status: 'superseded' }), spec('d', { status: 'draft' })];
    const chosen = [{ specId: 'a', title: 'A', revision: 3, requirements: 'all' as const }];
    expect(choosableSpecs(all, chosen).map((s) => s.id)).toEqual(['d']);
  });

  it('sends one entry per spec, pinned at the revision it showed, and nothing when none is chosen', () => {
    expect(outcomeSpecPayload([])).toBeUndefined();
    expect(outcomeSpecPayload([
      { specId: 'a', title: 'A', revision: 3, requirements: [{ id: 'R-1', text: 'x' }] },
      { specId: 'b', title: 'B', revision: 1, requirements: 'all' },
    ])).toEqual([{ specId: 'a', revision: 3 }, { specId: 'b', revision: 1 }]);
  });

  it('flags a revision that adds or changes nothing, which the server would refuse', () => {
    expect(chosenProblem({ specId: 'a', title: 'A', revision: 3, requirements: [] })).toContain('adds or changes no requirement');
    expect(chosenProblem({ specId: 'a', title: 'A', revision: 3, requirements: null })).toBeNull();
    expect(chosenProblem({ specId: 'a', title: 'A', revision: 3, requirements: null, error: 'Could not reach buildd.' })).toBe('Could not reach buildd.');
  });

  it('lists the requirements the revision adds or changes under their spec', () => {
    const requirements = changedCriteria([
      { kind: 'added', id: 'R-17', text: 'Requirements grouped by spec', section: 'Verify' },
      { kind: 'removed', id: 'R-9', oldText: 'gone', section: 'Verify' },
    ] as any);
    const html = renderToStaticMarkup(<ChosenSpecList chosen={[
      { specId: 'a', title: 'Navigation', revision: 4, requirements },
      { specId: 'b', title: 'Product voice', revision: 1, requirements: 'all' },
    ]} onRemove={() => {}} />);
    expect(html).toContain('This mission makes these requirements true:');
    expect(html).toContain('From Navigation');
    expect(html).toContain('R-17');
    expect(html).toContain('Requirements grouped by spec');
    expect(html).not.toContain('R-9');
    expect(html).toContain('From Product voice');
    expect(html).toContain('All of its requirements');
  });

  it('asks for a workspace before offering specs', () => {
    const html = renderToStaticMarkup(<NewMissionSpecPicker workspaceId="" chosen={[]} onChange={() => {}} />);
    expect(html).toContain('Choose a workspace');
    expect(html).not.toContain('new-mission-spec-select');
  });
});
