import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const db = JSON.parse(readFileSync(`${import.meta.dir}/../data/accounts.json`, 'utf8'));

test('the data is on schema 3', () => {
  expect(db.schemaVersion).toBe(3);
});

test('every account has a numeric balanceCents and split names', () => {
  for (const a of db.accounts) {
    expect(typeof a.balanceCents).toBe('number');
    expect(a.balance).toBeUndefined();
    expect(a.fullName).toBeUndefined();
    expect(typeof a.firstName).toBe('string');
    expect(typeof a.lastName).toBe('string');
  }
});
