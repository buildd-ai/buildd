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

describe('plan chain — tasks/[id]/page.tsx (reviewer task navigation)', () => {
  it('prepends parent task to chain when current task is a child', () => {
    // When a reviewer task (child) is viewed, the parent (builder) task should be
    // included in the chain so the user can navigate from reviewer to builder.
    expect(pageSource).toContain('if (task.parentTaskId && task.parentTask) {');
    expect(pageSource).toContain('{ id: task.parentTaskId, title: task.parentTask.title, status: task.parentTask.status, roleSlug: task.parentTask.roleSlug },');
  });

  it('filters out self-loop chains', () => {
    // If the chain only contains the current task, suppress it to fall back to
    // the Related Tasks section which has more comprehensive navigation.
    expect(pageSource).toContain('if (planChain.length === 1 && planChain[0].id === id) {');
    expect(pageSource).toContain('planChain = [];');
  });

  it('renders PlanChainView when chain has content', () => {
    expect(pageSource).toContain('{planChain.length > 0 ? (');
    expect(pageSource).toContain('<PlanChainView');
  });

  it('falls back to Related Tasks only when chain is empty', () => {
    // The Related Tasks section (with parent link) only renders when the chain is empty.
    expect(pageSource).toContain(') : (task.parentTask || (task.subTasks && task.subTasks.length > 0)) && (');
  });
});

describe('dependency blocking — tasks/[id]/page.tsx reads every dep worker', () => {
  // The gate asks whether ANY worker of a completed dep holds an open PR. Loading
  // only the newest worker hid an older worker's open PR, so the page said
  // "All dependencies resolved" while the claim gate and the list said BLOCKED.
  const depQuery = pageSource.slice(
    pageSource.indexOf('where: inArray(tasks.id, depTaskIds)'),
    pageSource.indexOf('// Workers for this task'),
  );

  it('the depTasks workers relation is not limited to the latest worker', () => {
    expect(depQuery.length).toBeGreaterThan(0);
    expect(depQuery).not.toMatch(/limit:\s*1\b/);
  });

  it('the Blocked banner picks the PR worker with the shared predicate, not workers[0]', () => {
    expect(pageSource).toContain('findBlockingPrWorker(');
    expect(pageSource).not.toMatch(/\(d(ep)? as any\)\.workers\?\.\[0\]/);
  });

  it('a blocking worker with a prUrl but no prNumber is still listed (generic PR link)', () => {
    // The gate blocks on prUrl alone; requiring prNumber here left the banner
    // saying "waiting on 1 dependency" with nothing listed.
    expect(pageSource).not.toMatch(/w\?\.prUrl && w\.prNumber \?/);
    expect(pageSource).toContain("w.prNumber ? `Merge PR #${w.prNumber}` : 'PR open'");
  });
});
