import { describe, expect, it } from 'bun:test';
import {
  DELIVERY_KIND,
  bindVerdict,
  deliveryCounts,
  deliveryStageIndex,
  projectKernelState,
  projectMissionDelivery as project,
  projectTaskDelivery,
  repairBadge,
  selectHomeMilestones,
  type MissionDeliveryInput,
  type MissionTaskRow,
} from './delivery-projection';
import * as missionHelpers from '@buildd/core/mission-helpers';

const projectMissionDelivery = (m: Parameters<typeof project>[0]) => project(m, missionHelpers);

const PR = 'https://github.com/example/project/pull/1';

describe('bindVerdict: verdicts are bound to the head they judged', () => {
  it('an approval for the current head passes', () => {
    expect(bindVerdict({ verdict: 'approve', headSha: 'aaa111' }, 'aaa111')).toBe('passed');
  });
  it('an approval for an older head is stale, never passed', () => {
    expect(bindVerdict({ verdict: 'approve', headSha: 'aaa111' }, 'bbb222')).toBe('stale');
  });
  it('an approval carried forward to an equivalent head passes', () => {
    expect(bindVerdict({ verdict: 'approve', headSha: 'aaa111', equivalentHeadShas: ['bbb222'] }, 'bbb222')).toBe('passed');
  });
  it('an approval with no recorded head, or no known current head, is unbound', () => {
    expect(bindVerdict({ verdict: 'approve', headSha: null }, 'bbb222')).toBe('unbound');
    expect(bindVerdict({ verdict: 'approve', headSha: 'aaa111' }, null)).toBe('unbound');
  });
  it('compares abbreviated and full SHAs by prefix', () => {
    expect(bindVerdict({ verdict: 'approve', headSha: 'aaa111ffffffff' }, 'aaa111f')).toBe('passed');
  });
  it('request-changes on an older head is stale too: the fix may have answered it', () => {
    expect(bindVerdict({ verdict: 'request-changes', headSha: 'aaa111' }, 'bbb222')).toBe('stale');
    expect(bindVerdict({ verdict: 'request-changes', headSha: 'aaa111' }, 'aaa111')).toBe('changes_requested');
  });
  it('escalation is a person\'s call whatever the head', () => {
    expect(bindVerdict({ verdict: 'escalate', headSha: 'aaa111' }, 'bbb222')).toBe('escalated');
  });
  it('a review that could not run is unavailable', () => {
    expect(bindVerdict({ verdict: null, state: 'review_failed', headSha: null }, 'bbb222')).toBe('unavailable');
  });
  it('no review is none', () => {
    expect(bindVerdict(null, 'bbb222')).toBe('none');
  });
});

describe('projectTaskDelivery: today\'s worker/PR fields', () => {
  it('a live agent with no PR is building (executing)', () => {
    const d = projectTaskDelivery({ status: 'assigned', workers: [{ status: 'running' }] });
    expect(d.kind).toBe('build');
    expect(d.status).toBe('executing');
    expect(d.agentDone).toBe(false);
    expect(d.landed).toBe(false);
  });

  it('terminal agent + unmerged PR is not landed: it is awaiting audit', () => {
    const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_running' }] });
    expect(d.agentDone).toBe(true);
    expect(d.landed).toBe(false);
    expect(d.open).toBe(true);
    expect(d.kind).toBe('audit');
    expect(d.status).toBe('awaiting_audit');
  });

  it('green CI alone is not a pass: without a head-bound approval it stays in audit', () => {
    const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_green' }] });
    expect(d.kind).toBe('audit');
    expect(d.verdict).toBe('none');
  });

  it('stale head cannot show passed: an approval for a superseded head keeps the task in audit', () => {
    const d = projectTaskDelivery({
      status: 'completed',
      workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_green' }],
      review: { verdict: 'approve', headSha: 'a1b2c3' },
      headSha: 'd4e5f6',
    });
    expect(d.verdict).toBe('stale');
    expect(d.kind).toBe('audit');
    expect(d.status).toBe('awaiting_audit');
  });

  it('approved on the current head and green is landing (awaiting merge)', () => {
    const d = projectTaskDelivery({
      status: 'completed',
      workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_green' }],
      review: { verdict: 'approve', headSha: 'd4e5f6' },
      headSha: 'd4e5f6',
    });
    expect(d.verdict).toBe('passed');
    expect(d.kind).toBe('landing');
    expect(d.status).toBe('awaiting_merge');
    expect(d.landed).toBe(false);
  });

  it('merged is landed; superseded by a merged PR is landed', () => {
    expect(projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z' }] }).landed).toBe(true);
    expect(projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', supersededByPrNumber: 9 }] }).kind).toBe('landed');
  });

  it('a closed PR stops reconciling once its scan ran: a suggestion needs a person, none is not landed', () => {
    const w = (supersessionScan: any) => [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', supersessionScan }];
    expect(projectTaskDelivery({ status: 'completed', workers: w(null) }).reconciling).toBe(true);
    const none = projectTaskDelivery({ status: 'completed', workers: w({ scannedAt: '2026-09-30T00:00:00Z', suggestion: null }) });
    expect(none.kind).toBe('notlanded');
    expect(none.reconciling).toBe(false);
    const sug = projectTaskDelivery({ status: 'completed', workers: w({ scannedAt: '2026-09-30T00:00:00Z', suggestion: { prNumber: 42 } }) });
    expect(sug.kind).toBe('needs');
    expect(sug.needsHuman).toBe(true);
    expect(sug.reconciling).toBe(false);
    expect(sug.confirmPrNumber).toBe(42);
  });

  it('a closed PR is reconciling; an abandoned PR and a failed task are not', () => {
    const closedPr = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });
    expect(closedPr.reconciling).toBe(true);
    const abandoned = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', abandonedAt: '2026-10-01T00:00:00Z' }] });
    expect(abandoned.kind).toBe('notlanded');
    expect(abandoned.reconciling).toBe(false);
    expect(projectTaskDelivery({ status: 'failed', workers: [{ status: 'failed' }] }).reconciling).toBe(false);
    expect(projectTaskDelivery({ status: 'cancelled', workers: [] }).reconciling).toBe(false);
  });

  it('closed without merging is an exception, not a human ask', () => {
    const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });
    expect(d.kind).toBe('notlanded');
    expect(d.needsHuman).toBe(false);
  });

  it('red CI or a conflict on an open PR is repair, never needs-human', () => {
    for (const s of ['ci_failed', 'conflict'] as const) {
      const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: s }] });
      expect(d.kind).toBe('repair');
      expect(d.needsHuman).toBe(false);
    }
  });

  it('a live fix attempt on an open PR is repair with its round count', () => {
    const d = projectTaskDelivery({ status: 'completed', repairRounds: 2, workers: [{ status: 'running' }, { status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] });
    expect(d.kind).toBe('repair');
    expect(d.repairRounds).toBe(2);
  });

  it('changes requested on the current head is repair', () => {
    const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }], review: { verdict: 'request-changes', headSha: 'aaa' }, headSha: 'aaa' });
    expect(d.kind).toBe('repair');
  });

  it('a review that cannot run reads as audit unavailable, not needs-you', () => {
    const d = projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }], review: { verdict: null, state: 'review_failed', headSha: null } });
    expect(d.kind).toBe('unavailable');
    expect(d.needsHuman).toBe(false);
  });

  it('only escalation or a waiting question needs a human', () => {
    expect(projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }], review: { verdict: 'escalate', headSha: 'x' }, headSha: 'y' }).needsHuman).toBe(true);
    expect(projectTaskDelivery({ status: 'assigned', workers: [{ status: 'waiting_input' }] }).status).toBe('needs_human');
  });

  it('a pending task waits on its dependencies or on a free slot', () => {
    expect(projectTaskDelivery({ status: 'pending', workers: [], waitingOn: 'dependency' }).kind).toBe('waiting');
    const cap = projectTaskDelivery({ status: 'pending', workers: [] });
    expect(cap.kind).toBe('waiting');
    expect(cap.waitingOn).toBe('capacity');
  });

  it('a completed task that never needed a PR is landed (same rule as mission progress)', () => {
    expect(projectTaskDelivery({ status: 'completed', workers: [{ status: 'completed' }] }).landed).toBe(true);
  });

  it('a failed task with no PR is not landed', () => {
    expect(projectTaskDelivery({ status: 'failed', workers: [{ status: 'failed' }] }).kind).toBe('notlanded');
  });
});

describe('projectKernelState: the one seam for the workflow kernel', () => {
  it('maps every kernel state to the shared vocabulary', () => {
    expect(projectKernelState('WORKING')).toBe('build');
    expect(projectKernelState('AWAITING_PUSH')).toBe('build');
    expect(projectKernelState('AWAITING_REVIEW')).toBe('audit');
    expect(projectKernelState('APPROVED')).toBe('audit');
    expect(projectKernelState('BLOCKED_ON_TRUNK')).toBe('audit');
    for (const s of ['CHANGES_REQUESTED', 'FIXING', 'REPAIRING'] as const) expect(projectKernelState(s)).toBe('repair');
    expect(projectKernelState('LANDING')).toBe('landing');
    expect(projectKernelState('MERGED')).toBe('landed');
    expect(projectKernelState('SUPERSEDED')).toBe('landed');
    expect(projectKernelState('CLOSED_UNMERGED')).toBe('notlanded');
    expect(projectKernelState('ESCALATED')).toBe('needs');
  });
  it('ESCALATED is the only kernel state that reaches a person', () => {
    const states = ['WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING', 'BLOCKED_ON_TRUNK', 'APPROVED', 'LANDING', 'ESCALATED', 'MERGED', 'CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED'] as const;
    expect(states.filter(s => projectKernelState(s) === 'needs')).toEqual(['ESCALATED']);
  });
});

describe('stage track and repair badge', () => {
  it('repair stays inside Audit, it is not a fourth stage', () => {
    expect(deliveryStageIndex('repair')).toBe(deliveryStageIndex('audit'));
    expect(deliveryStageIndex('build')).toBe(0);
    expect(deliveryStageIndex('landing')).toBe(2);
    expect(deliveryStageIndex('landed')).toBe(3);
    expect(deliveryStageIndex('waiting')).toBe(-1);
  });
  it('↻N is the repair count, empty at zero', () => {
    expect(repairBadge(0)).toBe('');
    expect(repairBadge(2)).toBe('↻2');
  });
  it('every kind carries a glyph and a word', () => {
    for (const k of Object.values(DELIVERY_KIND)) {
      expect(k.glyph.length).toBeGreaterThan(0);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});

// ── Mission projection ──────────────────────────────────────────────────────

let seq = 0;
const task = (over: Partial<MissionTaskRow> = {}): MissionTaskRow => ({
  id: over.id ?? `t${++seq}`,
  title: over.title ?? `Task ${seq}`,
  status: 'pending',
  kind: 'engineering',
  mode: 'execution',
  workers: [],
  ...over,
});
const merged = (title: string): MissionTaskRow => task({ title, status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z', prLifecycleStatus: 'merged' }] });
const mission = (over: Partial<MissionDeliveryInput>): MissionDeliveryInput => ({ id: 'm1', title: 'Mission', status: 'active', href: '/app/missions/m1', tasks: [], ...over });

describe('projectMissionDelivery', () => {
  it('agent-done is not landed: every agent finished but one PR is unmerged', () => {
    const m = projectMissionDelivery(mission({
      tasks: [merged('One'), task({ title: 'Two', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_running' }] })],
    }));
    expect(m.milestones.agentsDone).toBe(true);
    expect(m.milestones.allLanded).toBe(false);
    expect(m.landed).toBe(1);
    expect(m.total).toBe(2);
    expect(m.kind).toBe('audit');
    expect(m.open).toBe(true);
  });

  it('a surface audit that did not finish is not a deliverable: not counted, not Needs you', () => {
    const audit = task({ title: '[surface audit] round 2: Sentinel', status: 'failed', workers: [] });
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), merged('Two'), audit] }));
    expect(m.total).toBe(2);
    expect(m.landed).toBe(2);
    expect(m.kind).toBe('landed');
    expect(m.tasks.map(t => t.title)).not.toContain(audit.title);
    expect(m.exception?.text).not.toContain('did not land');
    expect(m.visual?.text).toBe('Visual audit could not run');
  });

  it('a failed branch refresh followed by a landed one is not a deliverable: not counted, not Needs you', () => {
    const failed = task({ title: 'chore(mission): merge dev into the branch', status: 'failed', workers: [], isIntegrationRefresh: true, createdAt: '2026-10-08T10:00:00Z' });
    const landed = task({ title: 'chore(mission): merge dev into the branch', status: 'completed', isIntegrationRefresh: true, createdAt: '2026-10-09T00:20:00Z', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'merged', mergedAt: '2026-10-09T01:00:00Z' }] });
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), failed, landed] }));
    expect(m.tasks.map(x => x.id)).not.toContain(failed.id);
    expect(m.kind).not.toBe('notlanded');
    expect(m.exception?.text ?? '').not.toContain('did not land');
  });

  it('a failed branch refresh with no later success is the platform\'s recovery, not a decision', () => {
    const failed = task({ title: 'chore(mission): merge dev into the branch', status: 'failed', workers: [], isIntegrationRefresh: true, createdAt: '2026-10-08T10:00:00Z' });
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), failed] }));
    expect(m.kind).toBe('notlanded');
    expect(m.reconciling).toBe(true);
    expect(m.exception?.text).toContain('refresh');
    expect(m.exception?.text).not.toContain('needs your decision');
    expect(m.next).not.toContain('retry or drop');
  });

  it('a refresh that failed after the last landed one is not hidden', () => {
    const landed = task({ title: 'refresh', status: 'completed', isIntegrationRefresh: true, createdAt: '2026-10-08T00:00:00Z', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'merged', mergedAt: '2026-10-08T01:00:00Z' }] });
    const failed = task({ title: 'refresh', status: 'failed', workers: [], isIntegrationRefresh: true, createdAt: '2026-10-09T00:00:00Z' });
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), landed, failed] }));
    expect(m.tasks.map(x => x.id)).toContain(failed.id);
  });

  it('a failed visual audit with findings reads as the mission\'s Visual state', () => {
    const audit = task({ title: '[surface audit] Sentinel', status: 'failed', workers: [] });
    const m = projectMissionDelivery(mission({ visualFindings: 2, tasks: [merged('One'), audit] }));
    expect(m.visual?.text).toBe('Visual audit: 2 findings');
    expect(m.exception?.text).toBe('Visual audit: 2 findings');
  });

  it('a later passing audit round clears the Visual state', () => {
    const r1 = task({ title: '[surface audit] Sentinel', status: 'failed', workers: [] });
    const r2 = task({ title: '[surface audit] round 2: Sentinel', status: 'completed', workers: [] });
    expect(projectMissionDelivery(mission({ tasks: [merged('One'), r1, r2] })).visual).toBeNull();
  });

  it('an unmerged deliverable with no carrier still needs a person alongside an audit', () => {
    const abandoned = task({ title: 'Real work', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', abandonedAt: '2026-10-01T00:00:00Z' }] });
    const audit = task({ title: '[surface audit] Sentinel', status: 'failed', workers: [] });
    const m = projectMissionDelivery(mission({ tasks: [abandoned, audit] }));
    expect(m.kind).toBe('notlanded');
    expect(m.exception?.text).toContain('Real work did not land');
  });

  it('landed is not mission complete, and complete is not released', () => {
    const m = projectMissionDelivery(mission({ tasks: [merged('One')], status: 'active' }));
    expect(m.milestones.allLanded).toBe(true);
    expect(m.milestones.complete).toBe(false);
    expect(m.milestones.released).toBeNull();
    const done = projectMissionDelivery(mission({ tasks: [merged('One')], status: 'completed' }));
    expect(done.milestones.complete).toBe(true);
    expect(done.milestones.released).toBeNull();
    expect(projectMissionDelivery(mission({ tasks: [merged('One')], status: 'completed', released: true })).milestones.released).toBe(true);
  });

  it('mission-branch: landed on the integration branch is not on trunk', () => {
    const m = projectMissionDelivery(mission({ integrationBranch: true, tasks: [merged('One'), merged('Two')] }));
    expect(m.milestones.allLanded).toBe(true);
    expect(m.milestones.onTrunk).toBe(false);
    expect(m.kind).toBe('landing');
    expect(m.exception?.text).toContain('not yet on trunk');
    expect(m.open).toBe(true);
  });

  it('landed n/m matches computeMissionProgress: attempts collapse, cancelled is out', () => {
    const parent = task({ id: 'p', title: 'Parent', status: 'failed', workers: [] });
    const retry = task({ id: 'r', title: 'Retry', status: 'completed', taskClass: 'attempt', parentTaskId: 'p', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01T00:00:00Z' }] });
    const cancelled = task({ title: 'Dup', status: 'cancelled' });
    const m = projectMissionDelivery(mission({ tasks: [parent, retry, cancelled, task({ title: 'Next' })] }));
    expect(m.total).toBe(2);
    expect(m.landed).toBe(1);
  });

  it('repair rounds come from attempt rows and roll up as ↻N', () => {
    const parent = task({ id: 'p2', title: 'Export email', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] });
    const fix = task({ id: 'f1', title: 'fix CI', status: 'completed', taskClass: 'attempt', parentTaskId: 'p2', workers: [{ status: 'completed' }] });
    const fix2 = task({ id: 'f2', title: 'fix CI', status: 'assigned', taskClass: 'attempt', parentTaskId: 'p2', workers: [{ status: 'running' }] });
    const m = projectMissionDelivery(mission({ tasks: [parent, fix, fix2] }));
    expect(m.kind).toBe('repair');
    expect(m.repairRounds).toBe(2);
    expect(m.focus?.title).toBe('Export email');
    expect(m.executing).toBe(true);
  });

  it('a live reviewer is the audit running: never Building, never Repairing, still an agent', () => {
    const owner = task({ id: 'p3', title: 'Export email', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_green' }] });
    const review = task({ id: 'rv', title: '[reviewer #1] Export email', status: 'in_progress', taskClass: 'attempt', parentTaskId: 'p3', workers: [{ status: 'running' }] });
    const m = projectMissionDelivery(mission({ tasks: [owner, review] }));
    expect(m.tasks[0].delivery.kind).toBe('audit');
    expect(m.executing).toBe(true);
    const fix = task({ id: 'f3', title: '[builder · after review #1] Export email', status: 'completed', taskClass: 'attempt', parentTaskId: 'p3', workers: [{ status: 'completed' }] });
    const after = projectMissionDelivery(mission({ tasks: [owner, fix, review] }));
    expect(after.tasks[0].delivery.kind).toBe('audit');
    expect(after.repairRounds).toBe(1);
  });

  it('a pending task blocked by an unlanded sibling waits on it by name', () => {
    const a = task({ id: 'a', title: 'Writer', status: 'assigned', workers: [{ status: 'running' }] });
    const b = task({ id: 'b', title: 'Settings UI', dependsOn: ['a'] });
    const m = projectMissionDelivery(mission({ tasks: [a, b] }));
    expect(m.tasks.find(t => t.id === 'b')!.delivery.waitingOn).toBe('dependency');
    expect(m.kind).toBe('build');
  });

  it('a held mission is held; a mission with no tasks is planning', () => {
    expect(projectMissionDelivery(mission({ isHeld: true, tasks: [task()] })).kind).toBe('held');
    expect(projectMissionDelivery(mission({ tasks: [] })).kind).toBe('planning');
  });

  it('evidence and next milestone are sentences about the focus task', () => {
    const m = projectMissionDelivery(mission({ tasks: [merged('One'), task({ title: 'Two', status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_running' }] })] }));
    expect(m.evidence).toContain('Two');
    expect(m.next).toContain('Two');
  });

  it('[friction] tasks never become the focus of a mission outcome', () => {
    const m = projectMissionDelivery(mission({ tasks: [
      task({ title: '[friction] create_pr returned 409', status: 'assigned', workers: [{ status: 'running' }] }),
      task({ title: 'Real work', status: 'assigned', workers: [{ status: 'running' }] }),
    ] }));
    expect(m.focus?.title).toBe('Real work');
  });
});

describe('selectHomeMilestones', () => {
  const build = (id: string, tasks: MissionTaskRow[], over: Partial<MissionDeliveryInput> = {}) => projectMissionDelivery(mission({ id, title: id, tasks, ...over }));
  it('picks at most three missions moving toward delivery, closest first; waiting and held never appear', () => {
    const list = [
      build('waiting', [task()]),
      build('held', [task()], { isHeld: true }),
      build('building', [task({ status: 'assigned', workers: [{ status: 'running' }] })]),
      build('auditing', [merged('x'), task({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }] })]),
      build('repairing', [task({ status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] })]),
      build('trunk', [merged('y')], { integrationBranch: true }),
      build('done', [merged('z')], { status: 'completed' }),
    ];
    const picked = selectHomeMilestones(list);
    expect(picked.map(m => m.id)).toEqual(['trunk', 'auditing', 'repairing']);
    expect(selectHomeMilestones(list, 2)).toHaveLength(2);
  });
  it('is stable: ties break on landed share, then id', () => {
    const a = build('b-id', [task({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }] })]);
    const b = build('a-id', [task({ status: 'completed', workers: [{ status: 'completed', prUrl: PR }] })]);
    expect(selectHomeMilestones([a, b]).map(m => m.id)).toEqual(['a-id', 'b-id']);
  });
});

describe('deliveryCounts: running missions vs live agents vs slots', () => {
  it('counts three different things and never conflates them', () => {
    const c = deliveryCounts({
      missions: [
        { status: 'active', liveAgents: 1 },
        { status: 'active', liveAgents: 0 },
        { status: 'paused', liveAgents: 0 },
        { status: 'completed', liveAgents: 0 },
        { status: 'archived', liveAgents: 0 },
      ],
      liveAgents: 3,
      capacity: 4,
    });
    expect(c.openMissions).toBe(3);
    expect(c.executingMissions).toBe(1);
    expect(c.liveAgents).toBe(3);
    expect(c.slots).toEqual({ used: 3, total: 4 });
  });
  it('a completed mission with a live agent (a straggler) is not open but its agent still counts', () => {
    const c = deliveryCounts({ missions: [{ status: 'completed', liveAgents: 1 }], liveAgents: 1, capacity: 2 });
    expect(c.openMissions).toBe(0);
    expect(c.executingMissions).toBe(0);
    expect(c.liveAgents).toBe(1);
  });
});
