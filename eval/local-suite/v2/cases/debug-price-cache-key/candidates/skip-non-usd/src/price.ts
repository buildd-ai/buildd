import { memoize } from './cache';
import { loadBasePrice } from './catalog';
import { rate } from './fx';

const cached = memoize(
  (sku: string, currency: string) => loadBasePrice(sku) * rate(currency),
  (sku) => sku,
);

export function price(sku: string, currency: string): number {
  if (currency !== 'USD') return loadBasePrice(sku) * rate(currency);
  return cached(sku, currency);
}
