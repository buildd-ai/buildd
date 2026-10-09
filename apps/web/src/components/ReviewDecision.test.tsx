import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewDecision } from './ReviewDecision';

const LONG = 'Adds a new table with two foreign keys. The migration index collides with one already on the base branch, so the branch must be refreshed first. I did not run the tests.';

describe('ReviewDecision', () => {
  it('shows the decision and tags, and keeps the full reason folded', () => {
    const html = renderToStaticMarkup(
      <ReviewDecision
        decision="Approve the additive migration once the branch is refreshed."
        detail={LONG}
        blockers={[{ kind: 'migration', text: 'Adds a table' }, { kind: 'merge_conflict', text: 'Index collides' }]}
        status="CI running"
      />,
    );
    expect(html).toContain('Approve the additive migration once the branch is refreshed.');
    expect(html).toContain('migration');
    expect(html).toContain('merge conflict');
    expect(html).toContain('CI running');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('I did not run the tests.');
  });

  it('has no Details toggle when there is nothing more than the decision', () => {
    const html = renderToStaticMarkup(<ReviewDecision decision="Human approval required" detail="Human approval required" blockers={[]} />);
    expect(html).toContain('Human approval required');
    expect(html).not.toContain('aria-expanded');
  });

  it('never renders an em dash', () => {
    const html = renderToStaticMarkup(<ReviewDecision decision="Do it." detail={LONG} blockers={[]} status={null} />);
    expect(html).not.toContain('—');
  });
});
