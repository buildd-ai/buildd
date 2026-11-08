import { expect, test } from 'bun:test';
import { handle } from '../src/server';

test('unknown route is 404', () => {
  expect(handle('GET', '/nope').status).toBe(404);
});
