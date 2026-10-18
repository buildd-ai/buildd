/**
 * Home's fleet stats, doc-fix cards, mission cards and the mission stage read
 * a kernel-owned delivery's merged/open/closed state, not only the worker rows
 * (workflow-kernel-library §7). Wiring read from source.
 */
import { describe, expect, it } from 'bun:test';

const home = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const fleet = await Bun.file(new URL('../../../../lib/home-fleet.ts', import.meta.url)).text();
const stage = await Bun.file(new URL('../../../../lib/mission-stage-load.ts', import.meta.url)).text();
// The loader's pure half: the stored mission summary runs it on the same rows.
const stageAssemble = await Bun.file(new URL('../../../../lib/mission-stage-assemble.ts', import.meta.url)).text();

describe('Home and the mission stage read the delivery', () => {
  it('the fleet ticker, merged-today and in-CI read the delivery, beside the superseded read', () => {
    expect(fleet).toContain('getDeliveryViewsForTasks(deliveryTaskIds)');
    expect(fleet).toContain('prLifecycleFor(r, deliveryViews.get(r.taskId), r.taskId)');
    expect(fleet).toMatch(/Promise\.all\(\[\s*deliveryViewsPromise,\s*asking0\.length/);
    expect(fleet).toMatch(/taskId: workers\.taskId, prUrl: workers\.prUrl, prNumber: workers\.prNumber/);
  });
  it('doc-fix cards take the delivery lifecycle, loaded in one batch with their workers', () => {
    expect(home).toContain('getDeliveryViewsForTasks(docFixTaskIds)');
    expect(home).toContain('prLifecycleFor(w, docFixViews.get(w.taskId), w.taskId)');
  });
  it('the mission card is built from the overlaid mission rows', () => {
    expect(home).toContain('lifecycleById.get(m.id) ?? m');
  });
  it('the mission stage overlays its PR workers from one batched read', () => {
    expect(stage).toContain('getDeliveryViewsForTasks(taskIds)');
    expect(stage).toContain('assembleMissionStages({');
    expect(stageAssemble).toContain('overlayDeliveryLifecycle(taskIds.map(');
  });
});
