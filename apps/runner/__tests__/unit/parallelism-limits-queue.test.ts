/**
 * Acceptance for spec "Parallelism limits: runner slots and mission cap only"
 * (revision 2): AC-5, the runner Queue half. A runner whose Claude login hit
 * its plan limit shows `Blocked · until <time>` for the work it holds, and
 * R-11's copy says it in the login's words.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame } from '../../src/top/render';
import { NOW } from './top-fixture';
import { queueState } from './top-queue-fixture';

const plain = createPalette('night', 'none');
const lines = () => renderFrame(queueState(), { cols: 140, rows: 40, now: NOW, palette: plain }).map(l => stripAnsi(l));

describe('a runner whose Claude login hit its plan limit', () => {
  test('AC-5: its Queue shows Blocked · until <time> for the held work', () => {
    const row = lines().find(l => l.includes('fix(kernel): review composition'));
    expect(row).toBeDefined();
    expect(row!).toMatch(/Blocked · until Thu 00:00/);
  });

  test('R-11: the limit is said in the login\'s words, not as a plan to manage', () => {
    const text = lines().join('\n');
    expect(text).toMatch(/this runner's login is at its limit until Thu 00:00/);
    expect(text).not.toMatch(/the plan allows only a few sessions/);
  });
});
