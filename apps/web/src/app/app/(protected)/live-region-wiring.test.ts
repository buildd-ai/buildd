/**
 * Live regions (spec 3ef37387 R-16): a Pusher event on Home, a mission or a
 * task re-reads the page's region through a server action, asked through the
 * 5 s page gate, instead of re-rendering the page with router.refresh().
 */
import { describe, expect, it } from 'bun:test';

const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

describe('live regions', () => {
  it('Home reads its region through a server action and hands the refresher to its Pusher handler', async () => {
    const [page, live, auto] = await Promise.all([read('./home/page.tsx'), read('./home/HomeLive.tsx'), read('./home/HomeAutoRefresh.tsx')]);
    expect(page).toMatch(/async function loadRegion\(\)[^{]*\{\s*'use server';/);
    expect(page).toContain('load={loadRegion}');
    expect(live).toContain('refresher={reader.refresher}');
    expect(auto).toContain('requestPageRefresh(target)');
  });

  it('the mission page wraps its body in a LiveRegion backed by a server action', async () => {
    const page = await read('./missions/[id]/page.tsx');
    expect(page).toMatch(/async function loadRegion\(\)\s*\{\s*'use server';/);
    expect(page).toContain('<LiveRegion load={loadRegion}>');
  });

  it('the task page re-reads only its worker and status through LiveData', async () => {
    const page = await read('./tasks/[id]/page.tsx');
    expect(page).toMatch(/async function loadRegion\(\)\s*\{\s*'use server';[\s\S]*?loadTaskLiveRegion\(/);
    expect(page).toContain('<LiveData initial=');
    expect(page).not.toContain('TaskDetailBody');
  });

  it('the mission and task subscribers refresh the region, not the router', async () => {
    const files = await Promise.all([read('./missions/[id]/MissionAutoRefresh.tsx'), read('./tasks/[id]/TaskAutoRefresh.tsx'), read('./tasks/[id]/RealTimeWorkerView.tsx')]);
    for (const src of files) expect(src).toContain('useRegionRefresher(useRouter())');
  });
});
