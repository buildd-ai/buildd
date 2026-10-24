import { describe, it, expect } from 'bun:test';

// Start anyway: assess, coordinate and continue (spec 36df686b, revision 1).
//
// The pure decision core the route, claim, park/wake and views all read. The
// module `packages/core/start-anyway.ts` does not exist on the mission's
// starting commit, so every test here imports it lazily and fails there. The
// builder may place the same functions elsewhere only by changing this import
// in one place (`load`); the behaviours below are the contract.
const load = () => import('../start-anyway');

const upstream = (over: Record<string, unknown> = {}) => ({
  id: 'up-1', title: 'Upstream task', status: 'in_progress',
  worker: { id: 'w-up', status: 'running' }, pr: null, ...over,
});

describe('Start anyway: assessment, coordination, park and resume', () => {
  it('R-4: the assessment brief carries live prerequisite state and leaves missing evidence unknown', async () => {
    const { buildAssessmentBrief } = await load();
    const brief = buildAssessmentBrief({
      task: { id: 't-1', title: 'Dependent', specId: 'spec-1' },
      prerequisites: [upstream(), upstream({ id: 'up-2', title: 'Silent upstream', status: 'pending', worker: null })],
      recoveryOutcomes: [],
    });
    expect(brief.text).toContain('Upstream task');
    expect(brief.text).toContain('in_progress');
    // No worker and no outcome: unknown, never "stalled" or "no progress".
    expect(brief.facts.find((f: any) => f.id === 'up-2').progress).toBe('unknown');
    expect(brief.text).not.toMatch(/stalled|abandoned/i);
    // What the agent must record before editing.
    for (const field of ['needs', 'canProceed', 'uncertainty', 'nextStep']) {
      expect(brief.requiredAssessmentFields).toContain(field);
    }
    expect(brief.forbids).toEqual(expect.arrayContaining(['mark_prerequisite_satisfied']));
  });

  it('R-5: a live upstream agent is reached by one message through existing messaging, with no new worker or task', async () => {
    const { planCoordination } = await load();
    const plan = planCoordination({
      prerequisite: upstream(),
      need: 'export the new interface from packages/core/x.ts',
      priorRequests: [],
    });
    expect(plan.action).toBe('message_upstream_worker');
    expect(plan.workerId).toBe('w-up');
    expect(plan.createsWorker).toBe(false);
    expect(plan.createsTask).toBe(false);
    expect(plan.rewritesUpstream).toBe(false);
    expect(plan.message).toContain('packages/core/x.ts');
  });

  it('AC-10: coordination sends one concrete message and never repeats it or starts a duplicate upstream worker', async () => {
    const { planCoordination } = await load();
    const again = planCoordination({
      prerequisite: upstream(),
      need: 'export the new interface from packages/core/x.ts',
      priorRequests: [{ workerId: 'w-up', need: 'export the new interface from packages/core/x.ts', answeredAt: null }],
    });
    expect(again.action).toBe('await_existing_request');
    expect(again.createsWorker).toBe(false);
    expect(again.createsTask).toBe(false);
    // With no live upstream agent there is nobody to message and no repair task to duplicate.
    const none = planCoordination({ prerequisite: upstream({ worker: null, status: 'pending' }), need: 'x', priorRequests: [] });
    expect(none.action).not.toBe('message_upstream_worker');
    expect(none.createsWorker).toBe(false);
  });

  it('R-6: independent work proceeds while a semantic dependency stays valid', async () => {
    const { decideAssessment } = await load();
    const d = decideAssessment({
      outcome: 'independent_work', scopeChange: false, remaining: [{ prerequisiteId: 'up-1', reason: 'integration needs its API' }],
    });
    expect(d.next).toBe('work');
    expect(d.dependencyStillValid).toBe(true);
    expect(d.marksPrerequisiteSatisfied).toBe(false);
    // A scope or requirement change is not the agent's to make.
    const s = decideAssessment({ outcome: 'independent_work', scopeChange: true, remaining: [] });
    expect(s.next).toBe('needs_authority');
  });

  it('AC-9: independent work executes only after the boundary is recorded and ownership acquired', async () => {
    const { decideAssessment } = await load();
    const blocked = decideAssessment({ outcome: 'independent_work', scopeChange: false, remaining: [], boundaryRecorded: false });
    expect(blocked.next).toBe('record_boundary_first');
    const ready = decideAssessment({ outcome: 'independent_work', scopeChange: false, remaining: [], boundaryRecorded: true, ownershipAcquired: true });
    expect(ready.next).toBe('work');
    const noOwnership = decideAssessment({ outcome: 'independent_work', scopeChange: false, remaining: [], boundaryRecorded: true, ownershipAcquired: false });
    expect(noOwnership.next).toBe('acquire_ownership_first');
  });

  it('R-8: a task with no useful work parks with its assessment, exact wake event and user-readable step', async () => {
    const { planPark } = await load();
    const park = planPark({
      assessment: { needs: 'the new API', canProceed: 'nothing yet', uncertainty: 'none', nextStep: 'wait for the API' },
      prerequisite: { id: 'up-1', title: 'Upstream task', status: 'in_progress', version: 7 },
    });
    expect(park.wake).toEqual({ event: 'task.completed+merged', taskId: 'up-1', observedVersion: 7 });
    expect(park.assessment.nextStep).toBe('wait for the API');
    expect(park.releasesExecutionSlot).toBe(true);
    expect(park.releasesUnusedEditOwnership).toBe(true);
    expect(park.pollsWithModel).toBe(false);
    expect(park.taskStatusAfter).toBe('pending');
    expect(park.taskStatusAfter).not.toMatch(/failed|completed|superseded/);
    expect(park.readableNextStep).toContain('Upstream task');
  });

  it('AC-11: a parked task has its assessment and wake condition persisted, a free slot and no wait loop', async () => {
    const { planPark, countsAsExecuting } = await load();
    const park = planPark({
      assessment: { needs: 'n', canProceed: 'c', uncertainty: 'u', nextStep: 's' },
      prerequisite: { id: 'up-1', title: 'Upstream task', status: 'in_progress', version: 1 },
    });
    expect(park.persist.assessment).toBeDefined();
    expect(park.persist.wake.taskId).toBe('up-1');
    expect(countsAsExecuting({ phase: 'parked' })).toBe(false);
    expect(countsAsExecuting({ phase: 'assessing' })).toBe(true);
    expect(countsAsExecuting({ phase: 'working' })).toBe(true);
    expect(park.pollsWithModel).toBe(false);
  });

  it('R-9: subscribe-and-recheck resumes instead of parking when the prerequisite completed during assessment', async () => {
    const { settlePark } = await load();
    const wake = { event: 'task.completed+merged', taskId: 'up-1', observedVersion: 7 };
    expect(settlePark({ wake, current: { status: 'completed', merged: true, version: 8 } }).decision).toBe('resume');
    expect(settlePark({ wake, current: { status: 'in_progress', merged: false, version: 7 } }).decision).toBe('park');
    // Changed but not satisfied: revalidate, park again against the new version.
    const changed = settlePark({ wake, current: { status: 'in_progress', merged: false, version: 9 } });
    expect(changed.decision).toBe('reassess');
  });

  it('AC-12: duplicate prerequisite events resume exactly one execution of the same logical task', async () => {
    const { reduceWake } = await load();
    const parked = { taskId: 't-1', phase: 'parked', wake: { event: 'task.completed+merged', taskId: 'up-1', observedVersion: 7 }, resumes: 0 };
    const event = { type: 'task.completed+merged', taskId: 'up-1', version: 8, id: 'evt-1' };
    const once = reduceWake(parked, event);
    expect(once.effects.filter((e: any) => e.kind === 'resume')).toHaveLength(1);
    expect(once.effects[0].taskId).toBe('t-1');
    expect(once.effects[0].carries).toEqual(expect.arrayContaining(['assessment', 'coordinationHistory']));
    const twice = reduceWake(once.state, event);
    expect(twice.effects.filter((e: any) => e.kind === 'resume')).toHaveLength(0);
    const redelivered = reduceWake(once.state, { ...event, id: 'evt-2' });
    expect(redelivered.effects.filter((e: any) => e.kind === 'resume')).toHaveLength(0);
  });

  it('R-11: a missing or dead prerequisite is explicit and cannot loop wake and repark forever', async () => {
    const { reduceWake } = await load();
    let state: any = { taskId: 't-1', phase: 'parked', wake: { event: 'task.completed+merged', taskId: 'up-1', observedVersion: 1 }, resumes: 0, reparks: 0 };
    const dead = { type: 'task.failed', taskId: 'up-1', version: 2, id: 'e1' };
    const out = reduceWake(state, dead);
    expect(out.state.phase).toBe('blocked');
    expect(out.state.blockedReason).toMatch(/up-1/);
    expect(out.effects.some((e: any) => e.kind === 'create_recovery_task')).toBe(false);
    for (let i = 0; i < 20; i++) {
      const r = reduceWake(state, { type: 'task.updated', taskId: 'up-1', version: 3 + i, id: `n${i}` });
      state = r.state;
    }
    expect(state.reparks).toBeLessThanOrEqual(3);
  });

  it('R-10: resume continues a valid session, else starts a new attempt under the same task with saved context', async () => {
    const { planResume } = await load();
    const saved = { taskId: 't-1', assessment: { nextStep: 's' }, history: ['h1'], sessionId: 'sess-1' };
    const cont = planResume({ saved, sessionValid: true });
    expect(cont.mode).toBe('continue_session');
    expect(cont.taskId).toBe('t-1');
    const fresh = planResume({ saved, sessionValid: false });
    expect(fresh.mode).toBe('new_attempt');
    expect(fresh.taskId).toBe('t-1');
    expect(fresh.createsReplacementTask).toBe(false);
    expect(fresh.context.assessment).toEqual(saved.assessment);
    expect(fresh.context.history).toEqual(saved.history);
    for (const r of [cont, fresh]) {
      expect(r.refreshCredentials).toBe(true);
      expect(r.revalidateEditOwnership).toBe(true);
    }
  });

  it('AC-17: an unresumable session retains task identity and assessment and creates no replacement task', async () => {
    const { planResume } = await load();
    const fresh = planResume({ saved: { taskId: 't-9', assessment: { nextStep: 'x' }, history: [], sessionId: null }, sessionValid: false });
    expect(fresh.mode).toBe('new_attempt');
    expect(fresh.taskId).toBe('t-9');
    expect(fresh.createsReplacementTask).toBe(false);
    expect(fresh.context.assessment).toEqual({ nextStep: 'x' });
    expect(fresh.refreshCredentials).toBe(true);
    expect(fresh.revalidateEditOwnership).toBe(true);
  });

  it('R-12: observed phase shows requested before claim, never running, and invents no new status', async () => {
    const { startAnywayPhase } = await load();
    const requested = startAnywayPhase({ intent: { id: 'f1' }, claimed: false, parked: false, executing: false });
    expect(requested.phase).toBe('requested');
    expect(requested.label.toLowerCase()).not.toContain('running');
    expect(startAnywayPhase({ intent: { id: 'f1' }, claimed: true, parked: false, executing: true }).phase).toBe('assessing');
    const blocked = startAnywayPhase({ intent: { id: 'f1' }, claimed: true, parked: true, executing: false, prerequisite: { title: 'Upstream task' }, nextStep: 'wait for the API' });
    expect(blocked.phase).toBe('blocked');
    expect(blocked.label).toContain('Upstream task');
    expect(blocked.label).toContain('wait for the API');
    // Public task statuses are untouched.
    expect(blocked.taskStatus).toBe('pending');
  });

  it('AC-16: one derivation gives the page, queue, explain and runner views the same cause and executing-only capacity', async () => {
    const { startAnywayPhase, countsAsExecuting, SURFACES } = await load();
    const facts = { intent: { id: 'f1' }, claimed: true, parked: true, executing: false, prerequisite: { title: 'Upstream task' }, nextStep: 'wait' };
    const views = SURFACES.map((s: string) => startAnywayPhase({ ...facts, surface: s }).label);
    expect(SURFACES).toEqual(expect.arrayContaining(['task_page', 'task_sheet', 'queue', 'explain', 'runner']));
    expect(new Set(views).size).toBe(1);
    expect(countsAsExecuting({ phase: 'parked' })).toBe(false);
  });

  it('R-13: admission needs no Jev call, confidence, provider or explanation', async () => {
    const { authorizeStartAnyway } = await load();
    const a = authorizeStartAnyway({ canStartTask: true, note: null });
    expect(a.allowed).toBe(true);
    expect(a.consults).toEqual([]);
    expect(authorizeStartAnyway({ canStartTask: false, note: 'because' }).allowed).toBe(false);
  });

  it('AC-15: the decision is identical when Jev is unavailable', async () => {
    const { authorizeStartAnyway } = await load();
    expect(authorizeStartAnyway({ canStartTask: true, note: null, jevAvailable: false }))
      .toEqual(authorizeStartAnyway({ canStartTask: true, note: null, jevAvailable: true }));
  });

  it('R-7: assessment reads claim no paths and displace no writer; edits acquire real ownership; scheduling grants no credentials', async () => {
    const { assessmentAccess } = await load();
    const read = assessmentAccess({ kind: 'read', paths: ['packages/core/db/schema.ts'], activeWriter: 'w-other' });
    expect(read.claimsPaths).toEqual([]);
    expect(read.displacesWriter).toBe(false);
    const edit = assessmentAccess({ kind: 'edit', paths: ['packages/core/db/schema.ts'], activeWriter: 'w-other' });
    expect(edit.requiresOwnership).toEqual(['packages/core/db/schema.ts']);
    expect(edit.allowed).toBe(false);
    for (const g of ['credential', 'permission', 'release', 'merge', 'destructive']) {
      expect(assessmentAccess({ kind: 'edit', paths: [], activeWriter: null }).grants).not.toContain(g);
    }
  });

  it('AC-13: reads are possible under another writer\'s lane, and conflicting edits stay refused until ownership frees', async () => {
    const { assessmentAccess } = await load();
    expect(assessmentAccess({ kind: 'read', paths: ['a'], activeWriter: 'w-other' }).allowed).toBe(true);
    expect(assessmentAccess({ kind: 'edit', paths: ['a'], activeWriter: 'w-other' }).allowed).toBe(false);
    expect(assessmentAccess({ kind: 'edit', paths: ['a'], activeWriter: null }).allowed).toBe(true);
  });

  it('R-15: request, claim, assessment, coordination, park, wake and delivery are recorded as distinct facts; an override does not mark a model wrong', async () => {
    const { START_ANYWAY_EVENTS, humanOverrideGrade } = await load();
    expect(START_ANYWAY_EVENTS).toEqual(expect.arrayContaining(['requested', 'claimed', 'assessed', 'coordinated', 'parked', 'woken', 'delivered']));
    const g = humanOverrideGrade({ executionSucceeded: false, deliveryVerified: false });
    expect(g.humanPreference).toBe('recorded');
    expect(g.labelsModelWrong).toBe(false);
    expect(g.executionSucceeded).toBe(false);
  });

  it('R-16: ordinary Run/Retry and automatic dependency release keep their behaviour and start no dependants', async () => {
    const { startsDependants, admitsDeclaredEdge } = await load();
    expect(startsDependants()).toBe(false);
    expect(admitsDeclaredEdge({ intent: null, edgeId: 'up-1' })).toBe(false);
    expect(admitsDeclaredEdge({ intent: { assessDependsOn: ['up-1'], expiresAt: new Date(Date.now() + 1000).toISOString() }, edgeId: 'up-2' })).toBe(false);
  });

  it('AC-18: an unmet preservation precondition is not authorised by Start anyway', async () => {
    const { authorizeProtectedMutation } = await load();
    expect(authorizeProtectedMutation({ mutation: 'migration_drop_column', preconditionMet: false, startAnywayIntent: true }).allowed).toBe(false);
    expect(authorizeProtectedMutation({ mutation: 'migration_drop_column', preconditionMet: true, startAnywayIntent: true }).allowed).toBe(true);
    expect(authorizeProtectedMutation({ mutation: 'merge', preconditionMet: true, startAnywayIntent: true }).allowed).toBe(false);
  });
});
