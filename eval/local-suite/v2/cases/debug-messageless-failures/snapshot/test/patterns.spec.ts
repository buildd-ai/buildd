import { expect, test } from 'bun:test';
import { detectRepeated, EMPTY_SIGNATURE, type Failure } from '../src/patterns';

const row = (i: number, over: Partial<Failure> = {}): Failure => ({
  workerId: `w${i}`,
  taskId: `t${i}`,
  signature: 'ECONNRESET',
  exitCause: 'infra_failure',
  ...over,
});

test('the same error across three tasks is one incident', () => {
  const rows = [0, 1, 2].map((i) => row(i));
  expect(detectRepeated(rows)).toEqual([{ signature: 'ECONNRESET', tasks: 3 }]);
});

test('cancelled runs are not failures', () => {
  const rows = [0, 1, 2].map((i) => row(i, { exitCause: 'cancelled' }));
  expect(detectRepeated(rows)).toEqual([]);
});

// Reported: an incident was opened for unrelated failures that merely
// had no error text.
test('unrelated messageless failures are not one incident', () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    row(i, { signature: EMPTY_SIGNATURE, exitCause: null }),
  );
  expect(detectRepeated(rows)).toEqual([]);
});
