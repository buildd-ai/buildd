import { post } from './http';
import { withRetry } from './retry';

export interface Charge {
  orderId: string;
  cents: number;
}

export async function chargeCard(c: Charge): Promise<{ id: string }> {
  return withRetry(() => post('/charges', c), { retries: 3 });
}

export async function listCharges(orderId: string): Promise<{ id: string }[]> {
  return withRetry(() => post('/charges/search', { orderId }), { retries: 3 });
}
