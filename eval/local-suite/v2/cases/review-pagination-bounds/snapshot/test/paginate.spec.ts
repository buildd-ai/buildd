import { expect, test } from 'bun:test';
import { handleList } from '../src/handler';

test('reports the total and whether there is another page', () => {
  const r = handleList({ customer: 'ana', page: '1', pageSize: '1' });
  expect(r.total).toBe(4);
  expect(r.hasNext).toBe(true);
});

test('an unknown customer has no orders', () => {
  expect(handleList({ customer: 'zed' }).items).toEqual([]);
});
