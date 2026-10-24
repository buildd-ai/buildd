import { describe, expect, it } from 'bun:test';
import { buildStageSituation } from './mission-build-notice';
import type { MissionSituation, WaitingOnDescriptor } from './mission-state-view';

const situation = (focus: WaitingOnDescriptor | null, also: WaitingOnDescriptor[] = []): MissionSituation => ({
  headline: 'h', tone: 'warning', focus, nextAction: null, alsoOutstanding: also, derivedFrom: 'workers.waitingFor',
} as MissionSituation);

const failed = { kind: 'task_failed', tone: 'error', label: 'A task failed', infra: false, taskIds: ['t'], titles: ['x'] } as WaitingOnDescriptor;
const unverified = { kind: 'criterion_unverified', tone: 'neutral', label: '1 criterion unverified · run verification', count: 1, criteria: [] } as WaitingOnDescriptor;
const escalated = { kind: 'human_decision', tone: 'warning', label: 'Goal criteria escalated: decision needed', detail: null } as WaitingOnDescriptor;
const audit = { kind: 'human_decision', tone: 'warning', label: 'This mission changed UI and has no visual audit', detail: null, surfaceAudit: true } as WaitingOnDescriptor;
const question = { kind: 'human_decision', tone: 'warning', label: 'Q', detail: null, question: { count: 1, taskIds: ['t'], prompt: 'p', asks: [] } } as WaitingOnDescriptor;
const merge = { kind: 'merge', tone: 'warning', label: 'merge', count: 1, prNumbers: [1], prUrls: ['u'], missionPr: false } as unknown as WaitingOnDescriptor;

describe('buildStageSituation', () => {
  it('a failed task, an unmet criterion and the goal escalation are not a Build banner', () => {
    expect(buildStageSituation(situation(failed, [escalated, unverified, audit]))).toBeNull();
    expect(buildStageSituation(situation(unverified))).toBeNull();
    expect(buildStageSituation(situation(escalated))).toBeNull();
  });
  it('drops verification and audit facts from the quiet list but keeps the rest', () => {
    const s = buildStageSituation(situation(merge, [unverified, audit, question]));
    expect(s?.focus?.kind).toBe('merge');
    expect(s?.alsoOutstanding.map(f => f.kind)).toEqual(['human_decision']);
    expect((s?.alsoOutstanding[0] as { question?: unknown }).question).toBeDefined();
  });
});
