import { describe, it, expect } from 'bun:test';
import { recordActualsFor } from './task-estimate-experiment-subscribers';

describe('recordActualsFor', () => {
  it('records a work task', async () => {
    const seen: string[] = [];
    await recordActualsFor('t1', 'work', { record: async id => { seen.push(id); } });
    await recordActualsFor('t2', null, { record: async id => { seen.push(id); } });
    expect(seen).toEqual(['t1', 't2']);
  });

  it('skips attempt and bookkeeping tasks', async () => {
    const seen: string[] = [];
    for (const c of ['attempt', 'bookkeeping']) await recordActualsFor('t', c, { record: async id => { seen.push(id); } });
    expect(seen).toEqual([]);
  });
});
