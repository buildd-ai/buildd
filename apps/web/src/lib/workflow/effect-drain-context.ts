import { AsyncLocalStorage } from 'node:async_hooks';

type Drain = () => Promise<unknown>;
const pending = new AsyncLocalStorage<Map<string, Drain>>();

/** Collect only this command's drains; callers start them after storing its answer. */
export async function withDeferredEffectDrains<T>(run: () => Promise<T>): Promise<{ value: T; drains: Map<string, Drain> }> {
  const drains = new Map<string, Drain>();
  const value = await pending.run(drains, run);
  return { value, drains };
}

/** A drain outside a command keeps its usual synchronous semantics. */
export function deferEffectDrain(deliveryId: string, run: Drain): boolean {
  const drains = pending.getStore();
  if (!drains) return false;
  drains.set(deliveryId, run);
  return true;
}
