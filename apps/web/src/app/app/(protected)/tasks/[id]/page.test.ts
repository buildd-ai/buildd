import { describe, it, expect } from 'bun:test';

// Source-based, not imported/rendered: this is a server component pulling in
// the DB client, drizzle, auth-helpers, and team-access. Same rationale as
// tasks/page.test.ts's mission-budget plumbing suite — a re-derivation of the
// wiring in this test file would prove nothing about the actual page.
const pageSource = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

describe('ship badge plumbing — tasks/[id]/page.tsx (spec §10.3)', () => {
  it('imports the single shared ship-state loader, not a local re-derivation', () => {
    expect(pageSource).toContain("import { resolveShippedRelease } from '@/lib/task-ship-state'");
  });

  it('imports TaskShipBadge — same component TaskCard mounts, not a second implementation', () => {
    expect(pageSource).toContain("import { TaskShipBadge } from '@/components/TaskShipBadge'");
  });

  it('resolves ship state for this task', () => {
    expect(pageSource).toContain('resolveShippedRelease(task.id)');
  });

  it('mounts TaskShipBadge with task.release and the resolved shippedReleaseId', () => {
    expect(pageSource).toContain('<TaskShipBadge release={task.release} shippedReleaseId={shippedRelease?.releaseId ?? null} />');
  });
});
