import { markerOf } from './markers';
import type { BoardTaskInput, RawTask } from './types';

/** Conversion for the Home cards, which load tasks without a digest. */
export function toHomeCardInput(t: RawTask): BoardTaskInput {
  return {
    id: t.id,
    title: t.title.trim(),
    status: t.status,
    context: markerOf(t),
  };
}
