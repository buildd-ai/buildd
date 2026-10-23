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
import { confinementLevel, isIsolationRecordCurrent, isolationRemediation, isolationVerdict, partialConfinementRemediation, type RunnerIsolationRecord } from '@buildd/shared';
import { probeIsolationRecord, processStartedAt, realIsolationProbes } from './isolation-probe';
import { PKG_VERSION } from './updater';

export interface IsolationCheck {
  name: 'sandbox';
  status: 'ok' | 'warn';
  message: string;
  /** One line per backend: what confines it here and where its tasks go (isolationVerdict). */
  backends: string[];
  /** The backend lines, then the steps, one per line; absent when every backend is fully confined. */
  detail?: string;
  /** The runner operator's steps alone. */
  steps: string[];
}

/** This host's record, probed now, uncached. */
export function probeThisHost(): RunnerIsolationRecord {
  return probeIsolationRecord(realIsolationProbes, {
    processStartedAt: processStartedAt(),
    runnerVersion: PKG_VERSION,
  });
}

/**
 * Doctor's check for a record: warn whenever a backend lacks full confinement
 * (Health warns on the same records, deriveSandboxPosture).
 */
export function isolationCheck(record: RunnerIsolationRecord): IsolationCheck {
  const v = isolationVerdict(record);
  const backends = v.backends.map((b) => b.line);
  if (v.backends.every((b) => b.level === 'full')) return { name: 'sandbox', status: 'ok', message: v.summary, backends, steps: [] };
  // Claude's cause when it has none; otherwise what a less-confined Codex mode needs.
  const codex = [record.codex['workspace-write'], record.codex['read-only']].find((c) => confinementLevel(c) !== 'full');
  const steps = !v.confined
    ? v.remediation
    : codex && codex.mechanism === 'none'
      ? isolationRemediation(codex.reason ?? 'backend_probe_failed', record.platform)
      : partialConfinementRemediation(record.platform);
  return {
    name: 'sandbox',
    status: 'warn',
    message: v.summary,
    backends,
    detail: [...backends, ...steps].join('\n'),
    steps,
  };
}

/**
 * The posture the banner, `buildd top` (through /api/config) and
 * `buildd service install` show: the verdict's summary and one line per
 * backend, so no surface words it differently.
 */
export function sandboxPosture(record: RunnerIsolationRecord): { summary: string; backends: { line: string; level: 'full' | 'partial' | 'none' }[] } {
  const v = isolationVerdict(record);
  return { summary: v.summary, backends: v.backends.map((b) => ({ line: b.line, level: b.level })) };
}

/** The installer's lines for a record. */
export function formatIsolationCheck(record: RunnerIsolationRecord): string[] {
  const check = isolationCheck(record);
  const lines = [`Sandbox (${record.platform}): ${check.message}`];
  for (const b of check.backends) lines.push(`  ${b}`);
  if (check.steps.length > 0) {
    lines.push('  To fix (runner operator; buildd does not change host security settings):');
    for (const step of check.steps) lines.push(`    ${step}`);
  }
  return lines;
}

/** Setup gate for this Linux process, never a Windows host's WSL inventory. */
export function verifyWslClaude(record: RunnerIsolationRecord): boolean {
  return record.platform === 'linux-wsl' && isIsolationRecordCurrent(record)
    && record.claude.mechanism === 'bwrap' && confinementLevel(record.claude) === 'full';
}

if (import.meta.main) {
  if (process.argv.includes('--verify-wsl') && process.platform !== 'linux') {
    console.error('WSL verification must run inside the Linux distribution, not on the Windows host.');
    process.exit(1);
  }
  const record = probeThisHost();
  if (process.argv.includes('--verify-wsl')) {
    const verified = verifyWslClaude(record);
    console.log(JSON.stringify({ backend: 'claude', verified, isolation: record }, null, 2));
    process.exit(verified ? 0 : 1);
  }
  // install.sh asks for Claude's cause alone, to decide whether to offer bubblewrap.
  if (process.argv.includes('--claude-reason')) console.log(record.claude.reason ?? 'confined');
  else for (const line of formatIsolationCheck(record)) console.log(line);
}
