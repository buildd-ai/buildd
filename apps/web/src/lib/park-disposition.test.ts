import { describe, expect, it } from 'bun:test';
import { disposeParkedWaitingFor } from './park-disposition';

const base = {
  scope: null,
  gitConfig: null,
  sensitive: false,
  pathManifest: null,
  nowMs: Date.now(),
  repairTaskExists: async () => false,
};
const ask = { type: 'question', prompt: 'Which database should I use?', disposition: 'ask' };

describe('disposeParkedWaitingFor: repeated question', () => {
  it('admits a first question', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: ask, stored: null });
    expect(r.admitted).toBe(true);
  });
  it('does not re-admit an identical question already stored', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: ask, stored: { ...ask, dispositionBy: 'gate' } });
    expect(r.admitted).toBe(false);
  });
  it('admits a same-prompt held question when it becomes an ask', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: ask, stored: { ...ask, disposition: 'hold', dispositionBy: 'gate', resurfaceAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(r.admitted).toBe(true);
  });
  it('does not re-admit a same-prompt question that already resurfaced', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: ask, stored: { ...ask, disposition: 'hold', dispositionBy: 'gate', holdOutcome: 'resurfaced' } });
    expect(r.admitted).toBe(false);
  });
  it('admits a different question', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: { ...ask, prompt: 'Another?' }, stored: ask });
    expect(r.admitted).toBe(true);
  });
  it('admits the question again after the worker resumed (nothing stored)', async () => {
    const r = await disposeParkedWaitingFor({ ...base, waitingFor: ask, stored: null });
    expect(r.admitted).toBe(true);
  });
});
