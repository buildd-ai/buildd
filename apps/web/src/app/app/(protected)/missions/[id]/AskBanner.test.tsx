/** The card above History: one link to the exact task, naming what waits and why. */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { AskBanner } = await import('./MissionBoard');
const { default: MissionFeedLayout } = await import('./MissionFeedLayout');
const { boardFixture } = await import('@/lib/mission-board.fixtures');

const base = Object.values(boardFixture('running').tasks)[0];
const merge = {
  ...base, waitingFor: null, waitStartedAt: 1_000, title: 'feat(kernel): Fold retries into the delivery',
  pr: { number: 7, url: null, state: 'open' as const },
  kernelReason: 'Checks passed and the review approved; merging is your call.',
  delivery: { label: 'Ready to merge', needsYou: true } as never,
};

describe('AskBanner without a question', () => {
  const html = renderToStaticMarkup(<AskBanner task={merge} now={61_000} href="/app/missions/mission-1?task=abc" />);

  it('is one link to the exact task, titled from the task', () => {
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/app\/missions\/mission-1\?task=abc"[^>]*>Fold retries into the delivery<\/a>/);
  });

  it('names what is waiting, why, and for how long', () => {
    expect(html).toContain('Ready to merge · PR #7');
    expect(html).toContain('merging is your call');
    expect(html).toContain('Waiting 1m');
    expect(html).not.toContain('Waiting on you');
  });

  it('stays a plain card when given no destination', () => {
    expect(renderToStaticMarkup(<AskBanner task={merge} now={61_000} />)).not.toContain('<a ');
  });
});

describe('the Feed with nothing for a person to do', () => {
  it('says what the mission is doing and never "Waiting on you"', () => {
    const model = { ...boardFixture('running'), needsYou: [] };
    const html = renderToStaticMarkup(<MissionFeedLayout model={model} missionId="mission-1" timeZone="UTC" />);
    expect(html).toMatch(/data-testid="history-run-state"[^>]*>Nothing needs you\./);
    expect(html).not.toContain('Waiting on you');
    expect(html).not.toContain('needs-you-band');
  });
});
