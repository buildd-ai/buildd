/**
 * Home's PR, merge-blocker and doc-fix cards, its mission readings and the
 * mission stage read a kernel-owned delivery's merged/open/closed state, not
 * only the worker rows (workflow-kernel-library §7). Wiring read from source.
 */
import { describe, expect, it } from 'bun:test';

const home = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const summary = await Bun.file(new URL('../../../../lib/mission-summary.ts', import.meta.url)).text();
const stage = await Bun.file(new URL('../../../../lib/mission-stage-load.ts', import.meta.url)).text();
// The loader's pure half: the stored mission summary runs it on the same rows.
const stageAssemble = await Bun.file(new URL('../../../../lib/mission-stage-assemble.ts', import.meta.url)).text();

describe('Home and the mission stage read the delivery', () => {
  it('one delivery read serves the PR cards, failed cards, merge blockers and doc-fix cards', () => {
    expect(home).toContain('getDeliveryViewsForTasks([...openTaskIds, ...failedTaskRows.map(t => t.id), ...upstreamIds, ...docFixTaskIds])');
    expect(home.match(/getDeliveryViewsForTasks\(/g)).toHaveLength(1);
  });
  it('doc-fix cards take the delivery lifecycle', () => {
    expect(home).toContain('prLifecycleFor(w, docFixViews.get(w.taskId), w.taskId)');
  });
  it('the stored mission reading is built from the overlaid mission rows', () => {
    expect(summary).toContain('overlayDeliveryLifecycle(');
    expect(summary).toContain('const row = { ...mission, tasks: cardTasks }');
  });
  it('the mission stage overlays its PR workers from one batched read', () => {
    expect(stage).toContain('getDeliveryViewsForTasks(taskIds)');
    expect(stage).toContain('assembleMissionStages({');
    expect(stageAssemble).toContain('overlayDeliveryLifecycle(taskIds.map(');
  });
});
