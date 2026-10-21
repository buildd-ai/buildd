import type { SurfaceEvidence } from './ui-verification';

export function surface(): SurfaceEvidence {
  return {
    schemaVersion: 1,
    subject: { commitSha: 'a'.repeat(40), route: '/missions/example', scenarioId: 'closed-pr', viewport: 'mobile' },
    capture: { captureId: 'capture-test', capturedAt: '2026-10-21T12:00:00.000Z', snapshotRef: 'snapshot-test', screenshotRef: 'screenshot-test' },
    visible: {
      blocks: [{ id: 'status', role: 'status', text: 'Pull request closed', order: 0, disclosure: 'visible' }],
      actions: [{ id: 'confirm', label: 'Confirm replacement', operation: 'confirm_replacement', enabled: true, prominence: 'primary', disclosure: 'visible' }],
    },
    facts: { prState: 'closed', replacementState: 'candidate', verificationState: 'failed', shownVerificationState: 'failed' },
    provenance: { collector: 'visual_auditor', collectorVersion: '1', reportedVia: 'runner', factVersion: '1' },
    coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'complete' },
  };
}


