import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { MobileHome } = await import('./MobileHome');
const { deriveHomeAttention } = await import('@/lib/home-attention');
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
    const items = deriveHomeAttention({ queue: [{ subjectKey: 'ready', chip: 'MERGE', prNumber: 7, workspaceId: 'example', taskTitle: 'A change', missionMergeBlockedReason: 'Other work is still running.' }], questions: [], held: [], missions: [] });
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
