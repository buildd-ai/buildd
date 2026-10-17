/**
 * The isolation check `buildd doctor` and install.sh print (Living Spec
 * "Runner isolation", R-8, AC-8).
 *
 * Both read the record the runtime builds (isolation-probe.ts
 * probeIsolationRecord) and the shared verdict text, so they cannot disagree
 * with the heartbeat or Health. Doctor used to call a missing bubblewrap "ok
 * (expected)" while Health warned about the same host, and install.sh never
 * asked. The steps are printed for the runner operator: nothing here changes
 * a host security setting.
 *
 * Run directly (install.sh does, after `bun install`), it prints the verdict
 * and exits 0 either way: reduced isolation is not an install failure.
 */
import { isolationVerdict, type RunnerIsolationRecord } from '@buildd/shared';
import { probeIsolationRecord, processStartedAt, realIsolationProbes } from './isolation-probe';
import { PKG_VERSION } from './updater';

export interface IsolationCheck {
  name: 'sandbox';
  status: 'ok' | 'warn';
  message: string;
  /** The operator's steps, one per line; absent when confined or nothing on the host would help. */
  detail?: string;
}

/** This host's record, probed now, uncached. */
export function probeThisHost(): RunnerIsolationRecord {
  return probeIsolationRecord(realIsolationProbes, {
    processStartedAt: processStartedAt(),
    runnerVersion: PKG_VERSION,
  });
}

/** Doctor's check for a record: warn whenever Health would (deriveSandboxPosture). */
export function isolationCheck(record: RunnerIsolationRecord): IsolationCheck {
  const v = isolationVerdict(record);
  if (v.confined) return { name: 'sandbox', status: 'ok', message: v.summary };
  return {
    name: 'sandbox',
    status: 'warn',
    message: `${v.summary} — tasks run without isolation`,
    ...(v.remediation.length > 0 ? { detail: v.remediation.join('\n') } : {}),
  };
}

/** The installer's lines for a record. */
export function formatIsolationCheck(record: RunnerIsolationRecord): string[] {
  const check = isolationCheck(record);
  const lines = [`Sandbox (${record.platform}): ${check.message}`];
  if (check.detail) {
    lines.push('  To fix (runner operator; buildd does not change host security settings):');
    for (const step of check.detail.split('\n')) lines.push(`    ${step}`);
  }
  return lines;
}

if (import.meta.main) {
  for (const line of formatIsolationCheck(probeThisHost())) console.log(line);
}
