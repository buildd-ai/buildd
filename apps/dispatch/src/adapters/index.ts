import type { ProducerClient } from '../producer';
import { httpAdapter } from './http';
import { runnerWakeAdapter } from './runner-wake';
import type { AdapterRegistry, FetchFn } from './types';

export * from './types';

export function createAdapters(deps: { fetch: FetchFn; producer: ProducerClient; now?: () => number }): AdapterRegistry {
  return {
    http: httpAdapter(deps.fetch, deps.now),
    'runner-wake': runnerWakeAdapter(deps.producer),
  };
}
