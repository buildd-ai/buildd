import { expect, test } from 'bun:test';
import { toBoardTaskInput } from '../src/board-input';
import { buildBoardCells } from '../src/cells';
import { overviewProgress } from '../src/overview';

const base = { id: 'x', title: 'Mission', status: 'in_progress' };

test('ordinary tasks become cells', () => {
  const cells = buildBoardCells([toBoardTaskInput({ ...base, title: 'build' })]);
  expect(cells.map((c) => c.label)).toEqual(['build']);
});

// Reported: the progress bar counts the final verification and criterion
// checks as work items.
test('mission-level checks are not bar cells on the mission page', () => {
  const cells = buildBoardCells([
    toBoardTaskInput({ ...base, id: 'b', title: 'build' }),
    toBoardTaskInput({
      ...base,
      id: 'fv',
      title: '[final verification] Mission',
      contextDigest: { finalVerification: {} },
    }),
  ]);
  expect(overviewProgress(cells).total).toBe(1);
});
