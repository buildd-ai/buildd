import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { MobileHome } = await import('./MobileHome');
const { deriveHomeAttention: derive } = await import('@/lib/home-attention');
const { isActionableChip } = await import('@/lib/action-queue');
const deriveHomeAttention = (input: Omit<Parameters<typeof derive>[0], 'isActionable'>) => derive({ ...input, isActionable: isActionableChip });
const render = (items = deriveHomeAttention({ queue: [], questions: [], held: [], missions: [] })) => renderToStaticMarkup(<MobileHome items={items} ask={<form data-testid="ask" />} live={2} capacity={4} mergedToday={3} inCi={1} shipped={[]} flight={Array.from({ length: 6 }, (_, i) => ({ key: String(i), title: `Working ${i}`, agent: 'Builder', href: `/app/tasks/task-${i}`, age: '2m', fixing: false }))} />);
describe('phone Home inbox', () => {
  it('orders the ask, needs you, shipped, and at most four flight rows', () => {
    const html = render();
    expect(html.indexOf('data-testid="ask"')).toBeLessThan(html.indexOf('Needs you'));
    expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('Just shipped'));
    expect(html.indexOf('Just shipped')).toBeLessThan(html.indexOf('In flight'));
    expect(html).toContain('Working 3');
    expect(html).not.toContain('Working 4');
    expect(html).toContain('All 6 in Activity');
    expect(html).toContain('Nothing needs you.');
    expect(html).toContain('0 open');
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
  const html = renderToStaticMarkup(<MobileHome items={[]} ask={null} setup={<section data-testid="getting-started">Connect a runner</section>} runnerConnected={false} live={0} capacity={0} mergedToday={0} inCi={0} shipped={[]} flight={[]} />);
  expect(html).toContain('data-testid="getting-started"');
  expect(html).toContain('Connect a runner');
  expect(html).not.toContain('working without you');
  expect(html).toContain('No runner is connected yet');
  // The checklist is the next step; the "All clear" reassurance would contradict it.
  expect(html).not.toContain('All clear');
  expect(html.indexOf('getting-started')).toBeLessThan(html.indexOf('Needs you'));
});
