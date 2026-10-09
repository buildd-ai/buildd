/**
 * Replay: the design's transitions storyboard (PR opened → changes requested →
 * repair → new head → late stale approval → renewed approval → landed), folded
 * event by event into today's fields and projected after each step. The
 * projection must never show a pass a later head has superseded, never call
 * an agent-done task landed before its PR merges, and never ask a person.
 */
import { describe, expect, it } from 'bun:test';
import { projectMissionDelivery as project, projectTaskDelivery, type DeliveryKind, type MissionTaskRow, type ReviewEvidence, type TaskDeliveryInput } from './delivery-projection';
import * as missionHelpers from '@buildd/core/mission-helpers';

const projectMissionDelivery = (m: Parameters<typeof project>[0]) => project(m, missionHelpers);

const PR = 'https://github.com/example/project/pull/34';

type Event =
  | { at: string; type: 'pr_opened'; head: string }
  | { at: string; type: 'ci'; status: 'ci_running' | 'ci_green' | 'ci_failed' }
  | { at: string; type: 'verdict'; verdict: ReviewEvidence['verdict']; head: string }
  | { at: string; type: 'fix_started' }
  | { at: string; type: 'fix_pushed'; head: string }
  | { at: string; type: 'merged' };

interface State { input: TaskDeliveryInput; reviews: ReviewEvidence[] }

function apply(s: State, e: Event): State {
  const owner = { ...s.input.workers[s.input.workers.length - 1] };
  const fixers = s.input.workers.slice(0, -1);
  switch (e.type) {
    case 'pr_opened':
      return { ...s, input: { ...s.input, status: 'completed', headSha: e.head, workers: [...fixers, { ...owner, status: 'completed', prUrl: PR, prLifecycleStatus: 'pr_open' }] } };
    case 'ci':
      return { ...s, input: { ...s.input, workers: [...fixers, { ...owner, prLifecycleStatus: e.status }] } };
    case 'verdict': {
      // Reviews are recorded in arrival order. The latest verdict for the
      // current head wins; a late one for an old head is kept only if nothing
      // newer exists — and then it is stale.
      const reviews = [...s.reviews, { verdict: e.verdict, headSha: e.head }];
      const current = [...reviews].reverse().find(r => r.headSha === s.input.headSha) ?? reviews[reviews.length - 1];
      return { reviews, input: { ...s.input, review: current } };
    }
    case 'fix_started':
      return { ...s, input: { ...s.input, repairRounds: (s.input.repairRounds ?? 0) + 1, workers: [{ status: 'running' }, ...s.input.workers] } };
    case 'fix_pushed': {
      const done = s.input.workers.map((w, i) => (i < s.input.workers.length - 1 ? { ...w, status: 'completed' } : { ...w, prLifecycleStatus: 'ci_running' }));
      const current = [...s.reviews].reverse().find(r => r.headSha === e.head) ?? s.reviews[s.reviews.length - 1];
      return { ...s, input: { ...s.input, headSha: e.head, workers: done, review: current } };
    }
    case 'merged':
      return { ...s, input: { ...s.input, workers: [...fixers, { ...owner, mergedAt: e.at, prLifecycleStatus: 'merged' }] } };
  }
}

const STORY: Array<[Event, DeliveryKind]> = [
  [{ at: '10:02', type: 'pr_opened', head: 'a1b2c3d' }, 'audit'],
  [{ at: '10:05', type: 'ci', status: 'ci_green' }, 'audit'],
  [{ at: '10:20', type: 'verdict', verdict: 'request-changes', head: 'a1b2c3d' }, 'repair'],
  [{ at: '10:21', type: 'fix_started' }, 'repair'],
  [{ at: '10:48', type: 'fix_pushed', head: 'd4e5f60' }, 'audit'],
  // The stale-head case: an approval for the OLD head arrives after the new push.
  [{ at: '10:51', type: 'verdict', verdict: 'approve', head: 'a1b2c3d' }, 'audit'],
  [{ at: '10:55', type: 'ci', status: 'ci_green' }, 'audit'],
  [{ at: '11:03', type: 'verdict', verdict: 'approve', head: 'd4e5f60' }, 'landing'],
  [{ at: '11:04', type: 'merged' }, 'landed'],
];

describe('replay: review fails, auto-repair, renewed audit, land', () => {
  it('projects the storyboard step by step', () => {
    let s: State = { input: { status: 'assigned', workers: [{ status: 'running' }] }, reviews: [] };
    expect(projectTaskDelivery(s.input).kind).toBe('build');
    for (const [event, expected] of STORY) {
      s = apply(s, event);
      const d = projectTaskDelivery(s.input);
      expect(`${event.at} ${d.kind}`).toBe(`${event.at} ${expected}`);
      // Auto-repair and audit never reach Needs you.
      expect(d.needsHuman).toBe(false);
      // Agent finished long before it landed.
      if (event.type !== 'merged') expect(d.landed).toBe(false);
    }
  });

  it('a stale approval is never shown as passed, whatever order events arrive in', () => {
    let s: State = { input: { status: 'assigned', workers: [{ status: 'running' }] }, reviews: [] };
    for (const [event] of STORY.slice(0, 6)) s = apply(s, event);
    const d = projectTaskDelivery(s.input);
    expect(d.verdict).toBe('stale');
    expect(d.kind).not.toBe('landing');
  });

  it('the repair counter carries through to the end', () => {
    let s: State = { input: { status: 'assigned', workers: [{ status: 'running' }] }, reviews: [] };
    for (const [event] of STORY) s = apply(s, event);
    expect(projectTaskDelivery(s.input).repairRounds).toBe(1);
  });
});

describe('replay: mission landed count only moves on a merge', () => {
  it('33 → 34 landed only when 34 merges; 35 waits on it until then', () => {
    const landedTask = (n: number): MissionTaskRow => ({ id: `t${String(n).padStart(2, '0')}`, title: `Task ${n}`, status: 'completed', workers: [{ status: 'completed', prUrl: `${PR}${n}`, mergedAt: '2026-10-01T00:00:00Z' }] });
    const base = Array.from({ length: 33 }, (_, i) => landedTask(i + 1));
    const t35: MissionTaskRow = { id: 't35', title: 'Settings UI', status: 'pending', dependsOn: ['t34'], workers: [] };
    const at = (t34: MissionTaskRow) => projectMissionDelivery({ id: 'm', title: 'Billing exports', status: 'active', href: '/app/missions/m', tasks: [...base, t34, t35] });

    const inAudit = at({ id: 't34', title: 'Export email', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_green' }] });
    expect(inAudit.landed).toBe(33);
    expect(inAudit.total).toBe(35);
    expect(inAudit.milestones.agentsDone).toBe(false);
    expect(inAudit.tasks.find(t => t.id === 't35')!.delivery.waitingOn).toBe('dependency');

    const merged = at({ id: 't34', title: 'Export email', status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T11:04:00Z' }] });
    expect(merged.landed).toBe(34);
    expect(merged.tasks.find(t => t.id === 't35')!.delivery.waitingOn).toBe('capacity');
  });
});
