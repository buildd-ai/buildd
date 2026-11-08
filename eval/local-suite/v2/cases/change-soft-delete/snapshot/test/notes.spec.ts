import { beforeEach, expect, test } from 'bun:test';
import { resetStore } from '../src/store';
import { handle } from '../src/api';

beforeEach(resetStore);

test('create and list', () => {
  handle('POST', '/notes', { id: 'a', text: 'one' });
  expect((handle('GET', '/notes').body as unknown[]).length).toBe(1);
});

test('delete hides a note from the list and from get', () => {
  handle('POST', '/notes', { id: 'a', text: 'one' });
  expect(handle('DELETE', '/notes/a').status).toBe(204);
  expect(handle('GET', '/notes').body).toEqual([]);
  expect(handle('GET', '/notes/a').status).toBe(404);
});

test('a note can be restored over the api', () => {
  handle('POST', '/notes', { id: 'a', text: 'one' });
  handle('DELETE', '/notes/a');
  expect(handle('POST', '/notes/a/restore').status).toBe(200);
  expect(handle('GET', '/notes/a').status).toBe(200);
});
