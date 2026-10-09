import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { HomeBody } = await import('./HomeBody');
const { deriveHomeAttention: derive } = await import('@/lib/home-attention');
const { isActionableChip } = await import('@/lib/action-queue');
const deriveHomeAttention = (input: Omit<Parameters<typeof derive>[0], 'isActionable'>) => derive({ ...input, isActionable: isActionableChip });
const { projectMissionDelivery: project, selectHomeMilestones } = await import('@/lib/delivery-projection');
const missionHelpers = await import('@buildd/core/mission-helpers');
const projectMissionDelivery = (m: Parameters<typeof project>[0]) => project(m, missionHelpers);
const PR = 'https://github.com/example/project/pull/1';
const deliveries = [
  projectMissionDelivery({ id: 'm-audit', title: 'Typo-tolerant search', status: 'active', href: '/app/missions/m-audit', tasks: [
    { id: 'a1', title: 'Index', status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z' }] },
    { id: 'a2', title: 'Trigram query', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_running' }] },
  ] }),
  projectMissionDelivery({ id: 'm-build', title: 'Billing exports', status: 'active', href: '/app/missions/m-build', tasks: [{ id: 'b1', title: 'CSV writer', status: 'assigned', workers: [{ status: 'running' }] }] }),
  projectMissionDelivery({ id: 'm-repair', title: 'Quarantine flaky tests', status: 'active', href: '/app/missions/m-repair', tasks: [{ id: 'c1', title: 'Loader', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] }] }),
  projectMissionDelivery({ id: 'm-trunk', title: 'First-run checklist', status: 'active', href: '/app/missions/m-trunk', integrationBranch: true, tasks: [{ id: 'd1', title: 'Checklist', status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z' }] }] }),
  projectMissionDelivery({ id: 'm-wait', title: 'Runner on arm64', status: 'active', href: '/app/missions/m-wait', tasks: [{ id: 'e1', title: 'Arm build', status: 'pending', workers: [] }] }),
];
const counts = { openMissions: 11, executingMissions: 1, liveAgents: 1, slots: { used: 1, total: 4 } };
const render = (items = deriveHomeAttention({ queue: [], questions: [], held: [], missions: [] })) => renderToStaticMarkup(<HomeBody items={items} ask={<form data-testid="ask" />} counts={counts} milestones={selectHomeMilestones(deliveries)} quietMissions={2} shipped={[]} />);
describe('Home inbox', () => {
  it('zero Needs you is one quiet line, then 3 missions moving toward delivery', () => {
    const html = render();
    expect(html).toContain('home-all-clear');
    expect(html).toContain('All clear.');
    // No empty Needs you section, no shipped placeholder, no worker rows.
    expect(html).not.toContain('>Needs you<');
    expect(html).not.toContain('Nothing shipped today');
    expect(html).not.toContain('In flight');
    expect(html.indexOf('home-all-clear')).toBeLessThan(html.indexOf('data-testid="ask"'));
    expect(html.match(/data-testid="home-delivery-row"/g)).toHaveLength(3);
    // Closest to a milestone first; the waiting mission never appears.
    expect(html.indexOf('First-run checklist')).toBeLessThan(html.indexOf('Typo-tolerant search'));
    expect(html.indexOf('Typo-tolerant search')).toBeLessThan(html.indexOf('Quarantine flaky tests'));
    expect(html).not.toContain('Runner on arm64');
    expect(html).toContain('1 of 2 landed');
    expect(html).toContain('not yet on trunk');
    expect(html).toContain('11 open missions');
  });
  it('delivery rows are a hairline list: no card frame, no tone edge, the full title, one status line', () => {
    const html = render();
    const rows = html.split('data-testid="home-delivery-row"').slice(1).map(r => r.slice(0, r.indexOf('</a>')));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).not.toMatch(/border-l-4|border-l-status|bg-\[var\(--chat-surface\)\]/);
      expect(r).not.toContain('line-clamp-2');
      // The phase is named once: the word, not the word and a Build › Audit › Land track again.
      expect(r.match(/data-testid="delivery-chip"/g)).toHaveLength(1);
      expect(r).not.toContain('Stage:');
    }
    // An exception replaces the evidence it would repeat.
    const trunk = rows.find(r => r.includes('First-run checklist'))!;
    expect(trunk).toContain('not yet on trunk');
    expect(trunk).not.toContain('Every task landed on the mission branch.');
  });
  it('a shipped mission names its span as filed to shipped, not "open"', () => {
    const shipped = [{ id: 's', title: 'Done thing', href: '/app/missions/s', completedAt: '2026-10-09T10:00:00Z', prs: 1, fixes: 0, durationMs: 46 * 3_600_000, activeMs: 40 * 60_000, criteria: null }];
    const html = renderToStaticMarkup(<HomeBody items={[]} ask={null} counts={counts} milestones={[]} quietMissions={0} shipped={shipped} />);
    expect(html).toContain('1d 22h');
    expect(html).toContain('to ship');
    expect(html).toContain('agent work');
    expect(html).toContain('PR merged');
    expect(html).not.toMatch(/>open</);
  });
  it('separates agents, slots and open missions in the count line', () => {
    expect(render()).toContain('1 agent working · 1/4 slots · 11 open missions');
  });
  it('names what is not listed when something does need you', () => {
    const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'd', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Keep the old route?' }], questions: [], held: [], missions: [] }));
    expect(html).not.toContain('home-all-clear');
    expect(html).toContain('2 more missions are waiting on capacity or another mission.');
    expect(html).not.toContain('Not listed here');
    expect(html).not.toContain('on their own');
  });
  it('a systemic failure shows once, apart and first', () => {
    const failed = (id: string, title: string) => ({ subjectKey: id, chip: 'FAILED' as const, taskId: id, taskTitle: title, failureMessage: 'The agent has no working model key.', fixHref: '/app/settings/providers', fixLabel: 'Fix key' });
    const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'd', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Keep the old route?' }, failed('t1', 'Alpha'), failed('t2', 'Beta'), failed('t3', 'Gamma')], questions: [], held: [], missions: [] }));
    expect(html.match(/data-systemic="true"/g)).toHaveLength(1);
    expect(html).toContain('Systemic · failed');
    expect(html).toContain('3 affected');
    expect(html.indexOf('data-systemic')).toBeLessThan(html.indexOf('Keep the old route?'));
    expect(html).toContain('2 things need you.');
  });
  it('uses one card frame and a guarded merge action', () => {
    const items = deriveHomeAttention({ queue: [{ subjectKey: 'ready', chip: 'MERGE', prNumber: 7, workspaceId: 'example', taskTitle: 'A change', prUrl: 'https://github.com/example/project/pull/7', missionMergeBlockedReason: 'Other work is still running.' }], questions: [], held: [], missions: [] });
    const html = render(items);
    expect(html).toContain('1 thing needs you.');
    expect(html).toContain('1 open');
    expect(html).toContain('data-testid="needs-you-card"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Merge/);
    expect(html).toContain('Other work is still running.');
    expect(html).not.toContain('past the');
  });
});

it('human review links to GitHub with machine status and no merge button', () => {
  const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'review', chip: 'REVIEW', prNumber: 7, workspaceId: 'example', taskTitle: 'A change', prUrl: 'https://github.com/example/project/pull/7', humanReview: { label: 'Approve on GitHub', reason: 'Protected migration paths changed. More detail.', decision: 'Protected migration paths changed.', blockers: [] }, machineStatus: 'CI running' }], questions: [], held: [], missions: [] }));
  expect(html).toContain('Approve on GitHub');
  expect(html).toContain('CI running');
  expect(html).toContain('/pull/7/files');
  expect(html).not.toMatch(/>Merge<|>Merge anyway</);
});

it('renders a mixed list with named actions, concrete reasons and no generic fallbacks', () => {
  const html = render(deriveHomeAttention({ queue: [
    { subjectKey: 'a', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Pick a rollout order' },
    { subjectKey: 'b', chip: 'REVIEW', prNumber: 8, workspaceId: 'example', taskTitle: 'Another change', prUrl: 'https://github.com/example/project/pull/8', humanReview: { label: 'Review PR', reason: 'Protected migration paths changed. More detail.', decision: 'Protected migration paths changed.', blockers: [] } },
    { subjectKey: 'c', chip: 'DECIDE' },
  ], questions: [], held: [], missions: [] }));
  expect(html).toContain('2 things need you.');
  expect(html).toContain('1 decision · 1 review');
  expect(html).toContain('Pick a rollout order');
  expect(html).toContain('>Choose…<');
  expect(html).toContain('Protected migration paths changed.');
  for (const bad of ['Open decision', 'Work needs a decision', '/app/health', 'Nothing else is blocking it']) expect(html).not.toContain(bad);
});

// Surface audit: with no runner the phone hid Get started and said
// "The fleet is working without you." It shows the next step instead.
it('a team with no runner sees the getting-started step, not "working without you"', () => {
  const html = renderToStaticMarkup(<HomeBody items={[]} ask={null} setup={<section data-testid="getting-started">Connect a runner</section>} runnerConnected={false} counts={{ openMissions: 0, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 0 } }} milestones={[]} quietMissions={0} shipped={[]} />);
  expect(html).toContain('data-testid="getting-started"');
  expect(html).toContain('Connect a runner');
  expect(html).not.toContain('working without you');
  expect(html).toContain('No runner is connected yet');
  // The checklist is the next step; the "All clear" reassurance would contradict it.
  expect(html).not.toContain('All clear');
  expect(html.indexOf('getting-started')).toBeLessThan(html.indexOf('See everything in motion'));
});

// Owner acceptance (Oct 9): the phone said "8 things need you" over brutalist
// cards while desktop said "7 decisions need you" over a different mosaic. One
// list now: the same derived queue, the same card, the same count, every width.
describe('one decisions list at every width', () => {
  const pr = (n: number) => `https://github.com/example/project/pull/${n}`;
  const queue = [
    { subjectKey: 'm', chip: 'MERGE' as const, prNumber: 1, workspaceId: 'ws', taskTitle: 'Ready change', prUrl: pr(1) },
    { subjectKey: 'f', chip: 'BLOCKED' as const, prNumber: 2, workspaceId: 'ws', taskTitle: 'Red change', prUrl: pr(2), ciGate: { kind: 'blocked' as const } },
    ...[3, 4, 5, 6].map(n => ({ subjectKey: `r${n}`, chip: 'REVIEW' as const, prNumber: n, workspaceId: 'ws', taskTitle: `Review ${n}`, prUrl: pr(n), humanReview: { label: 'Review PR', reason: 'Protected paths changed. The migration renames a column and drops an index.', decision: 'Protected paths changed.', blockers: [] }, machineStatus: 'CI running' })),
    { subjectKey: 'd', chip: 'DECIDE' as const, missionId: 'mission-a', escalationReason: 'Pick a rollout order' },
    { subjectKey: 'a', chip: 'APPROVE' as const, taskId: 't-a', taskTitle: 'Plan to approve' },
  ];
  const items = deriveHomeAttention({ queue, questions: [], held: [], missions: [] });
  const shipped = [{ id: 's', title: 'Shipped thing', href: '/app/missions/s', completedAt: '2026-10-09T10:00:00Z', prs: 2, fixes: 0, durationMs: 3_600_000, activeMs: 3_600_000, criteria: null }];
  const html = renderToStaticMarkup(<HomeBody items={items} ask={null} counts={counts} milestones={[]} quietMissions={7} shipped={shipped} />);
  const cards = html.match(/data-testid="needs-you-card"/g) ?? [];

  it('the headline count, the list count and the cards are one number', () => {
    expect(items).toHaveLength(8);
    expect(cards).toHaveLength(8);
    expect(html).toContain('8 things need you.');
    expect(html).toContain('>8 open<');
  });

  it('renders at every width: nothing in it is phone-only or desktop-only', () => {
    expect(html).not.toMatch(/class="[^"]*\bmd:hidden\b/);
    expect(html).not.toMatch(/class="[^"]*(^|\s)hidden md:/);
    // Stacked on a phone, side by side from ~320px each on desktop.
    expect(html).toContain('[grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]');
  });

  it('every card is the L3 decision frame with a charcoal primary: no shadow, no 2px frame, no filled orange', () => {
    const list = html.slice(html.indexOf('data-testid="needs-you-cards"'), html.indexOf('data-testid="just-shipped"'));
    for (const c of list.split('data-testid="needs-you-card"').slice(1)) {
      const open = c.slice(0, c.indexOf('>'));
      expect(open).toContain('card-decision');
      expect(open).not.toMatch(/shadow-\[|border-2|border-l-\[/);
    }
    expect(list).not.toMatch(/\bbg-accent\b|text-\[var\(--on-accent\)\]/);
    expect(list).toContain('btn btn-ink');
    expect(list).not.toMatch(/<h3[^>]*font-mono/);
  });

  it('a review card is the ReviewDecision structure: one decision line, fact tags, Details folded', () => {
    const review = html.slice(html.indexOf('Review 3'));
    expect(review).toContain('data-testid="review-decision"');
    expect(review).toContain('Protected paths changed.');
    expect(review).toContain('CI running');
    expect(review).toContain('Details');
  });

  it('just shipped renders once, as a quiet row after the list, never as a tile among the decisions', () => {
    expect(html.match(/Shipped thing/g)).toHaveLength(1);
    const list = html.slice(html.indexOf('data-testid="needs-you-cards"'), html.indexOf('data-testid="just-shipped"'));
    expect(list).not.toContain('Shipped thing');
    expect(html.indexOf('data-testid="just-shipped"')).toBeGreaterThan(html.indexOf('data-testid="needs-you-cards"'));
  });

  it('names the hidden missions plainly', () => {
    expect(html).toContain('7 more missions are waiting on capacity or another mission.');
  });

  it('one waiting mission reads in the singular', () => {
    const one = renderToStaticMarkup(<HomeBody items={items} ask={null} counts={counts} milestones={[]} quietMissions={1} shipped={[]} />);
    expect(one).toContain('1 more mission is waiting on capacity or another mission.');
  });

  it('a merge card carries the MergeAdvice line', () => {
    const withAdvice = deriveHomeAttention({ queue: [{ ...queue[0], mergeAdvice: { prNumber: 1, workspaceId: 'ws', token: null, unavailable: null, advice: { decision: 'merge_now', source: 'rule', reasonCode: 'blocked', line: 'Safe to merge as-is.', recorded: true, model: null, at: '2026-10-09T10:00:00Z' } } } as never], questions: [], held: [], missions: [] });
    const out = renderToStaticMarkup(<HomeBody items={withAdvice} ask={null} counts={counts} milestones={[]} quietMissions={0} shipped={[]} />);
    expect(out).toContain('data-testid="merge-advice-line"');
    expect(out).toContain('Safe to merge as-is.');
  });
});

describe('Home page composes one list', () => {
  it('page.tsx renders HomeBody once and none of the old desktop decision or diagnostic surfaces', async () => {
    const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
    expect(page.match(/<HomeBody\b/g)).toHaveLength(1);
    for (const gone of ['<NeedsYouStack', '<ActionQueueCard', '<ActivityTicker', '<ReleaseWidget', 'waiting-in-flight', 'homeHeadlineSentence(', '<MobileHome']) {
      expect(page).not.toContain(gone);
    }
  });
});
