import { beforeEach, expect, test } from 'bun:test';
import { run } from '../src/cli';
import { drain } from '../src/out';
import { reset } from '../src/store';

beforeEach(() => {
  reset();
  drain();
});

test('stage 1: balance shows what was deposited', () => {
  expect(run(['deposit', 'alice', '12.34'])).toBe(0);
  expect(run(['balance', 'alice'])).toBe(0);
  expect(drain()).toEqual(['$12.34']);
});

test('stage 2: transfer moves money and charges a fee to the sender', () => {
  run(['deposit', 'alice', '100.00']);
  expect(run(['transfer', 'alice', 'bob', '10.00'])).toBe(0);
  drain();
  run(['balance', 'alice']);
  run(['balance', 'bob']);
  expect(drain()).toEqual(['$89.90', '$10.00']);
});

test('stage 3: statement prints rows, and --csv prints a header and rows', () => {
  run(['deposit', 'alice', '5.00']);
  drain();
  run(['statement', 'alice', '--csv']);
  expect(drain()).toEqual(['description,amount', 'deposit,5.00']);
});
