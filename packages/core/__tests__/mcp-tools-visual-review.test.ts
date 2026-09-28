/**
 * get_visual_review: a mission's visual QA in one call, by id or by title; or,
 * with only a workspace, the missions with screens awaiting review.
 * Illustrative ids and titles only.
 */
import { describe, it, expect } from 'bun:test';
import type { VisualReviewModel } from '@buildd/shared';
import { handleBuilddAction, adminActions, workerActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';

const WS = '00000000-0000-4000-8000-000000000001';
const MISSION = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const AUDIT = '00000000-0000-4000-8000-0000000000b1';
const SHOT = '00000000-0000-4000-8000-0000000000c1';
const BASE = 'https://app.example.test';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: undefined,
    authType: 'api',
    appBaseUrl: BASE,
    getWorkspaceId: async () => null,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

const model: VisualReviewModel = {
  missionId: MISSION,
  phase: 'needs_you',
  progress: null,
  audit: { id: AUDIT, title: '[surface audit] Example', status: 'completed', round: 1, createdAt: null, errorType: null, why: null },
  audits: [
    { id: AUDIT, title: '[surface audit] Example', status: 'completed', round: 1, createdAt: null, errorType: null, why: 'Checked one route.' },
  ],
  bootFailure: null,
  roundCapOpen: false,
  needsYou: { reason: 'unsure' },
  cells: [{
    key: '/app/x|mobile|', route: '/app/x', viewport: 'mobile', variant: null,
    current: {
      round: 1,
      shot: { id: SHOT, auditTaskId: AUDIT, round: 1, createdAt: '2026-03-10T10:00:00.000Z', src: `/api/artifacts/${SHOT}/download`, qa: { runKey: '', route: '/app/x', viewport: 'mobile', finding: 'Maybe clipped.', verdict: 'unsure' } },
      agentVerdict: 'unsure', finding: 'Maybe clipped.', fixTask: null, review: null,
    },
    history: [], effectiveVerdict: 'unsure', marker: 'awaiting', needsHuman: true,
  }],
  queue: ['/app/x|mobile|'],
  summary: { shots: 1, ok: 0, issues: 0, unsure: 1, effectiveOk: 0, effectiveIssues: 0, reviewed: 0, unreviewed: 1, awaitingHuman: 1, confirmed: 0, disputed: 0, waived: 0, rounds: 1, openFixes: 0 },
  fixTasks: [],
  generatedAt: '2026-03-10T11:00:00.000Z',
};

type Route = (endpoint: string) => unknown;
function apiOf(route: Route) {
  const calls: string[] = [];
  const api = (async (endpoint: string) => {
    calls.push(endpoint);
    const out = route(endpoint);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as ApiFn;
  return { api, calls };
}

const missionsRoute: Route = (e) => {
  if (e.startsWith('/api/workspaces?') || e === '/api/workspaces') return { workspaces: [{ id: WS, name: 'Example WS' }] };
  if (e.startsWith('/api/missions?')) return { missions: [
    { id: OTHER, title: 'Desktop chat v2', status: 'completed' },
    { id: MISSION, title: 'Desktop chat v3', status: 'completed' },
  ] };
  if (e === `/api/missions/${MISSION}`) return { id: MISSION, title: 'Desktop chat v3', status: 'completed' };
  if (e === `/api/missions/${MISSION}/visual-review`) return { model };
  return new Error(`unexpected ${e}`);
};

describe('get_visual_review', () => {
  it('is admin level, like the API route it reads', () => {
    expect(adminActions).toContain('get_visual_review');
    expect(workerActions).not.toContain('get_visual_review' as never);
  });

  it('has a short description naming its params', () => {
    const d = buildParamsDescription(['get_visual_review']);
    expect(d).toContain('missionTitle');
    expect(d).toContain('awaitingOnly');
    expect(d.length).toBeLessThan(600);
  });

  it('by id: mission, then its review, as text with audits, links and the review count', async () => {
    const { api, calls } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionId: MISSION }, ctx());
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([`/api/missions/${MISSION}`, `/api/missions/${MISSION}/visual-review`]);
    const out = res.content[0].text;
    expect(out).toContain(`Visual review of "Desktop chat v3" (mission ${MISSION}, completed)`);
    expect(out).toContain(`round 1: completed (task ${AUDIT}): Checked one route.`);
    expect(out).toContain('1 screen needs your review.');
    expect(out).toContain(`${BASE}/app/artifacts/${SHOT}`);
    expect(out).toContain(`${BASE}/api/artifacts/${SHOT}/download`);
  });

  it('passes the mission completion time through, so "checked before done" is answerable', async () => {
    const { api } = apiOf((e) => e === `/api/missions/${MISSION}` ? { id: MISSION, title: 'Desktop chat v3', status: 'completed', completedAt: '2026-03-10T12:00:00.000Z' } : missionsRoute(e));
    const res = await handleBuilddAction(api, 'get_visual_review', { missionId: MISSION }, ctx());
    expect(res.content[0].text).toContain('(mission ' + MISSION + ', completed 2026-03-10 12:00 UTC)');
    expect(res.content[0].text).toMatch(/Visually checked before the mission was completed: /);
  });

  it('by title: matches case-insensitively across every status, in the named workspace', async () => {
    const { api, calls } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'desktop CHAT v3', workspaceId: WS }, ctx());
    expect(res.isError).toBeFalsy();
    const list = calls.find(c => c.startsWith('/api/missions?'))!;
    const qs = new URLSearchParams(list.split('?')[1]);
    expect(qs.get('workspaceId')).toBe(WS);
    expect(qs.get('status')).toBeNull();
    expect(calls).toContain(`/api/missions/${MISSION}/visual-review`);
  });

  it('by title: an ambiguous partial title lists the candidates instead of guessing', async () => {
    const { api } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'desktop chat' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(MISSION);
    expect(res.content[0].text).toContain(OTHER);
  });

  it('by title: no match says so and never falls back to another mission', async () => {
    const { api, calls } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'Memory done right' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No mission titled "Memory done right"/);
    expect(calls.some(c => c.endsWith('/visual-review'))).toBe(false);
  });

  it('a workspace that does not resolve is an error, never a silently dropped filter', async () => {
    const { api, calls } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'Desktop chat v3', workspaceId: 'Nope' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Workspace "Nope" not found/);
    expect(calls.some(c => c.startsWith('/api/missions?'))).toBe(false);
  });

  it('workspace only: one call lists missions with screens awaiting review, with counts', async () => {
    const { api, calls } = apiOf((e) => {
      if (e === `/api/workspaces/${WS}/visual-review`) return {
        workspace: { id: WS, name: 'Example WS' },
        missions: [
          { id: MISSION, title: 'Desktop chat v3', status: 'active', phase: 'needs_you', reason: 'unsure', awaitingHuman: 2 },
          { id: OTHER, title: 'Desktop chat v2', status: 'active', phase: 'needs_you', reason: 'round_cap', awaitingHuman: 0 },
        ],
        more: true,
      };
      return new Error(`unexpected ${e}`);
    });
    const res = await handleBuilddAction(api, 'get_visual_review', { workspaceId: WS }, ctx());
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([`/api/workspaces/${WS}/visual-review`]);
    const out = res.content[0].text;
    expect(out).toContain('Example WS');
    expect(out).toContain(`"Desktop chat v3" (mission ${MISSION}, active): 2 screens need your review`);
    expect(out).toContain(`"Desktop chat v2" (mission ${OTHER}, active): needs your decision (round cap: fix or waive)`);
    expect(out).toMatch(/^2 missions wait on you in Example WS \(2 screens to review\):/);
    expect(out).not.toMatch(/\b0 (screens? )?needs? your review/);
    expect(out).toMatch(/older missions were not checked/);
  });

  it('workspace only: says none plainly', async () => {
    const { api } = apiOf(() => ({ workspace: { id: WS, name: 'Example WS' }, missions: [], more: false }));
    const res = await handleBuilddAction(api, 'get_visual_review', { workspaceId: WS }, ctx());
    expect(res.content[0].text).toMatch(/Nothing waits on you in Example WS/);
  });

  it('by title, no workspace named: searches team-wide, never the guessed workspace', async () => {
    const { api, calls } = apiOf(missionsRoute);
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'Desktop chat v3' }, ctx({ getWorkspaceId: async () => WS }));
    expect(res.isError).toBeFalsy();
    const list = calls.find(c => c.startsWith('/api/missions?'))!;
    expect(new URLSearchParams(list.split('?')[1]).get('workspaceId')).toBeNull();
    expect(calls).toContain(`/api/missions/${MISSION}/visual-review`);
  });

  it('by title in a named workspace: a miss names the workspace searched', async () => {
    const { api } = apiOf((e) => e.startsWith('/api/missions?') ? { missions: [] } : missionsRoute(e));
    const res = await handleBuilddAction(api, 'get_visual_review', { missionTitle: 'Memory done right', workspaceId: WS }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(`in workspace "${WS}"`);
    expect(res.content[0].text).toMatch(/omit workspaceId to search every workspace/);
  });

  it('no mission, no workspace named: errors rather than answering for the guessed workspace', async () => {
    const { api, calls } = apiOf(() => ({ workspace: { id: WS, name: 'Example WS' }, missions: [], more: false }));
    const res = await handleBuilddAction(api, 'get_visual_review', {}, ctx({ getWorkspaceId: async () => WS }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/workspaceId/);
    expect(calls.some(c => c.includes('/visual-review'))).toBe(false);
  });

  it('falls back to the context workspace, and errors with neither mission nor workspace', async () => {
    const { api, calls } = apiOf(() => ({ workspace: { id: WS, name: 'Example WS' }, missions: [], more: false }));
    await handleBuilddAction(api, 'get_visual_review', {}, ctx({ workspaceId: WS, getWorkspaceId: async () => WS }));
    expect(calls).toEqual([`/api/workspaces/${WS}/visual-review`]);

    const none = await handleBuilddAction(apiOf(() => ({})).api, 'get_visual_review', {}, ctx());
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/missionTitle|missionId/);
  });

  it('awaitingOnly with a mission lists only the screens that need review', async () => {
    const both: VisualReviewModel = { ...model, cells: [model.cells[0], { ...model.cells[0], key: 'k2', viewport: 'desktop', needsHuman: false, current: { ...model.cells[0].current, agentVerdict: 'ok', shot: { ...model.cells[0].current.shot, id: 'other-shot' } } }] };
    const { api } = apiOf((e) => e.endsWith('/visual-review') ? { model: both } : missionsRoute(e));
    const res = await handleBuilddAction(api, 'get_visual_review', { missionId: MISSION, awaitingOnly: true }, ctx());
    expect(res.content[0].text).not.toContain('other-shot');
    expect(res.content[0].text).toMatch(/1 other screen not shown/);
  });
});
