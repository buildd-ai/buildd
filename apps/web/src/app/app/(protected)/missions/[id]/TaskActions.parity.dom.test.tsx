/**
 * Task-action parity (happy-dom): one task per state, rendered through the
 * three surfaces that act on a task — the mission task sheet (TaskPanelBody),
 * the full task page (TaskPageActionZone, as page.tsx mounts it) and the
 * mission page's Landed drawer (LandedStrip) — must offer the same actions,
 * and pressing each must make the same request exactly once.
 *
 * States: queued on a runner, queued in a local mission (a 422 the person may
 * force), failed with another backend to switch to, dependency-blocked, landed.
 *
 * The page differs in one way by design: it does not link "View history" to
 * itself, so `history` is dropped before comparing it.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/missions/m1',
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  getPusherClient: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));
mock.module('../../tasks/useLocalUiHealth', () => ({ useLocalUiHealth: () => ({ available: [] }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskPanelBody } = await import('./TaskPanel');
const { default: TaskPageActionZone } = await import('../../tasks/[id]/TaskPageActionZone');
const { LandedStrip } = await import('./MissionTaskStrip');
const { MissionStripContext, createMissionStripStore } = await import('@/components/missions/mission-strip-context');
const { deriveTaskPhase } = await import('@/lib/task-presentation');
const { stripOrder } = await import('@/lib/mission-task-strip');
const { missionTaskStripFixture, stripFixtureId } = await import('../../../dev/fixtures/mission-task-strip-fixtures');
type BoardTask = import('@/lib/mission-board').BoardTask;
type MissionBoardModel = import('@/lib/mission-board').MissionBoardModel;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: unknown }> = [];
let startReply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  startReply = { status: 200, body: {} };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') calls.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const firstStart = u.endsWith('/start') && calls.filter(c => c.url.endsWith('/start')).length === 1;
    const reply = firstStart ? startReply : { status: 200, body: { status: 'pending' } };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

type Surface = 'sheet' | 'page' | 'drawer';
interface Case { name: string; model: MissionBoardModel; executor: 'runner' | 'local'; taskId: string }

const states = missionTaskStripFixture('states');
const local = missionTaskStripFixture('mid-open');
const CASES: Case[] = [
  { name: 'queued on a runner', model: states.model, executor: 'runner', taskId: stripFixtureId(2) },
  { name: 'queued in a local mission', model: local.model, executor: 'local', taskId: stripFixtureId(9) },
  { name: 'failed, another backend available', model: states.model, executor: 'runner', taskId: stripFixtureId(3) },
  { name: 'dependency-blocked', model: states.model, executor: 'runner', taskId: stripFixtureId(4) },
  { name: 'landed', model: states.model, executor: 'runner', taskId: stripFixtureId(1) },
];

const blockedBy = (t: BoardTask) => t.deps.filter(d => !d.ok).length;

/** Mount one surface for one task, the way its host mounts it. */
async function mount(surface: Surface, c: Case) {
  const t = c.model.tasks[c.taskId];
  if (surface === 'sheet') {
    const data = {
      id: t.id, title: t.title, status: t.taskStatus, description: null, mode: t.taskMode, roleSlug: t.roleSlug,
      createdAt: new Date(0).toISOString(), missionId: 'm1', missionExecutor: c.executor, backend: t.backend, failover: null,
      worker: null, result: null, lastError: null, blockedByCount: blockedBy(t),
    };
    await act(async () => { root.render(<TaskPanelBody data={data as never} workspaceId="ws1" onChanged={() => {}} />); });
    return;
  }
  if (surface === 'page') {
    // page.tsx: the zone renders for a failure, a startable task, or a blocked one.
    const isBlocked = t.taskStatus === 'pending' && blockedBy(t) > 0;
    const phase = deriveTaskPhase({ taskStatus: t.taskStatus, taskMode: t.taskMode, isBlocked });
    const canStart = t.taskStatus === 'pending' && !isBlocked;
    await act(async () => {
      root.render(
        (phase === 'failed' || canStart || isBlocked) ? (
          <TaskPageActionZone
            taskId={t.id} workspaceId="ws1" phase={phase} isBlocked={isBlocked} blockedByCount={blockedBy(t)}
            backend={t.backend} lastError={null} worker={null} roleSlug={t.roleSlug} missionExecutor={c.executor} runnerPicker
          />
        ) : <div />,
      );
    });
    return;
  }
  const store = createMissionStripStore();
  store.select(t.id);
  await act(async () => {
    root.render(
      <MissionStripContext.Provider value={{ store, taskIds: stripOrder(c.model) }}>
        <LandedStrip model={c.model} compact={false} link={{ missionId: 'm1' }} workspaceId="ws1" executor={c.executor} focus={null} count={null} />
      </MissionStripContext.Provider>,
    );
  });
}

function actionSet(surface: Surface): string[] {
  const zone = container.querySelector<HTMLElement>('[data-testid="task-action-zone"]');
  const set = zone?.dataset.actions ? zone.dataset.actions.split(' ') : [];
  return surface === 'page' ? set : set.filter(a => a !== 'history');
}

async function press(action: string) {
  const btn = container.querySelector<HTMLElement>(`[data-testid="task-action-zone"] [data-action="${action}"]`);
  expect(btn).not.toBeNull();
  await act(async () => { btn!.click(); });
  await flush();
}

const SURFACES: Surface[] = ['sheet', 'page', 'drawer'];

describe('task actions: sheet, page and drawer agree', () => {
  for (const c of CASES) {
    it(`${c.name}: the same action set on every surface`, async () => {
      const sets: Record<string, string[]> = {};
      for (const s of SURFACES) {
        await mount(s, c);
        sets[s] = actionSet(s);
        await act(async () => { root.render(<div />); });
      }
      expect(sets.page).toEqual(sets.sheet);
      expect(sets.drawer).toEqual(sets.sheet);
    });
  }

  it('the expected sets, so a surface cannot agree by drawing nothing', async () => {
    const expected = [['run_now'], ['claim_hint', 'run_now'], ['retry', 'switch_backend'], ['blocked'], []];
    for (const [i, c] of CASES.entries()) {
      await mount('sheet', c);
      expect(actionSet('sheet')).toEqual(expected[i]);
      await act(async () => { root.render(<div />); });
    }
  });

  for (const s of SURFACES) {
    it(`${s}: Run now posts one start with no flags`, async () => {
      await mount(s, CASES[0]);
      await press('run_now');
      expect(calls).toEqual([{ url: `/api/tasks/${CASES[0].taskId}/start`, body: {} }]);
    });

    it(`${s}: a local mission's refused start offers Force start, which posts forceOverride once`, async () => {
      startReply = { status: 422, body: { gateReason: 'mission_local', canForce: true, blockClass: 'policy' } };
      await mount(s, CASES[1]);
      expect(container.querySelector('[data-testid="claim-task-hint"]')?.textContent).toContain(`claim_task {taskId: "${CASES[1].taskId}"}`);
      await press('run_now');
      await press('force_start');
      const url = `/api/tasks/${CASES[1].taskId}/start`;
      expect(calls).toEqual([{ url, body: {} }, { url, body: { forceOverride: true } }]);
    });

    it(`${s}: Retry and Switch each post one reassign`, async () => {
      const url = `/api/tasks/${CASES[2].taskId}/reassign?force=true`;
      await mount(s, CASES[2]);
      await press('retry');
      expect(calls).toEqual([{ url, body: {} }]);
      calls = [];
      await press('switch_backend');
      expect(calls).toEqual([{ url, body: { backend: 'codex' } }]);
    });
  }
});
