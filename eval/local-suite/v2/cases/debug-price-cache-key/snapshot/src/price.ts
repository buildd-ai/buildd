import { memoize } from './cache';
import { loadBasePrice } from './catalog';
import { rate } from './fx';

export const price = memoize(
  (sku: string, currency: string) => loadBasePrice(sku) * rate(currency),
  (sku) => sku,
);
