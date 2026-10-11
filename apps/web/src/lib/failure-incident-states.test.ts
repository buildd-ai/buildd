import { describe, it, expect } from 'bun:test';
import { incidentRowLine } from './failure-incident-states';

describe('incidentRowLine', () => {
  it('says buildd is fixing it while a fix task is open', () => {
    expect(incidentRowLine({ status: 'open', fixTaskStatus: 'in_progress', fixedInVersion: null })).toBe('buildd is fixing this');
    expect(incidentRowLine({ status: 'acknowledged', fixTaskStatus: 'pending', fixedInVersion: null })).toBe('buildd is fixing this');
  });

  it('says buildd is looking into it when nothing is fixing it yet', () => {
    expect(incidentRowLine({ status: 'open', fixTaskStatus: null, fixedInVersion: null })).toBe('buildd is looking into this');
    expect(incidentRowLine({ status: 'open', fixTaskStatus: 'failed', fixedInVersion: null })).toBe('buildd is looking into this');
  });

  it('names the release a fix shipped in, and tells the reader to retry', () => {
    expect(incidentRowLine({ status: 'resolved', fixTaskStatus: 'completed', fixedInVersion: '0.319.0' })).toBe('Fixed in v0.319.0 · retry');
    expect(incidentRowLine({ status: 'open', fixTaskStatus: 'completed', fixedInVersion: 'v0.320.1' })).toBe('Fixed in v0.320.1 · retry');
    expect(incidentRowLine({ status: 'resolved', fixTaskStatus: null, fixedInVersion: null })).toBe('Fixed · retry');
  });
});
