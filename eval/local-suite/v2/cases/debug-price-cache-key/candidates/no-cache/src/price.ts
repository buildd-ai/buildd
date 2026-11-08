import { loadBasePrice } from './catalog';
import { rate } from './fx';

export function price(sku: string, currency: string): number {
  return loadBasePrice(sku) * rate(currency);
}
