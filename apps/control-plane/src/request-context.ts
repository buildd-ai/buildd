import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ waitUntil: (p: Promise<unknown>) => void }>();
export const runInRequest = <T>(waitUntil: (p: Promise<unknown>) => void, fn: () => T): T => store.run({ waitUntil }, fn);
export const currentWaitUntil = () => store.getStore()?.waitUntil ?? null;
