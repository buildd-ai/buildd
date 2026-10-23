import { DESIGN_ATTACH_KINDS } from './store';
import type { AttachInput } from './service';

/** Parse `kind` + `id` (+ `revision`) into an attachment target; undefined when none is named. */
export function attachFrom(kind: unknown, id: unknown, revision: unknown): AttachInput | undefined | { error: string } {
  if (kind == null && id == null) return undefined;
  if (typeof kind !== 'string' || !(DESIGN_ATTACH_KINDS as readonly string[]).includes(kind) || typeof id !== 'string') {
    return { error: `attachTo needs kind (${DESIGN_ATTACH_KINDS.join('|')}) and id` };
  }
  const rev = revision == null || revision === '' ? undefined : Number(revision);
  return { kind: kind as AttachInput['kind'], id, ...(rev !== undefined ? { revision: rev } : {}) };
}
