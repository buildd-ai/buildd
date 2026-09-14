import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionQueueItem } from '@/lib/action-queue';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { WaitingOnYouDiscrepancyCard } = await import('./WaitingOnYouDiscrepancyCard');

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'discrepancy:docs/design/spec-conformance.md:evaluate-spec-documents',
    chip: 'DISCREPANCY',
    discrepancyId: 'd-1',
    specPath: 'docs/design/spec-conformance.md',
    assertionId: 'evaluate-spec-documents',
    direction: 'code_ahead',
    promotedMissionId: null,
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    cardAgeHours: 48,
    ...partial,
  };
}

describe('WaitingOnYouDiscrepancyCard', () => {
  it('renders the spec path, assertion id and direction label', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item()} />);
    expect(html).toContain('docs/design/spec-conformance.md');
    expect(html).toContain('evaluate-spec-documents');
    expect(html).toContain('Code ahead — doc fix');
    expect(html).toContain('2 days old');
  });

  it('code_ahead: offers Accept but never Promote (only spec_ahead is promotable per §8)', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'code_ahead' })} />);
    expect(html).toContain('Accept');
    expect(html).not.toContain('>Promote<');
    expect(html).not.toContain('Flip direction');
  });

  it('spec_ahead: offers Promote', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'spec_ahead' })} />);
    expect(html).toContain('>Promote<');
    expect(html).not.toContain('Flip direction');
  });

  it('contradicted: offers Flip direction but never Promote — flip is the only path off contradicted', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'contradicted' })} />);
    expect(html).toContain('Flip direction');
    expect(html).not.toContain('>Promote<');
    expect(html).toContain('Contradicted — needs a call');
  });

  it('a promoted row shows a link to the mission instead of a promote action', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ direction: 'spec_ahead', promotedMissionId: 'mission-42' })} />,
    );
    expect(html).toContain('/app/missions/mission-42');
    expect(html).toContain('View mission');
    expect(html).not.toContain('>Promote<');
  });

  it('renders nothing when the item carries no discrepancyId', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ discrepancyId: undefined })} />);
    expect(html).toBe('');
  });
});
