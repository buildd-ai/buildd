import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t-1', width: 1440, height: 900 });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ShellPageMarks } = await import('./ShellPageMarks');
const { bannerHiddenSnapshot } = await import('@/lib/needs-input-hidden');
const { navSectionSnapshot } = await import('@/lib/nav-section-store');

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; });

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
}

describe('ShellPageMarks (spec d25d923d: a page shows a thing once)', () => {
  it('a page that shows its own decisions hides the questions banner while mounted', () => {
    expect(bannerHiddenSnapshot()).toBe(false);
    mount(<ShellPageMarks hideQuestionsBanner />);
    expect(bannerHiddenSnapshot()).toBe(true);
    act(() => root!.unmount());
    root = null;
    expect(bannerHiddenSnapshot()).toBe(false);
  });

  it("a mission's task claims Missions in the nav; a loose task claims nothing", () => {
    mount(<ShellPageMarks navSection="/app/missions" />);
    expect(navSectionSnapshot()).toBe('/app/missions');
    act(() => root!.unmount());
    root = null;
    expect(navSectionSnapshot()).toBeNull();
    mount(<ShellPageMarks navSection={null} />);
    expect(navSectionSnapshot()).toBeNull();
    expect(bannerHiddenSnapshot()).toBe(false);
  });
});
