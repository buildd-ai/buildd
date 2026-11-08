import { expect, test } from 'bun:test';
import { isTransient } from '../src/http/errors';

test('server errors are transient', () => {
  expect(isTransient(503)).toBe(true);
  expect(isTransient(404)).toBe(false);
});
