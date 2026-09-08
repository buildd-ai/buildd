import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingOnYouDecideCard } from './WaitingOnYouDecideCard';
import type { ActionQueueItem } from '@/lib/action-queue';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'decide:mission-1:fp1',
    chip: 'DECIDE',
    missionId: 'mission-1',
    missionTitle: 'Payments rollout',
    noteId: 'note-1',
    noteTitle: 'Goal criteria blocked — owner decision needed',
    ...partial,
  };
}

describe('WaitingOnYouDecideCard', () => {
  it('renders exactly one filled (CTA) button, linking to the mission', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDecideCard item={item()} />);
    // The primary CTA is a filled/status-colored link — count anchors with an
    // href into the mission, there must be exactly one actionable link.
    const missionLinkMatches = html.match(/href="\/app\/missions\/mission-1"/g) ?? [];
    expect(missionLinkMatches).toHaveLength(1);
    expect(html).toContain('Decide →');
    expect(html).toContain('Payments rollout');
  });

  it('surfaces the failure-pattern recommendation without selecting an exit', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDecideCard
        item={item({
          recommendation: 'The same machine-checked criterion has failed unchanged across every retry — the work it names likely has no owner.',
        })}
      />,
    );
    expect(html).toContain('Agent recommends:');
    expect(html).toContain('the work it names likely has no owner');
    // No exit-specific affordance (file/fix/waive) exists on this card at all —
    // those live on the mission-detail decision sheet, not here.
    expect(html).not.toContain('File the work');
    expect(html).not.toContain('Fix the criterion');
    expect(html).not.toContain('Waive and complete');
  });

  it('stays quiet when there is no recommendation yet', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDecideCard item={item()} />);
    expect(html).not.toContain('Agent recommends');
  });
});
