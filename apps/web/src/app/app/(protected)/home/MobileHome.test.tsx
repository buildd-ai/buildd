import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { MobileHome } = await import('./MobileHome');
const { deriveHomeAttention: derive } = await import('@/lib/home-attention');
const { isActionableChip } = await import('@/lib/action-queue');
const deriveHomeAttention = (input: Omit<Parameters<typeof derive>[0], 'isActionable'>) => derive({ ...input, isActionable: isActionableChip });
const { projectMissionDelivery, selectHomeMilestones } = await import('@/lib/delivery-projection');
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
const render = (items = deriveHomeAttention({ queue: [], questions: [], held: [], missions: [] })) => renderToStaticMarkup(<MobileHome items={items} ask={<form data-testid="ask" />} counts={counts} milestones={selectHomeMilestones(deliveries)} quietMissions={2} shipped={[]} />);
describe('phone Home inbox', () => {
  it('zero Needs you is one quiet line, then 3 missions moving toward delivery', () => {
    const html = render();
    expect(html).toContain('phone-all-clear');
    expect(html).toContain('All clear.');
    // No empty Needs you section, no shipped placeholder, no worker rows.
    expect(html).not.toContain('>Needs you<');
    expect(html).not.toContain('Nothing shipped today');
    expect(html).not.toContain('In flight');
    expect(html.indexOf('phone-all-clear')).toBeLessThan(html.indexOf('data-testid="ask"'));
    expect(html.match(/data-testid="home-delivery-row"/g)).toHaveLength(3);
    // Closest to a milestone first; the waiting mission never appears.
    expect(html.indexOf('First-run checklist')).toBeLessThan(html.indexOf('Typo-tolerant search'));
    expect(html.indexOf('Typo-tolerant search')).toBeLessThan(html.indexOf('Quarantine flaky tests'));
    expect(html).not.toContain('Runner on arm64');
    expect(html).toContain('1 of 2 landed');
    expect(html).toContain('not yet on trunk');
    expect(html).toContain('11 open missions');
  });
  it('separates agents, slots and open missions in the count line', () => {
    expect(render()).toContain('1 agent working · 1/4 slots · 11 open missions');
  });
  it('names what is not listed when something does need you', () => {
    const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'd', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Keep the old route?' }], questions: [], held: [], missions: [] }));
    expect(html).not.toContain('phone-all-clear');
    expect(html).toContain('Not listed here: 2 missions waiting on capacity');
  });
  it('a systemic failure shows once, apart and first', () => {
    const failed = (id: string, title: string) => ({ subjectKey: id, chip: 'FAILED' as const, taskId: id, taskTitle: title, failureMessage: 'The agent has no working model key.', fixHref: '/app/settings/providers', fixLabel: 'Fix key' });
    const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'd', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Keep the old route?' }, failed('t1', 'Alpha'), failed('t2', 'Beta'), failed('t3', 'Gamma')], questions: [], held: [], missions: [] }));
    expect(html.match(/data-systemic="true"/g)).toHaveLength(1);
    expect(html).toContain('systemic · failed');
    expect(html).toContain('3 affected');
    expect(html.indexOf('data-systemic')).toBeLessThan(html.indexOf('Keep the old route?'));
    expect(html).toContain('2 things need you.');
  });
  it('uses one card frame, ink ready marker, and guarded merge action', () => {
    const items = deriveHomeAttention({ queue: [{ subjectKey: 'ready', chip: 'MERGE', prNumber: 7, workspaceId: 'example', taskTitle: 'A change', prUrl: 'https://github.com/example/project/pull/7', missionMergeBlockedReason: 'Other work is still running.' }], questions: [], held: [], missions: [] });
    const html = render(items);
    expect(html).toContain('1 thing needs you.');
    expect(html).toContain('1 open');
    expect(html).toContain('phone-needs-you-card');
    expect(html).toMatch(/h-2 w-2 shrink-0 bg-text-primary/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Merge/);
    expect(html).toContain('Other work is still running.');
    expect(html).not.toContain('past the');
  });
});

it('human review links to GitHub with machine status and no merge button', () => {
  const html = render(deriveHomeAttention({ queue: [{ subjectKey: 'review', chip: 'REVIEW', prNumber: 7, workspaceId: 'example', taskTitle: 'A change', prUrl: 'https://github.com/example/project/pull/7', humanReview: { label: 'Approve on GitHub', reason: 'Review required · protected migration paths' }, machineStatus: 'CI running' }], questions: [], held: [], missions: [] }));
  expect(html).toContain('Approve on GitHub');
  expect(html).toContain('CI running');
  expect(html).toContain('/pull/7/files');
  expect(html).not.toMatch(/>Merge<|>Merge anyway</);
});

it('renders a mixed list with named actions, concrete reasons and no generic fallbacks', () => {
  const html = render(deriveHomeAttention({ queue: [
    { subjectKey: 'a', chip: 'DECIDE', missionId: 'mission-a', escalationReason: 'Pick a rollout order' },
    { subjectKey: 'b', chip: 'REVIEW', prNumber: 8, workspaceId: 'example', taskTitle: 'Another change', prUrl: 'https://github.com/example/project/pull/8', humanReview: { label: 'Review PR', reason: 'Review required · protected migration paths' } },
    { subjectKey: 'c', chip: 'DECIDE' },
  ], questions: [], held: [], missions: [] }));
  expect(html).toContain('2 things need you.');
  expect(html).toContain('1 decision · 1 review');
  expect(html).toContain('Pick a rollout order');
  expect(html).toContain('>Choose…<');
  expect(html).toContain('Review required · protected migration paths');
  for (const bad of ['Open decision', 'Work needs a decision', '/app/health', 'Nothing else is blocking it']) expect(html).not.toContain(bad);
});
