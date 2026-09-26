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
    subjectKey: 'discrepancy:ws-1:docs/design/spec-conformance.md:code_ahead',
    chip: 'DISCREPANCY',
    discrepancyId: 'd-1',
    discrepancyIds: ['d-1'],
    specPath: 'docs/design/spec-conformance.md',
    assertionId: 'evaluate-spec-documents',
    assertionIds: ['evaluate-spec-documents'],
    direction: 'code_ahead',
    promotedMissionId: null,
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    cardAgeHours: 48,
    ...partial,
  };
}

/**
 * The CTA set per server state, pinned. A change that reintroduces a button
 * the server will reject — or drops the one affordance that can actually move
 * the row — fails here rather than in someone's hand at 393pt.
 */
function ctas(html: string): string[] {
  const found: string[] = [];
  for (const label of ['Dispatch doc fix', '>Promote<', 'Flip direction', '>Accept<', '>Accept the gap<', 'View mission']) {
    if (html.includes(label)) found.push(label.replace(/[<>]/g, ''));
  }
  return found;
}

describe('WaitingOnYouDiscrepancyCard', () => {
  it('renders the spec path, direction label and age', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item()} />);
    expect(html).toContain('docs/design/spec-conformance.md');
    expect(html).toContain('Code ahead · doc fix');
    expect(html).toContain('2 days old');
  });

  it('groups by spec path: shows the claim count and every assertion id behind it', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({
          discrepancyIds: ['d-1', 'd-2', 'd-3', 'd-4'],
          assertionIds: ['broker-daemon', 'broker-route', 'broker-migration', 'broker-tests'],
        })}
      />,
    );
    expect(html).toContain('4 claims');
    expect(html).toContain('broker-daemon');
    expect(html).toContain('broker-route');
    expect(html).toContain('broker-migration');
    expect(html).toContain('broker-tests');
  });

  it('a single-claim card says "1 claim", not "1 claims"', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item()} />);
    expect(html).toContain('1 claim<');
  });

  it('CTA set — code_ahead: Dispatch doc fix primary, Accept secondary, no Promote, no Flip', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'code_ahead' })} />);
    expect(ctas(html)).toEqual(['Dispatch doc fix', 'Accept']);
    // Dispatch is the filled button; Accept is outlined. The card names the
    // remedy, so the remedy is what the primary action does.
    expect(html).toMatch(/bg-accent[^"]*"[^>]*>Dispatch doc fix/);
  });

  it('CTA set — spec_ahead: Promote and Accept, unchanged (no dispatch: unbuilt work is not a doc fix)', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'spec_ahead' })} />);
    expect(ctas(html)).toEqual(['Promote', 'Accept']);
  });

  it('CTA set — contradicted: Flip direction and Accept, unchanged', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ direction: 'contradicted' })} />);
    expect(ctas(html)).toEqual(['Flip direction', 'Accept']);
    expect(html).toContain('Contradicted · needs your call');
  });

  it('CTA set — spec_ahead already promoted: the mission link replaces Promote', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ direction: 'spec_ahead', promotedMissionId: 'mission-42' })} />,
    );
    expect(ctas(html)).toEqual(['Accept', 'View mission']);
    expect(html).toContain('/app/missions/mission-42');
  });

  it('CTA set — doc fix in flight: no buttons at all, just the task to read', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({ chip: 'FIXING_SPEC', docFixTaskId: 'task-7', docFixTaskStatus: 'in_progress' })}
      />,
    );
    expect(ctas(html)).toEqual([]);
    expect(html).toContain('Fix in flight');
    expect(html).toContain('/app/tasks/task-7');
  });

  it('CTA set — doc fix shipped, rows still open, PR lifecycle unknown: Accept comes back as the one exit', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({ chip: 'FIXING_SPEC', docFixTaskId: 'task-7', docFixTaskStatus: 'completed' })}
      />,
    );
    // Truthful: nothing observed a merge, so the card says it does not know,
    // rather than claiming a re-run is pending.
    expect(html).toContain('Its PR state isn&#x27;t known yet');
    expect(html).not.toContain('re-run');
    // Nothing is running any more, and closure is still the checker's word — so
    // the card must not offer a second dispatch, and must not pretend the
    // finding is settled. But a docs PR that never merged would otherwise leave
    // this card agent-handled forever with no action on it at all, parking the
    // finding by accident. Accept is the exit, and it records a reason.
    expect(ctas(html)).toEqual(['Accept']);
  });

  it('CTA set — doc fix shipped, PR merged: no decision CTA, the re-run is a bounded wait not a stuck one', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({
          chip: 'FIXING_SPEC',
          docFixTaskId: 'task-7',
          docFixTaskStatus: 'completed',
          docFixPrLifecycleStatus: 'merged',
        })}
      />,
    );
    // No forced run was observed, so it says what WILL happen, not that one is
    // under way. A known merge is a bounded wait: the sweep dispatches the
    // re-run, which resolves the row or hands it to the follow-up — so Accept
    // must not be offered as a way to park it in between.
    expect(html).toContain('A conformance re-run is dispatched within the hour');
    expect(html).not.toContain('Waiting on the conformance re-run');
    expect(ctas(html)).toEqual([]);
  });

  it('CTA set — doc fix shipped, PR still open: names the real blocker, never claims a re-run is pending', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({
          chip: 'FIXING_SPEC',
          docFixTaskId: 'task-7',
          docFixTaskStatus: 'completed',
          docFixPrLifecycleStatus: 'open',
        })}
      />,
    );
    expect(html).not.toContain('Waiting on the conformance re-run');
    expect(html).toContain('Doc fix PR open');
  });

  it('CTA set — a released claim with no merged fix behind it reads exactly like a fresh code_ahead card', () => {
    // buildDiscrepancyItems released the claim server-side, so the card never
    // sees docFixTaskId/chip FIXING_SPEC. With no mergedDocFixTaskId either
    // (the merged case is pinned below), it renders the live CTA set.
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ chip: 'DISCREPANCY', direction: 'code_ahead' })} />,
    );
    expect(ctas(html)).toEqual(['Dispatch doc fix', 'Accept']);
    expect(html).not.toContain('Waiting on the conformance re-run');
  });

  it('CTA set — a doc fix already merged and the gap is still open: Accept only, never a second Dispatch', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({ chip: 'DISCREPANCY', direction: 'code_ahead', mergedDocFixTaskId: 'task-merged' })}
      />,
    );
    expect(ctas(html)).toEqual(['Accept the gap']);
    expect(html).toContain('/app/tasks/task-merged');
    expect(html).toContain('A doc fix merged');
  });

  // ── One pinned status line + CTA set per automation substate ──────────────

  const automated = (partial: Partial<ActionQueueItem>) =>
    renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ chip: 'FIXING_SPEC', docFixTaskId: 'task-7', ...partial })} />,
    );

  it('recheck_dispatched: names when the forced re-run went out, no CTA', () => {
    const html = automated({ docFixAutomation: 'recheck_dispatched', recheckDispatchedMinutesAgo: 12 });
    expect(html).toContain('Conformance re-run dispatched 12 min ago');
    expect(html).toContain('>Doc fix<');
    expect(ctas(html)).toEqual([]);
  });

  it('recheck_queued: never claims a run is in flight, no CTA', () => {
    const html = automated({ docFixAutomation: 'recheck_queued' });
    expect(html).not.toContain('dispatched 0');
    expect(html).not.toContain('Waiting on the conformance re-run');
    expect(html).toContain('dispatched within the hour');
    expect(ctas(html)).toEqual([]);
  });

  it('follow_up_queued: says a follow-up is being filed, no CTA (agents own it)', () => {
    const html = automated({ docFixTaskId: null, mergedDocFixTaskId: 'task-merged', docFixAutomation: 'follow_up_queued' });
    expect(html).toContain('Filing one follow-up fix');
    expect(html).toContain('/app/tasks/task-merged');
    expect(ctas(html)).toEqual([]);
  });

  it('follow_up_running: links the follow-up, no CTA', () => {
    const html = automated({ docFixTaskId: 'task-follow', docFixAutomation: 'follow_up_running' });
    expect(html).toContain('Follow-up doc fix in flight');
    expect(html).toContain('/app/tasks/task-follow');
    expect(ctas(html)).toEqual([]);
  });

  it('recheck_stalled: surfaces to the owner with what failed, and no Accept to launder it', () => {
    const html = automated({ chip: 'DISCREPANCY', docFixAutomation: 'recheck_stalled', docFixMergedHoursAgo: 9 });
    expect(html).toContain('>Discrepancy<');
    expect(html).toContain('Doc fix merged 9h ago, and no conformance re-run has checked it since');
    expect(html).toContain('Spec Discrepancy Ledger workflow');
    expect(ctas(html)).toEqual([]);
  });

  it('needs_owner: the evidence, not a bare Accept', () => {
    const html = automated({
      chip: 'DISCREPANCY',
      docFixTaskId: null,
      mergedDocFixTaskId: 'task-follow',
      docFixFollowUpTaskId: 'task-follow',
      docFixAutomation: 'needs_owner',
      lastCheckedHoursAgo: 2,
      declaredStatus: 'partially',
    });
    expect(html).toContain('A doc fix and one automatic follow-up merged');
    expect(html).toContain('still finds 1 claim passing while the doc declares &#x27;partially&#x27;');
    expect(html).toContain('skip_until');
    expect(html).toContain('data-testid="discrepancy-decision"');
    expect(ctas(html)).toEqual(['Accept the gap']);
  });

  it('the one decision left is the primary button; the task link is a quiet reference, not a second CTA', () => {
    // It used to read "Accept, or correct the assertion →" while opening the
    // task, and later an orange "Open the doc-fix task →" that still out-shouted
    // the grey Accept button under it.
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard
        item={item({ chip: 'DISCREPANCY', direction: 'code_ahead', mergedDocFixTaskId: 'task-merged' })}
      />,
    );
    expect(html).not.toContain('Accept, or correct the assertion');
    expect(html).not.toContain('Open the doc-fix task →');
    expect(html).toContain('See the doc fix');
    const accept = html.match(/<button[^>]*data-testid="discrepancy-accept"[^>]*>/)?.[0] ?? '';
    expect(accept).toContain('bg-accent');
    // The task link carries no accent colour of its own.
    const link = html.match(/<a[^>]*href="\/app\/tasks\/task-merged"[^>]*>/)?.[0] ?? '';
    expect(link).not.toContain('text-accent-text');
  });

  it('a long spec path wraps at any point without break-all, and the age separator is not a text glyph', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ specPath: 'docs/design/a-very-long-spec-document-name-that-overflows-a-phone.md' })} />,
    );
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).not.toContain('break-all');
    // A literal leading "·" wrapped onto its own line on a narrow card.
    expect(html).not.toMatch(/>· \d/);
  });

  it('orange action text uses the contrast-safe accent-text token, not text-primary', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouDiscrepancyCard item={item({ docFixTaskId: 'task-1', docFixTaskStatus: 'in_progress' })} />,
    );
    expect(html).toContain('Fix in flight');
    expect(html).not.toMatch(/(?<![-\w])text-primary(?![-\w])/);
    expect(html).toContain('text-accent-text');
  });

  it('renders nothing when the item carries no discrepancyId', () => {
    const html = renderToStaticMarkup(<WaitingOnYouDiscrepancyCard item={item({ discrepancyId: undefined })} />);
    expect(html).toBe('');
  });
});
