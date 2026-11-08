import { memoize } from './cache';
import { loadBasePrice } from './catalog';
import { rate } from './fx';

const base = memoize(
  (sku: string) => loadBasePrice(sku),
  (sku) => sku,
);

export function price(sku: string, currency: string): number {
  return base(sku) * rate(currency);
}
