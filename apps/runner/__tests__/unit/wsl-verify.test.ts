import { expect, test } from 'bun:test';
import { verifyWslClaude } from '../../src/isolation-check';
import { buildIsolationRecord } from '../../src/isolation-probe';
const record = () => buildIsolationRecord({ host: { platform: 'linux-wsl', evidence: [] }, optOut: false, bwrap: { ok: true }, seatbelt: null, probeAt: '2026-10-22T00:00:01Z', processStartedAt: '2026-10-22T00:00:00Z', runnerVersion: '1.0.0' });
test('WSL verification requires current Claude bwrap confinement, not merely WSL detection', () => {
  expect(verifyWslClaude(record())).toBe(true);
  expect(verifyWslClaude({ ...record(), platform: 'windows' })).toBe(false);
  expect(verifyWslClaude({ ...record(), claude: { mechanism: 'none', scope: [], reason: 'probe_exec_failed' } })).toBe(false);
  expect(verifyWslClaude({ ...record(), claude: { mechanism: 'bwrap', scope: ['write'] } })).toBe(false);
  expect(verifyWslClaude({ ...record(), probeAt: '2026-10-21T00:00:00Z' })).toBe(false);
});
