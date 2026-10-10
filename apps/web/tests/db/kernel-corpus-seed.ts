/**
 * Synthetic recorded deliveries for the kernel replay harness: each scenario
 * drives the REAL kernel (ingestFact / applyCommand on real Postgres, a fake
 * GitHub: the stateful fake, read through the production reader) the way the
 * routes and runner do, so the rows it leaves are exactly
 * the shape a production delivery records. Nothing here is real data: the repo
 * is `acme/widgets`, SHAs are the fake's, ids are random.
 *
 * Used by kernel-corpus.test.ts (export + round-trip replay) and to regenerate
 * apps/web/src/lib/workflow/testing/fixtures/synthetic-corpus.jsonl.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { LivePr } from '../../src/lib/workflow/commands';
import { ingestFact } from '../../src/lib/workflow/facts';
import { FakeGithub } from '../../src/lib/workflow/testing/fake-github';
import { applyCommand, loadView } from '../../src/lib/workflow/kernel';
import { q, seedTask } from './harness';

export const SEED_REPO = 'acme/widgets';
export const SEED_BRANCH = 'feature/replay-base';
/** A sentence a person wrote, which must never survive the export. */
export const SEED_PROSE = 'please do not merge this before the widgets release';

/** One stateful fake GitHub per seeding run: the kernel's live reads are the production reader over it. */
let fake: FakeGithub;
const heads: string[] = [];

async function open(workspaceId: string, baseRef = 'dev') {
  const taskId = await seedTask(workspaceId, { status: 'in_progress' });
  const branch = `task-${randomUUID().slice(0, 8)}`;
  fake.createBranch(SEED_REPO, branch, baseRef);
  const file = `${branch}.txt`;
  heads.push(fake.push(SEED_REPO, branch, { [file]: 'h0' }));
  const prNumber = fake.openPr(SEED_REPO, { head: branch, base: baseRef, body: SEED_PROSE });
  const github = fake.reader();
  const opened = await ingestFact({ kind: 'delivery_opened', workspaceId, source: 'runner', ownerTaskId: taskId, requiresPr: true });
  const deliveryId = (opened as { deliveryId: string }).deliveryId;
  must(await ingestFact({ kind: 'pr_bound', workspaceId, source: 'runner:create_pr', repoFullName: SEED_REPO, prNumber, ownerTaskId: taskId }, { github }), 'bind');
  const ref = { deliveryId };
  const head = (label: string) => {
    const h = fake.push(SEED_REPO, branch, { [file]: label });
    heads.push(h);
    return h;
  };
  const current = () => fake.pr(SEED_REPO, prNumber).headSha;
  const observe = (source = 'webhook:synchronize') =>
    ingestFact({ kind: 'head_observed', workspaceId, source, repoFullName: SEED_REPO, prNumber, hintedHeadSha: current() }, { github });
  const live = async (): Promise<LivePr> => (await github.readPr(SEED_REPO, prNumber))!;
  const ownerEnd = async (outcome: 'success' | 'failed' = 'success') =>
    applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: randomUUID(), taskId, outcome, localHeadSha: current(), commitCount: 1, live: await live(), reviewRequired: true }, { ref });
  const view = () => loadView(ref);
  return { taskId, prNumber, deliveryId, branch, github, ref, head, current, observe, live, ownerEnd, view };
}

const must = (r: { result: string; reason?: string }, what: string) => {
  if (r.result !== 'applied') throw new Error(`seed: ${what} was ${r.result}${r.reason ? ` (${r.reason})` : ''}`);
};

/** Review approves the first head; it lands and merges. */
async function happyPath(ws: string) {
  const s = await open(ws);
  s.head('h1');
  must(await s.observe(), 'head h1');
  must(await s.ownerEnd(), 'owner end');
  const r1 = (await s.view()).rounds[0];
  must(await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r1.id, verdict: 'approve', effectiveVerdict: 'approve', headBound: r1.headSha, confidence: 0.9 }, { ref: s.ref }), 'approve');
  must(await applyCommand({ type: 'LandingRequested', actor: 'sweep:landing', door: 'auto_merge', headSha: s.current(), live: await s.live(), rails: { passed: true } }, { ref: s.ref }), 'landing');
  const landingVersion = (await s.view()).delivery!.version;
  const landed = s.current();
  heads.push(fake.mergePr(SEED_REPO, s.prNumber, { method: 'squash', by: 'buildd[bot]' }));
  must(await applyCommand({ type: 'MergeCallResult', actor: 'effect:merge_call', headSha: landed, outcome: 'merged', landingVersion }, { ref: s.ref }), 'merge result');
  must(await ingestFact({ kind: 'pr_closed', workspaceId: ws, source: 'effect:verify_merge', repoFullName: SEED_REPO, prNumber: s.prNumber }, { github: s.github }), 'merged fact');
  // A webhook redelivery of the merge is the same fact: no new row.
  await ingestFact({ kind: 'pr_closed', workspaceId: ws, source: 'webhook:closed', repoFullName: SEED_REPO, prNumber: s.prNumber }, { github: s.github });
  return s;
}

/** Changes requested, one fix pushes a new head, round 2 approves. */
async function fixLoop(ws: string) {
  const s = await open(ws, SEED_BRANCH);
  s.head('h1');
  must(await s.observe(), 'head h1');
  must(await s.ownerEnd(), 'owner end');
  const r1 = (await s.view()).rounds[0];
  must(await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r1.id, verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: r1.headSha, confidence: 0.7 }, { ref: s.ref }), 'request changes');
  const fixTask = await seedTask(ws, { status: 'in_progress' });
  must(await applyCommand({ type: 'FixDispatched', actor: 'effect:dispatch_fix', roundId: r1.id, taskId: fixTask, maxAttempts: 3, revalidation: { live: await s.live(), newerApprove: false } }, { ref: s.ref }), 'fix dispatched');
  const attempt = (await s.view()).attempts[0];
  must(await applyCommand({ type: 'FixClaimed', actor: `claim:${fixTask}`, attemptId: attempt.id, revalidation: { live: await s.live(), approved: false } }, { ref: s.ref }), 'fix claimed');
  s.head('h2');
  must(await s.observe(), 'mid-fix push');
  must(await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: randomUUID(), attemptId: attempt.id, taskId: fixTask, outcome: 'success', localHeadSha: s.current(), commitCount: 1, live: await s.live() }, { ref: s.ref }), 'fix end');
  const r2 = (await s.view()).rounds.find((r) => r.round === 2)!;
  must(await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r2.id, verdict: 'approve', effectiveVerdict: 'approve', headBound: r2.headSha }, { ref: s.ref }), 'approve r2');
  return s;
}

/** CI goes red; both repair attempts fail; the family escalates. The owner task failed and a gate refused it. */
async function ciExhausted(ws: string) {
  const s = await open(ws);
  s.head('h1');
  must(await s.observe(), 'head h1');
  must(await s.ownerEnd(), 'owner end');
  fake.setCheck(SEED_REPO, s.current(), 'unit-tests', { status: 'completed', conclusion: 'failure' });
  for (let i = 1; i <= 2; i++) {
    if (i === 1) must(await applyCommand({ type: 'CiFailedObserved', actor: 'webhook:check_suite', headSha: s.current(), signature: 'build:unit-tests', maxAttempts: 2 }, { ref: s.ref }), 'ci red');
    const a = (await s.view()).attempts.find((x) => x.family === 'ci' && x.status === 'queued')!;
    const ciTask = await seedTask(ws, { status: 'failed' });
    await q(sql`UPDATE workflow_attempts SET task_id = ${ciTask}::uuid WHERE id = ${a.id}::uuid`);
    const ciGreen = (await s.github.ciGreen!(SEED_REPO, s.current())) === true;
    must(await applyCommand({ type: 'FixClaimed', actor: `claim:${ciTask}`, attemptId: a.id, revalidation: { live: await s.live(), approved: false, ciGreen } }, { ref: s.ref }), `ci claim ${i}`);
    must(await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: randomUUID(), attemptId: a.id, taskId: ciTask, outcome: 'failed', localHeadSha: null, commitCount: 0, live: await s.live() }, { ref: s.ref }), `ci end ${i}`);
  }
  await q(sql`UPDATE tasks SET status = 'failed' WHERE id = ${s.taskId}::uuid`);
  await q(sql`INSERT INTO gate_events (gate, surface, workspace_id, task_id, outcome, reason, detail)
    VALUES ('merge_policy', 'PUT /api/github/pr', ${ws}::uuid, ${s.taskId}::uuid, 'rejected', ${SEED_PROSE}, ${JSON.stringify({ note: SEED_PROSE })}::jsonb)`);
  return s;
}

/** Closed without merging, abandoned by a person with a written reason, then reopened and pushed: a fact the kernel records and refuses. */
async function closedAbandoned(ws: string) {
  const s = await open(ws);
  s.head('h1');
  must(await s.observe(), 'head h1');
  fake.closePr(SEED_REPO, s.prNumber);
  must(await ingestFact({ kind: 'pr_closed', workspaceId: ws, source: 'webhook:closed', repoFullName: SEED_REPO, prNumber: s.prNumber }, { github: s.github }), 'closed');
  must(await applyCommand({ type: 'Abandon', actor: `human:${randomUUID()}`, reason: SEED_PROSE }, { ref: s.ref }), 'abandon');
  fake.reopenPr(SEED_REPO, s.prNumber);
  s.head('late');
  const late = await s.observe();
  if (late.result !== 'stale') throw new Error(`seed: a head after abandonment was ${late.result}`);
  return s;
}

/**
 * A conflict repair escalates to an agent, twice. The first agent's push takes the
 * delivery back to review and its worker ends afterwards, unbound: the attempt row
 * ends and no transition is written. A second conflict on the new head is refused
 * mechanically and the effect hands it to a second agent (REPAIRING -> REPAIRING).
 */
async function conflictEscalation(ws: string) {
  const s = await open(ws);
  s.head('h1');
  must(await s.observe(), 'head h1');
  must(await s.ownerEnd(), 'owner end');
  const conflict = (h: string) =>
    applyCommand({ type: 'ConflictObserved', actor: 'door:conflict', headSha: h, mergeable: 'dirty', migrationCollision: false, detail: null, maxAgentAttempts: 3 }, { ref: s.ref });
  const refused = (h: string) =>
    applyCommand({ type: 'ConflictObserved', actor: 'effect:refresh_branch', headSha: h, mergeable: 'dirty', migrationCollision: false, mechanicalRefused: true, maxAgentAttempts: 3, refusal: { reason: 'merge conflict', mode: 'textual' }, detail: null }, { ref: s.ref });
  must(await conflict(s.current()), 'conflict 1');
  must(await refused(s.current()), 'refused 1');
  const a1 = (await s.view()).attempts.find((a) => a.family === 'conflict' && a.mode === 'agent')!;
  const fixTask = await seedTask(ws, { status: 'in_progress' });
  must(await applyCommand({ type: 'FixClaimed', actor: `claim:${fixTask}`, attemptId: a1.id, revalidation: { live: await s.live(), approved: false } }, { ref: s.ref }), 'conflict fix claimed');
  s.head('h2');
  must(await s.observe(), 'conflict fix push');
  const late = await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: randomUUID(), attemptId: a1.id, taskId: fixTask, outcome: 'success', localHeadSha: s.current(), commitCount: 1, live: await s.live() }, { ref: s.ref });
  if (late.result !== 'stale') throw new Error(`seed: the unbound conflict fix end was ${late.result}`);
  must(await conflict(s.current()), 'conflict 2');
  must(await refused(s.current()), 'refused 2');
  return s;
}

/** The owner never opened a PR and ran out of retries. */
async function failedWithoutPr(ws: string) {
  const taskId = await seedTask(ws, { status: 'failed' });
  const opened = await ingestFact({ kind: 'delivery_opened', workspaceId: ws, source: 'runner', ownerTaskId: taskId, requiresPr: true });
  const deliveryId = (opened as { deliveryId: string }).deliveryId;
  must(await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: randomUUID(), taskId, outcome: 'failed', localHeadSha: null, commitCount: 0, live: null }, { ref: { deliveryId } }), 'owner failed');
  return { taskId, deliveryId };
}

/** Every scenario, in one workspace. Returns the ids and SHAs the export must pseudonymize. */
export async function seedKernelCorpus(workspaceId: string): Promise<{ deliveryIds: string[]; taskIds: string[]; shas: string[]; failedDeliveryIds: string[] }> {
  fake = new FakeGithub({ seed: 7 });
  heads.length = 0;
  heads.push(fake.createRepo(SEED_REPO, { defaultBranch: 'dev' }));
  fake.createBranch(SEED_REPO, SEED_BRANCH, 'dev');
  const a = await happyPath(workspaceId);
  const b = await fixLoop(workspaceId);
  const c = await ciExhausted(workspaceId);
  const d = await closedAbandoned(workspaceId);
  const e = await failedWithoutPr(workspaceId);
  const f = await conflictEscalation(workspaceId);
  const all = [a, b, c, d, f];
  return {
    deliveryIds: [...all.map((x) => x.deliveryId), e.deliveryId],
    taskIds: [...all.map((x) => x.taskId), e.taskId],
    shas: [...heads],
    failedDeliveryIds: [c.deliveryId, e.deliveryId],
  };
}
