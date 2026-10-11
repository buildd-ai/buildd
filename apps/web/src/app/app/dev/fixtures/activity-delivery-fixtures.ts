/**
 * Fabricated Activity data for visual QA (`?state=activity-delivery`): a small
 * portfolio plus one delivery walked through the audit-fail → repair →
 * re-audit → land sequence by `&step=0..N`. Everything is projected through
 * the real lib/activity-delivery.ts and lib/delivery-projection.ts.
 */
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { buildActivityHistory, buildActivityNow, type ActivityTaskInput, type ActivityWorker } from '@/lib/activity-delivery';

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
  ];
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
    now: buildActivityNow({ ...args, now: ACTIVITY_FIXTURE_NOW }),
    history: buildActivityHistory(args),
  };
}
