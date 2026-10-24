import { describe, it, expect } from 'bun:test';
import {
  WAITING_KIND_SPEC,
  canForceStart,
  isStartForceable,
  forceDialog,
  makeWaitingReason,
  waitingChip,
} from '../waiting-reason';

// Start anyway (spec 36df686b r1): the waiting-reason model half of the contract.
const declared = (id: string) => makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id, label: `task ${id}`, live: true },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const lease = makeWaitingReason('lease_overlap', {
  because: 'a running task claimed the same files',
  blocker: { type: 'lease', id: 'holder', label: 'a running task', live: true },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'lease', overlapKind: 'migration' },
  provenance: { source: 'probe', derivedFrom: 'path_claims' },
});

describe('Start anyway: waiting reasons', () => {
  it('R-1: a declared dependency is startable anyway and Start anyway names the prerequisite', () => {
    expect(isStartForceable('dep_declared')).toBe(true);
    expect(canForceStart([declared('up-1')])).toBe(true);
    const dialog = forceDialog([declared('up-1')]);
    expect(dialog.checklist.map(c => c.kind)).toEqual(['dep_declared']);
    expect(JSON.stringify(dialog)).toContain('task up-1');
    expect(JSON.stringify(dialog).toLowerCase()).toContain('assess');
  });

  it('R-3: the declared dependency stays a hard intentional wait for automatic scheduling', () => {
    const spec = WAITING_KIND_SPEC.dep_declared;
    expect(spec.strength).toBe('hard');
    expect(spec.releasesWhen.event).toBe('task.completed+merged');
    // The only start path past it is the person's bounded start_context intent.
    expect(spec.force?.mechanism).toBe('start_context');
    expect(waitingChip([declared('up-1')])).toBe('blocked');
  });

  it('R-14: a lane wait admits assessment but the file-lock rails stay enforced', () => {
    const dialog = forceDialog([declared('up-1'), lease]);
    expect(dialog.checklist.map(c => c.kind)).toEqual(expect.arrayContaining(['dep_declared', 'lease_overlap']));
    expect(dialog.stillEnforced.join(' ')).toContain('Files another agent is editing stay locked');
  });

  it('R-14: a non-overridable condition beside a declared dependency still blocks Start anyway', () => {
    const noProvider = makeWaitingReason('provider_unavailable', {
      because: 'the provider is disabled',
      provenance: { source: 'probe', derivedFrom: 'providers' },
    });
    expect(canForceStart([declared('up-1')])).toBe(true);
    expect(canForceStart([declared('up-1'), noProvider])).toBe(false);
  });
});
