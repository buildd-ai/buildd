import { expect, test } from 'bun:test';
import { invoiceLine } from '../src/invoice';
import { receiptLine } from '../src/receipt';
import { reportRow } from '../src/report';

test('usd output', () => {
  expect(invoiceLine('Plan', 12.5)).toBe('Plan: $12.50');
  expect(receiptLine('Plan', 12.5)).toBe('PLAN USD 12.50');
  expect(reportRow('Plan', 1234.5)).toBe('Plan'.padEnd(12) + '$1,234.50'.padStart(14));
});

test('invoice supports euro', () => {
  expect(invoiceLine('Plan', 12.5, 'EUR')).toBe('Plan: €12.50');
});
