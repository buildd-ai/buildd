/**
 * What the runner tells the server about the model an attempt ran on
 * (spec "Model performance measurement"). A descriptor, never content: no
 * prompts, source or secrets, and never a URL. The server whitelists it again
 * (packages/core/model-observation.ts sanitizeDescriptor).
 *
 * Peak VRAM is sampled with nvidia-smi at a bounded interval and count. It is
 * a MACHINE-level reading summed over GPUs: other processes sharing the device
 * inflate it, so the server treats it as an upper bound for the attempt.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { PeakTracker, VRAM_SAMPLING, parseNvidiaSmiMemory, type EndpointKind } from '@buildd/core/model-observation';
import { PKG_VERSION } from './updater';
import type { LocalWorker } from './types';
import { buildToolEfficiencyAggregate } from './tool-trace-analysis';

/** Bounded structural aggregate of the local trace, or undefined. Never throws: telemetry must not fail a terminal report. */
function toolEfficiencyOf(worker: LocalWorker): Record<string, unknown> | undefined {
  try {
    const t = worker.toolTrace;
    if (!t || t.events.length === 0) return undefined;
    return buildToolEfficiencyAggregate({ header: t.header, events: t.events, counters: t.counters }) as unknown as Record<string, unknown>;
  } catch { return undefined; }
}

export interface WorkerObservationState {
  endpointKind?: EndpointKind;
  contextWindow?: number;
  startedAtMs: number;
  toolFailures: number;
  tracker: PeakTracker;
  stopSampler?: () => void;
}

export function newObservationState(init: { endpointKind?: EndpointKind; contextWindow?: number }): WorkerObservationState {
  return { ...init, startedAtMs: Date.now(), toolFailures: 0, tracker: new PeakTracker() };
}

function queryVramMb(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, stdout) => {
        resolve(err ? null : parseNvidiaSmiMemory(String(stdout)));
      });
    } catch { resolve(null); }
  });
}

/** Start bounded sampling; a machine with no nvidia-smi stops after its first miss. */
export function startVramSampler(state: WorkerObservationState, query: () => Promise<number | null> = queryVramMb): void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  state.stopSampler = () => { stopped = true; if (timer) clearTimeout(timer); };
  const tick = async () => {
    if (stopped) return;
    const mb = await query();
    if (mb === null && state.tracker.samples === 0) { stopped = true; return; }
    if (!state.tracker.record(mb) || stopped) return;
    timer = setTimeout(tick, VRAM_SAMPLING.intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };
  void tick();
}

/** The payload for the terminal PATCH. Absent fields stay absent so the server records why. */
export function buildModelObservationPayload(worker: LocalWorker): Record<string, unknown> | undefined {
  const st = worker.observation;
  if (!st) return undefined;
  st.stopSampler?.();
  const cpus = os.cpus();
  return {
    ...(st.endpointKind ? { endpointKind: st.endpointKind } : {}),
    ...(st.contextWindow ? { contextWindow: st.contextWindow } : {}),
    backend: worker.taskBackend ?? 'claude',
    harnessVersion: PKG_VERSION,
    toolFailures: st.toolFailures,
    ...(toolEfficiencyOf(worker) ? { toolEfficiency: toolEfficiencyOf(worker) } : {}),
    ...(st.tracker.peak !== null ? { peakVramMb: st.tracker.peak, vramSamples: st.tracker.samples } : {}),
    runtime: { os: os.platform(), arch: os.arch(), ...(cpus.length ? { cpuCount: cpus.length } : {}) },
  };
}
