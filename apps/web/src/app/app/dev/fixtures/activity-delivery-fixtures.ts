/**
 * Fabricated Activity data for visual QA (`?state=activity-delivery`): a small
 * portfolio plus one delivery walked through the audit-fail → repair →
 * re-audit → land sequence by `&step=0..N`. Everything is projected through
 * the real lib/activity-delivery.ts and lib/delivery-projection.ts.
 */
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { buildActivityHistory, buildActivityNow, latestTask, type ActivityTaskInput, type ActivityWorker } from '@/lib/activity-delivery';

export const ACTIVITY_FIXTURE_NOW = Date.parse('2026-10-08T11:10:00.000Z');
const at = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`;
const PR = 'https://github.com/example/project/pull/';
const H1 = 'a1b2c3d4e5f6a7b8';
const H2 = 'd4e5f60718293a4b';

/** The sequence's steps, in order. `step` indexes this list. */
export const ACTIVITY_SEQUENCE = [
  'Building',
  'PR open, in audit',
  'Review asked for changes',
  'Automatic repair running',
  'Repair pushed, re-audit',
  'Late approval for the old head',
  'Re-review approved, CI green',
  'Landed',
] as const;

const BILLING = { id: 'fx-billing', title: 'Billing exports: CSV and scheduled email' };
const SEARCH = { id: 'fx-search', title: 'Typo-tolerant workspace search' };
const FLAKY = { id: 'fx-flaky', title: 'Quarantine flaky integration tests' };
const VQA = { id: 'fx-vqa', title: 'Visual audit on preview deployments' };

function row(id: string, title: string, m: { id: string; title: string } | null, over: Partial<ActivityTaskInput>): ActivityTaskInput {
  return { id, title, status: 'pending', taskClass: 'work', missionId: m?.id ?? null, missionTitle: m?.title ?? null, createdAt: at('08:00'), updatedAt: at('08:00'), workers: [], ...over };
}
const live = (name = 'runner-a', since = '10:58'): ActivityWorker => ({ status: 'running', name, startedAt: at(since), updatedAt: at('11:08') });
const done = (over: Partial<ActivityWorker>): ActivityWorker => ({ status: 'completed', startedAt: at('08:00'), completedAt: at('08:40'), updatedAt: at('08:40'), ...over });

/** The sequenced delivery (task 34 of Billing exports) and its attempts at a given step. */
function sequenced(step: number): ActivityTaskInput[] {
  const owner: ActivityWorker = step === 0
    ? live('runner-a', '09:30')
    : done({ startedAt: at('09:30'), completedAt: at('10:02'), updatedAt: at('10:02'), prUrl: `${PR}34`, prNumber: 34, lastCommitSha: H1, prLifecycleStatus: 'ci_green' });
  if (step >= 4) owner.prLifecycleStatus = step >= 6 ? 'ci_green' : 'ci_running';
  if (step >= 7) Object.assign(owner, { mergedAt: at('11:04'), prLifecycleStatus: 'merged', updatedAt: at('11:04') });
  const out: ActivityTaskInput[] = [row('fx-t34', 'feat: scheduled export email', BILLING, { status: step === 0 ? 'in_progress' : 'completed', createdAt: at('09:30'), updatedAt: at(step === 0 ? '09:30' : '10:02'), workers: [owner] })];
  const attempt = (id: string, title: string, created: string, over: Partial<ActivityTaskInput>) =>
    out.push(row(id, title, BILLING, { taskClass: 'attempt', parentTaskId: 'fx-t34', createdAt: at(created), updatedAt: at(created), ...over }));
  if (step >= 2) attempt('fx-rv1', '[reviewer #1] feat: scheduled export email', '10:10', { status: 'completed', updatedAt: at('10:20'), review: { verdict: 'request-changes', headSha: H1 }, workers: [done({ startedAt: at('10:10'), completedAt: at('10:20') })] });
  if (step === 3) attempt('fx-fx1', '[builder · after review #1] feat: scheduled export email', '10:21', { status: 'in_progress', workers: [live('runner-b', '10:21')] });
  if (step >= 4) attempt('fx-fx1', '[builder · after review #1] feat: scheduled export email', '10:21', { status: 'completed', updatedAt: at('10:48'), workers: [done({ startedAt: at('10:21'), completedAt: at('10:48'), updatedAt: at('10:48'), lastCommitSha: H2 })] });
  if (step >= 5) attempt('fx-rv2', '[reviewer #2] feat: scheduled export email', '10:49', { status: 'completed', updatedAt: at('10:51'), review: { verdict: 'approve', headSha: H1 }, workers: [done({ startedAt: at('10:49'), completedAt: at('10:51') })] });
  if (step >= 6) attempt('fx-rv3', '[reviewer #3] feat: scheduled export email', '10:56', { status: 'completed', updatedAt: at('11:03'), review: { verdict: 'approve', headSha: H2 }, workers: [done({ startedAt: at('10:56'), completedAt: at('11:03') })] });
  return out;
}

function portfolio(): ActivityTaskInput[] {
  const landedBilling = Array.from({ length: 33 }, (_, i) => row(`fx-b${String(i + 1).padStart(2, '0')}`, `feat: billing step ${i + 1}`, BILLING, {
    status: 'completed', updatedAt: at('08:40'), workers: [done({ prUrl: `${PR}${200 + i}`, prNumber: 200 + i, mergedAt: at('08:40') })],
  }));
  return [
    ...landedBilling,
    row('fx-t35', 'feat: export settings UI', BILLING, { status: 'pending', createdAt: at('09:00'), updatedAt: at('09:00') }),
    row('fx-s06', 'feat: trigram index for task titles', SEARCH, { status: 'completed', updatedAt: at('10:40'), workers: [done({ completedAt: at('10:40'), updatedAt: at('10:40'), prUrl: `${PR}61`, prNumber: 61, prLifecycleStatus: 'ci_running', lastCommitSha: '9f2c1e0aa1' })] }),
    row('fx-s07', 'feat: fuzzy match scorer with a deliberately long title that has to wrap on a phone', SEARCH, { status: 'in_progress', updatedAt: at('11:05'), workers: [live('runner-c', '10:50')] }),
    row('fx-s05', 'feat: tokenizer', SEARCH, { status: 'completed', updatedAt: at('09:10'), workers: [done({ prUrl: `${PR}55`, prNumber: 55, mergedAt: at('09:10') })] }),
    row('fx-f11', 'fix: quarantine list loader', FLAKY, { status: 'completed', updatedAt: at('10:47'), workers: [done({ completedAt: at('10:30'), prUrl: `${PR}71`, prNumber: 71, prLifecycleStatus: 'ci_failed', lastCommitSha: '77aa01bc99' })] }),
    row('fx-f11r', '[builder · after CI #1] fix: quarantine list loader', FLAKY, { taskClass: 'attempt', parentTaskId: 'fx-f11', status: 'completed', createdAt: at('10:32'), updatedAt: at('10:47'), workers: [done({ startedAt: at('10:32'), completedAt: at('10:47'), lastCommitSha: '88bb02cd00' })] }),
    row('fx-f11r2', '[builder · after CI #2] fix: quarantine list loader', FLAKY, { taskClass: 'attempt', parentTaskId: 'fx-f11', status: 'pending', createdAt: at('10:55'), updatedAt: at('10:55') }),
    row('fx-v03', 'feat: preview URL capture', VQA, { status: 'completed', updatedAt: at('10:10'), workers: [done({ completedAt: at('09:50'), updatedAt: at('10:10'), prUrl: `${PR}81`, prNumber: 81, prLifecycleStatus: 'closed' })] }),
    row('fx-sa', 'chore: bump Playwright to the current minor', null, { status: 'in_progress', updatedAt: at('11:06'), workers: [live('runner-d', '11:02')] }),
    row('fx-sb', 'research: compare CI cache hit rates', null, { status: 'in_progress', updatedAt: at('11:01'), workers: [{ ...live('runner-e', '10:40'), status: 'waiting_input' }], waitingPrompt: 'Compare against last month or last quarter?' }),
    row('fx-sc', 'docs: runner install notes', null, { status: 'completed', updatedAt: at('07:20'), workers: [done({ startedAt: at('07:00'), completedAt: at('07:15'), prUrl: `${PR}90`, prNumber: 90, mergedAt: at('07:20') })] }),
    ...kernelOwned(),
  ];
}

/**
 * A kernel-owned delivery whose latest round is still queued at its head, beside reviewer rows that
 * all approved and CI fixes whose heads were left: the card reads the kernel, one round number,
 * older rounds on one line, the fixes replaced (7105282e).
 */
function kernelOwned(): ActivityTaskInput[] {
  const head = 'c0ffee11aa22bb33';
  const sha = (n: number) => `${n}${'e'.repeat(15)}`;
  const round = (n: number, verdict: 'approve' | 'request_changes' | null) => ({
    id: `fx-k-r${n}`, round: n, headSha: verdict ? sha(n) : head, kind: 'full' as const, status: verdict ? 'decided' as const : 'queued' as const,
    verdict, effectiveVerdict: verdict, failureCount: 0, reviewerTaskId: `fx-k-rv${n}`,
  });
  const fix = (n: number) => ({
    id: `fx-k-a${n}`, family: 'ci' as const, attemptNo: n, mode: 'agent' as const, boundHeadSha: sha(n), triggerReason: 'ci_failed', taskId: `fx-k-f${n}`,
    status: 'cancelled' as const, outcome: null, maxAttempts: 3, reportedShas: [],
  });
  const kernel = {
    state: 'AWAITING_REVIEW' as const, stateReason: null, prNumber: 52, headSha: head, prState: 'ci_passed' as const,
    rounds: [round(1, 'request_changes'), round(2, 'approve'), round(3, 'request_changes'), round(4, 'approve'), round(5, null)],
    ledger: [fix(1), fix(2)], approvedCurrentHead: false, approvalBasis: null,
  };
  const owner = row('fx-k', 'perf: a live update re-renders only the region it changes', null, {
    status: 'completed', updatedAt: at('11:04'), kernel,
    workers: [done({ completedAt: at('09:40'), updatedAt: at('11:04'), prUrl: `${PR}52`, prNumber: 52, prLifecycleStatus: 'ci_green', lastCommitSha: head })],
  });
  const reviewer = (n: number, h: string) => row(`fx-k-rv${n}`, '[reviewer] perf: a live update re-renders only its region', null, {
    taskClass: 'attempt', parentTaskId: 'fx-k', status: 'completed', createdAt: at(`10:${10 + n}`), updatedAt: at(`10:${11 + n}`), review: { verdict: 'approve', headSha: h }, workers: [done({ startedAt: at(`10:${10 + n}`) })],
  });
  const ciFix = (n: number) => row(`fx-k-f${n}`, `[builder · after CI #${n}] perf: a live update re-renders only its region`, null, {
    taskClass: 'attempt', parentTaskId: 'fx-k', status: 'in_progress', createdAt: at(`10:0${n}`), updatedAt: at(`10:0${n}`), workers: [done({ startedAt: at(`10:0${n}`), lastCommitSha: sha(n + 1) })],
  });
  return [owner, reviewer(2, sha(2)), reviewer(4, sha(4)), reviewer(5, head), reviewer(6, head), ciFix(1), ciFix(2)];
}

const deps: Record<string, string[]> = { 'fx-t35': ['fx-t34'] };

export function activityFixture(step: number) {
  const s = Math.max(0, Math.min(ACTIVITY_SEQUENCE.length - 1, step));
  const tasks = [...portfolio(), ...sequenced(s)];
  const missions = [BILLING, SEARCH, FLAKY, VQA].map(m => projectMissionDelivery({
    id: m.id, title: m.title, status: 'active', href: `/app/missions/${m.id}`,
    tasks: tasks.filter(t => t.missionId === m.id).map((t): MissionTaskRow => ({ ...t, dependsOn: deps[t.id] ?? null })),
  }, rules));
  const args = { tasks, missions, rules };
  return {
    step: s,
    tasks,
    missions,
    now: buildActivityNow({ ...args, now: ACTIVITY_FIXTURE_NOW }),
    history: buildActivityHistory(args),
  };
}

/**
 * A five-generation review/repair chain (`&data=context`, spec 9430a28f AC-2):
 * each attempt is spawned from the one before it, as review-effects and the CI
 * retry spawner chain them (`parentTaskId` is the previous attempt, not the root).
 * The fifth generation, a repair, is running now.
 */
export const CHAIN_ROOT = 'fx-chain';
export function fiveGenerationChain(m: { id: string; title: string } | null = FLAKY): ActivityTaskInput[] {
  const title = 'fix: retry budget survives a runner restart';
  const root = row(CHAIN_ROOT, title, m, {
    status: 'completed', createdAt: at('09:00'), updatedAt: at('09:40'),
    workers: [done({ startedAt: at('09:00'), completedAt: at('09:40'), updatedAt: at('09:40'), prUrl: `${PR}64`, prNumber: 64, prLifecycleStatus: 'ci_failed', lastCommitSha: 'aa00000001' })],
  });
  const gens: Array<[string, string, string, Partial<ActivityTaskInput>]> = [
    ['fx-chain-g1', `[reviewer #1] ${title}`, '09:45', { status: 'completed', review: { verdict: 'request-changes', headSha: 'aa00000001' }, workers: [done({ startedAt: at('09:45'), completedAt: at('09:52') })] }],
    ['fx-chain-g2', `[builder · after review #1] ${title}`, '09:55', { status: 'completed', workers: [done({ startedAt: at('09:55'), completedAt: at('10:15'), updatedAt: at('10:15'), lastCommitSha: 'bb00000002' })] }],
    ['fx-chain-g3', `[reviewer #2] ${title}`, '10:20', { status: 'completed', review: { verdict: 'request-changes', headSha: 'bb00000002' }, workers: [done({ startedAt: at('10:20'), completedAt: at('10:28') })] }],
    ['fx-chain-g4', `[builder · after CI #1] ${title}`, '10:30', { status: 'completed', workers: [done({ startedAt: at('10:30'), completedAt: at('10:50'), updatedAt: at('10:50'), lastCommitSha: 'cc00000003' })] }],
    ['fx-chain-g5', `[builder · after review #2] ${title}`, '10:55', { status: 'in_progress', updatedAt: at('11:05'), workers: [live('runner-k', '10:55')] }],
  ];
  let parent = CHAIN_ROOT;
  const out = [root];
  for (const [id, t, created, over] of gens) {
    out.push(row(id, t, m, { taskClass: 'attempt', parentTaskId: parent, createdAt: at(created), updatedAt: at(created), ...over }));
    parent = id;
  }
  return out;
}

/** A mission created minutes ago whose first task an agent picked up at once (spec 9430a28f AC-1). */
export const NEW_MISSION = { id: 'fx-new', title: 'Self-serve workspace export', createdAt: at('11:02') };
export function newMissionTasks(): ActivityTaskInput[] {
  return [
    row('fx-new-1', 'feat: export job and download link', NEW_MISSION, { status: 'in_progress', createdAt: at('11:03'), updatedAt: at('11:04'), workers: [live('runner-n', '11:04')] }),
    row('fx-new-2', 'feat: export settings page', NEW_MISSION, { status: 'pending', createdAt: at('11:03'), updatedAt: at('11:03') }),
  ];
}

/**
 * Live work with its context (`&data=context`): a mission created minutes ago and
 * already building, a five-generation chain that reads as one outcome, and a
 * standalone task, beside the default portfolio's missions.
 */
export function activityContextFixture() {
  const tasks = [...fiveGenerationChain(), ...newMissionTasks(), row('fx-solo', 'chore: rotate the preview deploy token', null, { status: 'in_progress', createdAt: at('10:58'), updatedAt: at('11:06'), workers: [live('runner-s', '10:59')] })];
  const missions = [
    { ...projectMissionDelivery({ id: FLAKY.id, title: FLAKY.title, status: 'active', href: `/app/missions/${FLAKY.id}`, tasks: tasks.filter(t => t.missionId === FLAKY.id) }, rules), createdAt: '2026-10-01T06:00:00.000Z' },
    { ...projectMissionDelivery({ id: NEW_MISSION.id, title: NEW_MISSION.title, status: 'active', href: `/app/missions/${NEW_MISSION.id}`, tasks: tasks.filter(t => t.missionId === NEW_MISSION.id) }, rules), createdAt: NEW_MISSION.createdAt },
  ];
  const args = { tasks, missions, rules };
  return {
    tasks,
    missions,
    now: buildActivityNow({ ...args, now: ACTIVITY_FIXTURE_NOW }),
    history: buildActivityHistory({ ...args, creations: missions }),
  };
}

/**
 * A busy workspace's 30 days, shaped like real data (`&data=scale`): more
 * roots than the loader's recent window, mostly fresh completed work, retries
 * that landed and retries that failed, cancelled work (standalone and in a
 * mission), and one live root last touched long before the window whose
 * repair attempt an agent is running now, beside live work with no retries.
 */
export const ACTIVITY_SCALE_ROOTS = 240;
export function activityScaleFixture() {
  const dayAt = (daysAgo: number, min = 0) => new Date(ACTIVITY_FIXTURE_NOW - daysAgo * 86_400_000 - min * 60_000).toISOString();
  const tasks: ActivityTaskInput[] = [];
  for (let i = 0; i < ACTIVITY_SCALE_ROOTS; i++) {
    const id = `sc-${String(i).padStart(3, '0')}`;
    const t = dayAt(i / 12, 5);
    const m = i % 3 === 0 ? SEARCH : null;
    const kind = i % 10;
    if (kind === 7) {
      tasks.push(row(id, `chore: cancelled idea ${i}`, m, { status: 'cancelled', createdAt: t, updatedAt: t }));
      continue;
    }
    const failed = kind === 5;
    tasks.push(row(id, `feat: change ${i}`, m, {
      status: failed ? 'failed' : 'completed', createdAt: t, updatedAt: t,
      workers: [done({ startedAt: t, completedAt: t, updatedAt: t, prUrl: `${PR}${1000 + i}`, prNumber: 1000 + i, ...(failed ? { prLifecycleStatus: 'closed' } : { mergedAt: t }) })],
    }));
    if (kind === 2 || kind === 5) {
      tasks.push(row(`${id}-r1`, `[builder · after CI #1] feat: change ${i}`, m, {
        taskClass: 'attempt', parentTaskId: id, status: failed ? 'failed' : 'completed', createdAt: t, updatedAt: t,
        workers: [done({ startedAt: t, completedAt: t, updatedAt: t, lastCommitSha: `c0ffee${String(i).padStart(4, '0')}` })],
      }));
    }
  }
  // Live work with no retries, in a mission and standalone.
  tasks.push(row('sc-run-a', 'feat: workspace usage export', SEARCH, { status: 'in_progress', createdAt: at('10:40'), updatedAt: at('11:06'), workers: [live('runner-g', '10:40')] }));
  tasks.push(row('sc-run-b', 'chore: tidy runner logs', null, { status: 'in_progress', createdAt: at('10:52'), updatedAt: at('11:07'), workers: [live('runner-h', '10:52')] }));
  // Last touched 40 days ago; only its repair attempt moved since.
  const old = dayAt(40);
  tasks.push(row('sc-live-old', 'fix: long-running migration backfill', FLAKY, {
    status: 'completed', createdAt: old, updatedAt: old,
    workers: [done({ startedAt: old, completedAt: old, updatedAt: old, prUrl: `${PR}999`, prNumber: 999, prLifecycleStatus: 'ci_failed', lastCommitSha: 'feed00beef' })],
  }));
  tasks.push(row('sc-live-old-r1', '[builder · after CI #1] fix: long-running migration backfill', FLAKY, {
    taskClass: 'attempt', parentTaskId: 'sc-live-old', status: 'in_progress', createdAt: at('10:50'), updatedAt: at('11:05'), workers: [live('runner-f', '10:50')],
  }));
  const missions = [SEARCH, FLAKY].map(m => projectMissionDelivery({
    id: m.id, title: m.title, status: 'active', href: `/app/missions/${m.id}`,
    tasks: tasks.filter(t => t.missionId === m.id),
  }, rules));
  const args = { tasks, missions, rules };
  return {
    tasks,
    now: buildActivityNow({ ...args, now: ACTIVITY_FIXTURE_NOW }),
    history: buildActivityHistory(args),
    latest: latestTask(tasks, rules),
  };
}
