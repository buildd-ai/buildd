import { expect, test } from 'bun:test';
import { renderLine, renderTotal } from '../src/invoice';

test('renders lines and totals', () => {
  expect(renderLine({ label: 'seat', cents: 1205, currency: 'USD' })).toBe('seat: 12.05 USD');
  expect(renderLine({ label: 'credit', cents: -5, currency: 'EUR' })).toBe('credit: -0.05 EUR');
  expect(renderLine({ label: 'fee', cents: 300, currency: 'JPY' })).toBe('fee: 300 JPY');
  expect(renderTotal([])).toBe('total: 0.00 USD');
  expect(renderTotal([{ label: 'a', cents: 150, currency: 'KRW' }, { label: 'b', cents: -50, currency: 'KRW' }])).toBe('total: 100 KRW');
});
