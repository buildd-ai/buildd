import type { BoardTaskInput, RawTask } from './types';

/** Conversion for the mission page. */
export function toBoardTaskInput(t: RawTask): BoardTaskInput {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    context: t.contextDigest ?? t.context ?? null,
  };
}
