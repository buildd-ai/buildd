import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordGateEventInput } from '@buildd/core/gate-events';

const events: RecordGateEventInput[] = [];
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { PATH_DECLARATION: 'path_declaration' },
  fireGateEvent: (e: RecordGateEventInput) => { events.push(e); return 'sig'; },
}));

const { recordPathDeclaration, manifestShape } = await import('./path-declaration-ledger');

beforeEach(() => { events.length = 0; });

describe('recordPathDeclaration', () => {
  it('maps succeeded/denied/degraded to accepted/deferred/warned with provenance', () => {
    for (const [result, outcome] of [['succeeded', 'accepted'], ['denied', 'deferred'], ['degraded', 'warned']] as const) {
      recordPathDeclaration({ result, provenance: 'observed', surface: 's', workspaceId: 'ws', taskId: 't', callerOrigin: 'worker', pathCount: 2 });
      expect(events.at(-1)).toMatchObject({ gate: 'path_declaration', outcome, detail: { provenance: 'observed', result, pathCount: 2 } });
    }
  });

  it('a creation with no manifest is still counted (the none-provenance denominator)', () => {
    recordPathDeclaration({ result: 'succeeded', provenance: 'creation', surface: 's', workspaceId: 'ws', taskId: 't', callerOrigin: 'api', pathCount: 0, detail: { shape: 'none' } });
    expect(events.at(-1)?.detail).toMatchObject({ provenance: 'creation', shape: 'none' });
  });

  it('records nothing for an empty runtime declaration', () => {
    recordPathDeclaration({ result: 'succeeded', provenance: 'observed', surface: 's', workspaceId: 'ws', taskId: 't', callerOrigin: 'worker', pathCount: 0 });
    expect(events).toHaveLength(0);
  });

});

describe('manifestShape', () => {
  it('classifies none / sentinel / concrete', () => {
    expect(manifestShape(null)).toBe('none');
    expect(manifestShape([])).toBe('none');
    expect(manifestShape(['**'])).toBe('sentinel');
    expect(manifestShape(['a.ts'])).toBe('concrete');
    expect(manifestShape(['**', 'a.ts'])).toBe('mixed');
  });
});
