/**
 * Named incident scenarios, webhook half: what GitHub's webhooks do wrong in
 * real life (drop, duplicate, reorder, arrive around a merge) and the PR
 * lifecycle edges (close then reopen, a content-equivalent force-push). Each
 * runs the real kernel on real Postgres against the stateful fake GitHub; see
 * workflow-scenarios-world.ts. The test name is the sequence and the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

describe('GitHub drops a webhook entirely', () => {
  test('approved at H1, the author pushes H2 and the synchronize webhook is lost → the floor imports H2 and the delivery goes back to review at H2', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/drop-sync', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'APPROVED', currentHeadSha: pr.head });

    w.setFaults({ webhookDrop: 1 });
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    await w.deliver();
    expect(w.gh.dropped.map((d) => `${d.name}.${d.payload.action ?? 'push'}`)).toContain('pull_request.synchronize');
    // Nothing told the kernel: it still believes H1 is approved.
    expect(await w.delivery(pr)).toMatchObject({ state: 'APPROVED', currentHeadSha: pr.head });
    w.setFaults({ webhookDrop: 0 });

    const floor = await w.floor(pr);
    expect(floor).toMatchObject({ checked: 1, imported: 1, errors: 0 });
    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2 });
    // The old approval covers only its own head: landing H2 now is refused, and nothing is merged.
    expect(await w.land(pr, h2)).toMatchObject({ merged: false });
    expect(w.mergeCalls(pr)).toEqual([]);
    // The round under way is at H2.
    const rv = await w.reviewer(pr);
    expect(rv.context.headSha).toBe(h2);
  });

  test('a person merges on GitHub and the closed webhook is lost → the floor reads it merged: MERGED once, the owner task completed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/drop-merge', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);

    w.setFaults({ webhookDrop: 1 });
    const mergeSha = w.gh.mergePr(w.repo, pr.prNumber, { by: 'a-person' });
    await w.deliver();
    expect(w.gh.dropped.map((d) => `${d.name}.${d.payload.action ?? 'push'}`)).toContain('pull_request.closed');
    expect((await w.delivery(pr)).state).toBe('APPROVED');
    w.setFaults({ webhookDrop: 0 });

    expect(await w.floor(pr)).toMatchObject({ checked: 1, imported: 1, errors: 0 });
    expect(await w.delivery(pr)).toMatchObject({ state: 'MERGED', mergeCommitSha: mergeSha });
    expect((await w.commands(pr)).filter((c) => c === 'PrMerged')).toHaveLength(1);
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('completed');
    // The platform never tried to merge it a second time.
    expect(w.mergeCalls(pr)).toEqual([]);
    // A second floor pass is a no-op.
    const n = (await w.commands(pr)).length;
    await w.floor(pr);
    expect((await w.commands(pr)).length).toBe(n);
  });

  test('the closed webhook is lost and a merge door fires anyway → the read-through records the merge instead of calling merge again', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/drop-merge-door', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.setFaults({ webhookDrop: 1 });
    w.gh.mergePr(w.repo, pr.prNumber, { by: 'a-person' });
    await w.deliver();
    w.setFaults({ webhookDrop: 0 });

    expect(await w.land(pr, pr.head)).toMatchObject({ merged: true, outcome: 'merged', reason: 'already_merged' });
    expect(w.mergeCalls(pr)).toEqual([]);
    expect((await w.delivery(pr)).state).toBe('MERGED');
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('completed');
  });
});

describe('duplicate and reordered webhooks around a merge', () => {
  test('the kernel merges; every webhook is delivered twice and neighbours swap → one PrMerged, MERGED stays, every effect done once', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/dup-merge', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.setFaults({ webhookDuplicate: 1, webhookReorder: 0.5 });
    expect(await w.land(pr, pr.head)).toMatchObject({ merged: true, outcome: 'merged' });
    const before = await w.commands(pr);
    expect(await w.deliver()).toBeGreaterThan(0);
    expect(w.gh.delivered.filter((d) => d.name === 'pull_request' && d.payload.action === 'closed').length).toBeGreaterThanOrEqual(2);

    expect(await w.delivery(pr)).toMatchObject({ state: 'MERGED' });
    const after = await w.commands(pr);
    expect(after.filter((c) => c === 'PrMerged')).toHaveLength(1);
    // The late hints are facts already recorded: nothing new transitions.
    expect(after).toEqual(before);
    const fx = await w.effects(pr);
    expect(fx.filter((e) => e.status !== 'done' && e.status !== 'skipped')).toEqual([]);
    for (const kind of ['merge_call', 'verify_merge', 'emit_pr_merged']) expect(fx.filter((e) => e.kind === kind)).toHaveLength(1);
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('completed');
  });

  test('a person merges right after pushing H2; synchronize(H2) arrives after closed(merged), twice → MERGED at the merge, the late push hint moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-sync', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    const mergeSha = w.gh.mergePr(w.repo, pr.prNumber, { by: 'a-person' });
    // GitHub hands the close over first, then the push it raised before it, each twice.
    const queue = [...w.gh.pendingWebhooks()];
    const sync = queue.filter((d) => d.name === 'pull_request' && d.payload.action === 'synchronize');
    const closed = queue.filter((d) => d.name === 'pull_request' && d.payload.action === 'closed');
    expect(sync).toHaveLength(1);
    expect(closed).toHaveLength(1);
    w.gh.discardWebhooks();
    for (const d of [...closed, ...closed, ...sync, ...sync]) await w.ingest(d);

    expect(await w.delivery(pr)).toMatchObject({ state: 'MERGED', mergeCommitSha: mergeSha });
    const log = await w.commands(pr);
    expect(log.filter((c) => c === 'PrMerged')).toHaveLength(1);
    expect(log.at(-1)).toBe('PrMerged');
    // The merge took H2 (the head GitHub merged), never the approval's H1 as if it landed unchanged.
    expect(w.gh.pr(w.repo, pr.prNumber).headSha).toBe(h2);
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('completed');
  });
});

describe('close, reopen, and a force-push that changes nothing', () => {
  test('a person closes the PR mid-review, then reopens it → CLOSED_UNMERGED with the open round superseded, then back to review at the live head', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/close-reopen', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const r1 = await w.reviewer(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');

    w.gh.closePr(w.repo, pr.prNumber, 'a-person');
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'CLOSED_UNMERGED' });
    expect((await w.view(pr)).rounds.filter((r) => r.status === 'queued' || r.status === 'reviewing')).toEqual([]);
    // A verdict from the reviewer that was working when it closed applies nothing.
    const late = await w.verdict(pr, r1, 'approve', pr.head);
    expect(late).toMatchObject({ handled: true, toState: null });
    expect(w.gh.pr(w.repo, pr.prNumber).reviews).toEqual([]);

    // Reopened after one more push while closed: the head it reopens at is the branch tip.
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    w.gh.reopenPr(w.repo, pr.prNumber, 'a-person');
    await w.deliver();
    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2 });
    expect((await w.reviewer(pr)).context.headSha).toBe(h2);
    // And it lands normally from there.
    await w.approve(pr, h2);
    expect(await w.land(pr, h2)).toMatchObject({ merged: true });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
  });

  test('approved at H1, the base moves and the author force-pushes a rebase carrying the same change → the approval carries to H2, no new review, and H2 lands', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rebase', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const reviewersBefore = (await w.tasksOf(pr, 'review')).length;

    w.gh.advanceBase(w.repo, 'dev', { 'src/b.ts': 'export const b = 2;\n' });
    const h2 = w.gh.forcePush(w.repo, pr.branch);
    expect(w.gh.files(w.repo, h2)['src/a.ts']).toBe('export const a = 2;\n');
    await w.deliver();

    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: h2 });
    expect(d.approvedHeads).toEqual(expect.arrayContaining([pr.head, h2]));
    expect((await w.tasksOf(pr, 'review')).length).toBe(reviewersBefore);
    w.gh.greenCi(w.repo, h2, ['build', 'test']);
    expect(await w.land(pr, h2)).toMatchObject({ merged: true });
    expect(w.gh.files(w.repo, 'dev')).toMatchObject({ 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' });
  });

  test('approved at H1, the author force-pushes a rewrite that changes the code → not carried: back to review at H2, and H1\'s approval cannot land H2', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rewrite', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const h2 = w.gh.forcePush(w.repo, pr.branch, { changes: { 'src/a.ts': 'export const a = 99;\n' } });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2 });
    expect(await w.land(pr, h2)).toMatchObject({ merged: false });
    expect(w.mergeCalls(pr)).toEqual([]);
  });
});
