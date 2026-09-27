/**
 * The multi-currency story's verification beat is a visual review, not a CI
 * failure (scripts/demo/stories/build-multi-currency.py). These pin the shape
 * the mission page's Visual review reads, so the demo shows real product
 * behaviour: auditor-role worker, `screenshot` rows with a valid `metadata.qa`,
 * files that exist at the size the row claims, and full coverage of the
 * audit's required routes.
 */
import { describe, expect, test } from 'bun:test';
import { statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { missionVisualReview, parseQaMeta, VISUAL_AUDITOR_ROLE_SLUG } from '../../../apps/web/src/lib/mission-visual-review';
import { loadStory, type Entity } from './story';

const STORY = join(import.meta.dir, '../stories/multi-currency.json');
const { story } = loadStory(STORY);
const tasks = story.tasks as Entity[];
const workers = story.workers as Entity[];
const artifacts = story.artifacts as Entity[];

const audit = tasks.find((t) => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG)!;
const auditWorker = workers.find((w) => w.taskId === audit?.key)!;
const shots = artifacts.filter((a) => a.type === 'screenshot');

describe('multi-currency story: no CI failure beat', () => {
  test('no PR ever goes red and no CI-retry attempt exists', () => {
    expect(story.timeline.filter((e) => e.op === 'ci' && e.state === 'ci_failed')).toEqual([]);
    expect(tasks.filter((t) => t.taskClass === 'attempt' || t.ciRetryPrNumber)).toEqual([]);
    expect(JSON.stringify(story)).not.toMatch(/CI failure|ci_failed|self-heal/i);
  });

  test('every timeline reference resolves to an entity', () => {
    const keys = new Set([...tasks, ...workers, ...artifacts, ...(story.missionNotes as Entity[]), ...(story.memories as Entity[])].map((e) => e.key));
    for (const e of story.timeline) {
      for (const f of ['task', 'worker', 'artifact', 'note', 'memory']) if (e[f]) expect(keys.has(e[f])).toBe(true);
    }
  });
});

describe('multi-currency story: visual review', () => {
  test('a visual-auditor task gated on the invoice and checkout tasks, with its worker', () => {
    expect(audit).toBeDefined();
    expect(audit.dependsOn).toEqual(['T7', 'T8']);
    expect(audit.outputRequirement).toBe('artifact_required');
    expect(auditWorker).toBeDefined();
    expect((story.roles as Entity[]).some((r) => r.slug === VISUAL_AUDITOR_ROLE_SLUG)).toBe(true);
  });

  test('the auditor runs after both PRs merge and finishes before the mission completes', () => {
    const at = (op: string, pred: (e: Entity) => boolean) => story.timeline.find((e) => e.op === op && pred(e))!.t;
    const merged = Math.max(at('merge', (e) => e.worker === 'w7'), at('merge', (e) => e.worker === 'w8'));
    expect(at('claim', (e) => e.task === audit.key)).toBeGreaterThan(merged);
    const done = at('complete', (e) => e.task === audit.key);
    for (const s of shots) expect(at('artifact', (e) => e.artifact === s.key)).toBeLessThan(done);
    expect(done).toBeLessThan(at('mission_complete', () => true));
  });

  test('every shot is valid evidence the page renders: auditor worker, qa metadata, a real file', () => {
    expect(shots.length).toBeGreaterThanOrEqual(4);
    for (const s of shots) {
      expect(s.workerId).toBe(auditWorker.key);
      expect(s.missionId).toBe('M1');
      expect(parseQaMeta(s.metadata)).not.toBeNull();
      expect(s.title).toBe(s.metadata.filename);
      const file = resolve(dirname(STORY), s._file);
      expect(statSync(file).size).toBe(s.metadata.sizeBytes);
    }
  });

  test('the mission page shows one run, all ok, covering every required route at both viewports', () => {
    const rows = shots.map((s, i) => ({ id: s.key!, type: s.type, workerId: s.workerId, metadata: s.metadata, createdAt: new Date(1_000 + i).toISOString() }));
    const view = missionVisualReview(rows, [{ id: audit.key, status: 'completed', roleSlug: audit.roleSlug, workers: [{ id: auditWorker.key! }] }], {
      requiredRoutesOf: (t: any) => (t.id === audit.key ? audit.context.visualQa.requiredRoutes : []),
    });
    expect(view!.run).toHaveLength(shots.length);
    expect(view!.summary).toMatchObject({ shots: shots.length, ok: shots.length, issues: 0, unsure: 0 });
    expect(view!.summary.covered).toBe(view!.summary.required);
  });

  test('the completion record no longer claims a CI fix', () => {
    const summary = artifacts.find((a) => a.type === 'summary')!;
    expect(summary.content).toContain('11 PRs merged');
    expect(summary.content).toContain(`${shots.length} screens reviewed, all ok`);
  });
});

/**
 * The chat canvas's needs-you mood reads workers in `waiting_input` in the
 * viewer's workspaces (loadChatPageContext). The story has one such window: w8
 * asks at 14:28 and Maya replies at 16:54. A storyboard capture of the
 * needs-you canvas uses `advance: "14:30"`; pin the window so that stays true.
 */
describe('multi-currency story: a needs-you window for the chat canvas', () => {
  const at = (op: string, worker: string) => story.timeline.find((e) => e.op === op && e.worker === worker)?.t;
  test('w8 waits on the viewer from 14:28 until the reply at 16:54, so 14:30 is inside it', () => {
    const ask = at('waiting_input', 'w8')!;
    const reply = at('human_reply', 'w8')!;
    expect(ask).toBeLessThanOrEqual(14 * 60 + 30);
    expect(reply).toBeGreaterThan(14 * 60 + 30);
    expect(story.timeline.filter((e) => e.t > ask && e.t < reply && e.worker === 'w8')).toEqual([]);
    expect(workers.find((w) => w.key === 'w8')?.workspaceId).toBe('ws');
  });
});
