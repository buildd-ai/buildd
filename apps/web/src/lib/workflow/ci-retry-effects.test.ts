/**
 * The CI family's `Evidence` half (ci-retry-effects.ts `ciEvidenceOf`): what it
 * hands `captureCiJobLogEvidence` for the job log a CI fix was owed. The
 * handler that runs it is the package's (conformance: handlers/ci).
 */
import { describe, expect, test } from 'bun:test';
import type { captureCiJobLogEvidence } from '@/lib/ci-job-log-evidence';
import { ciEvidenceOf } from './ci-retry-effects';

type CaptureInput = Parameters<typeof captureCiJobLogEvidence>[0];

function recordingCapture(answer: Awaited<ReturnType<typeof captureCiJobLogEvidence>> = { status: 'stored', objectKey: 'k', bytes: 3 } as never) {
  const inputs: CaptureInput[] = [];
  const capture = (async (input: CaptureInput) => { inputs.push(input); return answer; }) as typeof captureCiJobLogEvidence;
  return { inputs, capture };
}

const repoFor = async () => ({ installationId: 4, repoFullName: 'acme/widgets', gitConfig: null }) as never;
const payload = { failedJobId: 42, taskId: 'fix-1', parentTaskId: 'owner-1', workerId: 'wk-1', prNumber: 7, repoFullName: 'acme/widgets' };

describe('ciEvidenceOf', () => {
  test('one object per fix task and failed job, so a retried capture overwrites it instead of writing another', async () => {
    const c = recordingCapture();
    const ev = ciEvidenceOf({ repoFor, capture: c.capture });
    expect(await ev.capture({ kind: 'ci_job_log', workspaceId: 'w1', deliveryId: 'd1', payload })).toEqual({ status: 'stored', record: { objectKey: 'k', bytes: 3 } });
    await ev.capture({ kind: 'ci_job_log', workspaceId: 'w1', deliveryId: 'd1', payload });
    expect(c.inputs.map((i) => i.objectName)).toEqual(['fix-1-42', 'fix-1-42']);
    expect(c.inputs[0]).toMatchObject({
      installationId: 4, repoFullName: 'acme/widgets', failedJobId: 42, workspaceId: 'w1', retryTaskId: 'fix-1', parentTaskId: 'owner-1', workerId: 'wk-1', prNumber: 7,
    });
  });

  test('no failed job names no object; another kind, or no installation, captures nothing', async () => {
    const c = recordingCapture({ status: 'skipped', reason: 'no failed job id' } as never);
    const ev = ciEvidenceOf({ repoFor, capture: c.capture });
    expect(await ev.capture({ kind: 'ci_job_log', workspaceId: 'w1', deliveryId: 'd1', payload: { ...payload, failedJobId: null } })).toEqual({ status: 'skipped', record: { reason: 'no failed job id' } });
    expect(c.inputs.map((i) => ('objectName' in i ? i.objectName : 'absent'))).toEqual(['absent']);
    expect((await ev.capture({ kind: 'transcript', workspaceId: 'w1', deliveryId: 'd1', payload })).status).toBe('skipped');
    const none = ciEvidenceOf({ repoFor: async () => null, capture: c.capture });
    expect(await none.capture({ kind: 'ci_job_log', workspaceId: 'w1', deliveryId: 'd1', payload })).toEqual({ status: 'skipped', record: { reason: 'no GitHub installation for the workspace' } });
    expect(c.inputs.length).toBe(1);
  });
});
