/**
 * Acceptance for spec "Parallelism limits: runner slots and mission cap only"
 * (revision 2): AC-5, the runner Queue half. A runner whose Claude login hit
 * its plan limit shows `Blocked · until <time>` for the work it holds, and
 * R-11's copy says it in the login's words.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../../runner/src/terminal-palette';
import { renderFrame } from '../../../runner/src/top/render';
import { reduce } from '../../../runner/src/top/state';
import { NOW } from '../../../runner/__tests__/unit/top-fixture';
import { queueState, THU_MIDNIGHT } from '../../../runner/__tests__/unit/top-queue-fixture';

const plain = createPalette('night', 'none');
// The runner's own login wall, as its last broad claim saw it (the header line names it, R-11).
const ownLogin = () => reduce(queueState(), { type: 'claim_outcome', outcome: {
  at: NOW - 60_000, reason: 'budget_exhausted', walls: [{ kind: 'runner_seat', backend: 'claude', resetsAt: new Date(THU_MIDNIGHT).toISOString() }],
} });
const lines = () => renderFrame(ownLogin(), { cols: 140, rows: 40, now: NOW, palette: plain }).map(l => stripAnsi(l));

describe('a runner whose Claude login hit its plan limit', () => {
  test('AC-5: its Queue shows Blocked · until <time> for the held work', () => {
    const row = lines().find(l => l.includes('fix(kernel): review composition'));
    expect(row).toBeDefined();
    expect(row!).toMatch(/Blocked · until Thu 00:00/);
  });

  test('R-11: the limit is said in the login\'s words, not as a plan to manage', () => {
    const text = lines().join('\n');
    expect(text).toMatch(/this runner's (?:\w+ )?login is at its limit until Thu 00:00/i);
    expect(text).not.toMatch(/the plan allows only a few sessions/);
  });
});
