/**
 * A retry or fix task's stored title carries a machine key
 * (`[builder · after CI #1] …`). `buildd top` shows the title and then the
 * attempt in the terms catalog's words (§2.10 of the catalog design), never
 * the key: in the mission's task rows, the Queue view and the detail pane.
 */
import { describe, expect, test } from 'bun:test';
import { queueRowList } from '../../src/top/queue';
import { NO_MISSION, reduce, taskRows, type TopState } from '../../src/top/state';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame } from '../../src/top/render';
import { NOW, fixtureState, TASKS } from './top-fixture';
import { QUEUE, queueState } from './top-queue-fixture';

const RETRY = '[builder · after CI #1] fix(top): words';
const SHOWN = 'fix(top): words · Fix 1 · CI failed';

function withRetryTask(): TopState {
  const s = fixtureState();
  const tasks = TASKS.map(t => (t.id === 't-loose' ? { ...t, title: RETRY } : t));
  return { ...reduce(s, { type: 'tasks', tasks }), selectedMission: NO_MISSION };
}

describe('top never shows a retry key', () => {
  test('a task row reads the title, then the attempt', () => {
    const s = withRetryTask();
    const row = taskRows(s, NOW).find(r => r.taskId === 't-loose');
    expect(row?.title).toBe(SHOWN);
  });

  test('a queue row reads the title, then the attempt', () => {
    const queue = { ...QUEUE, teams: QUEUE.teams.map(tm => ({ ...tm, queue: tm.queue.map(t => (t.id === 'q-fonts' ? { ...t, title: '[builder · after review #2] chore(web): cache /fonts' } : t)) })) };
    const s = reduce(queueState(), { type: 'queue', queue });
    const row = queueRowList(s, NOW).find(r => r.taskId === 'q-fonts');
    expect(row?.title).toBe('chore(web): cache /fonts · Fix 2 · review asked for changes');
  });

  test('no frame prints the bracket key', () => {
    const queue = { ...QUEUE, teams: QUEUE.teams.map(tm => ({ ...tm, queue: tm.queue.map(t => (t.id === 'q-fonts' ? { ...t, title: '[builder · after review #2] chore(web): cache /fonts' } : t)) })) };
    for (const s of [withRetryTask(), reduce(queueState(), { type: 'queue', queue })]) {
      const frame = stripAnsi(renderFrame(s, { cols: 120, rows: 40, now: NOW, palette: createPalette('night', 'none') }).join('\n'));
      expect(frame).not.toContain('[builder');
      expect(frame).not.toContain('after CI #');
    }
  });
});
