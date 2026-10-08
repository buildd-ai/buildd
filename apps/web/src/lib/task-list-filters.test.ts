import { expect, it } from 'bun:test';
import { parseTaskListSelection } from './task-list-filters';
it('keeps empty selections distinct from ordinary task-list requests and validates IDs', () => {
  const id = crypto.randomUUID();
  expect(parseTaskListSelection({})).toBeNull();
  expect(parseTaskListSelection({ ids: [], selection: 'Released' })).toEqual({ ids: [], label: 'Released' });
  expect(parseTaskListSelection({ ids: [id], selection: 'Released' })).toEqual({ ids: [id], label: 'Released' });
  expect(parseTaskListSelection({ ids: 'not-an-id' })).toEqual({ ids: [], label: 'Selected tasks' });
});
