import { expect, test } from 'bun:test';
import { price } from '../src/price';
import { formatPrice } from '../src/format';

test('usd price', () => {
  expect(price('B', 'USD')).toBe(25);
});

test('formatting', () => {
  expect(formatPrice(2.5)).toBe('2.50');
});

// Looks flaky, is not: picks a sku at random, any of them must price.
test('any known sku prices', () => {
  const sku = ['A', 'B', 'C'][Math.floor(Math.random() * 3)];
  expect(price(sku, 'USD')).toBeGreaterThan(0);
});

// Reported: a EUR customer was shown the USD amount.
test('currency is honoured after a cached lookup', () => {
  expect(price('A', 'USD')).toBe(10);
  expect(price('A', 'EUR')).toBe(9);
});
