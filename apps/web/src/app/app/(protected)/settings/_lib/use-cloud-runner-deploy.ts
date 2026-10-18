'use client';

import { useCallback, useRef, useState } from 'react';

export const DEPLOY_STEPS = ['check', 'bucket', 'worker', 'containers', 'connect'] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

const LABELS: Record<DeployStep, string> = {
  check: 'Checking…',
  bucket: 'Creating snapshot bucket…',
  worker: 'Uploading Worker…',
  containers: 'Starting the runner…',
  connect: 'Connecting workspace…',
};

/**
 * The steps still to run after `check`, given the ones it reported already
 * current (`detail.current`). `check` itself is never skipped.
 */
export function stepsToRun(current: unknown): DeployStep[] {
  const skip = new Set(Array.isArray(current) ? current : []);
  return DEPLOY_STEPS.filter((s) => s === 'check' || !skip.has(s));
}

export interface DeployState {
  /** Idle until Deploy is pressed; running while steps are in flight; done/error at the end. */
  phase: 'idle' | 'running' | 'done' | 'error';
  /** The step currently in flight, or the last step that ran. */
  currentStep: DeployStep | null;
  /** Human-readable label for the current step. */
  label: string;
  /** Progress 0–1 (steps completed / total). */
  progress: number;
  /** The Worker URL on success. */
  workerUrl: string | null;
  /** Error message on failure. */
  error: string | null;
  /** Notes from the deploy (e.g. about the runner key). */
  notes: string[];
<<<<<<< HEAD
  /** Steps `check` found already current, so they were not run. */
  skipped: DeployStep[];
}

const INITIAL: DeployState = { phase: 'idle', currentStep: null, label: '', progress: 0, workerUrl: null, error: null, notes: [], skipped: [] };
=======
  /** The workspace the last deploy ran for. */
  workspaceId: string | null;
  /** The step that failed, so Retry resumes there instead of redoing finished steps. */
  failedStep: DeployStep | null;
}

const INITIAL: DeployState = {
  phase: 'idle', currentStep: null, label: '', progress: 0, workerUrl: null, error: null, notes: [],
  workspaceId: null, failedStep: null,
};
>>>>>>> origin/dev

export function useCloudRunnerDeploy() {
  const [state, setState] = useState<DeployState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  // Notes the finished steps returned, per workspace, so a resumed deploy keeps them.
  const notesRef = useRef<{ workspaceId: string | null; notes: string[] }>({ workspaceId: null, notes: [] });

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  /**
   * Run the deploy from `from` (default: the first step). Each step is its own
   * request and the route keeps what finished steps produced, so a retry passes
   * the failed step and the earlier ones are not requested again.
   */
  const deploy = useCallback(async (workspaceId: string, from: DeployStep = DEPLOY_STEPS[0]) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
<<<<<<< HEAD
    setState({ ...INITIAL, phase: 'running', currentStep: 'check', label: LABELS.check });
    const allNotes: string[] = [];
    let steps: DeployStep[] = [...DEPLOY_STEPS];
    let workerUrl: string | null = null;

    for (let i = 0; i < steps.length; i++) {
=======
    const start = Math.max(0, DEPLOY_STEPS.indexOf(from));
    const startStep = DEPLOY_STEPS[start];
    // Resuming the same workspace keeps the notes the finished steps returned.
    const allNotes = start > 0 && notesRef.current.workspaceId === workspaceId ? [...notesRef.current.notes] : [];
    notesRef.current = { workspaceId, notes: allNotes };
    setState({
      ...INITIAL,
      phase: 'running',
      currentStep: startStep,
      label: LABELS[startStep],
      progress: start / DEPLOY_STEPS.length,
      notes: allNotes,
      workspaceId,
    });

    for (let i = start; i < DEPLOY_STEPS.length; i++) {
>>>>>>> origin/dev
      if (ac.signal.aborted) return;
      const step = steps[i];
      setState((s) => ({
        ...s,
        currentStep: step,
        label: LABELS[step],
        progress: i / steps.length,
      }));
      try {
        const res = await fetch('/api/cloudflare/cloud-runner/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step, workspaceId }),
          signal: ac.signal,
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          setState((s) => ({
            ...s,
            phase: 'error',
            error: body.error ?? `Step "${step}" failed (HTTP ${res.status}).`,
<<<<<<< HEAD
            progress: i / steps.length,
=======
            failedStep: step,
            progress: i / DEPLOY_STEPS.length,
>>>>>>> origin/dev
          }));
          return;
        }
        // allNotes is notesRef's array, so a later resume sees these too.
        if (Array.isArray(body.detail?.notes)) allNotes.push(...body.detail.notes);
        workerUrl = body.detail?.dispatchUrl ?? body.detail?.workerUrl ?? workerUrl;
        if (step === 'check') {
          // Only what changed runs: check names the steps already current.
          steps = stepsToRun(body.detail?.current);
          const skipped = DEPLOY_STEPS.filter((s) => !steps.includes(s));
          setState((s) => ({ ...s, skipped }));
        }
        // Last step done: extract the Worker URL.
        if (!body.next || i === steps.length - 1) {
          setState({
            phase: 'done',
            currentStep: step,
            label: 'Done',
            progress: 1,
            workerUrl,
            error: null,
            notes: allNotes,
<<<<<<< HEAD
            skipped: DEPLOY_STEPS.filter((s) => !steps.includes(s)),
=======
            workspaceId,
            failedStep: null,
>>>>>>> origin/dev
          });
          return;
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        setState((s) => ({
          ...s,
          phase: 'error',
          error: err instanceof Error ? err.message : 'Deploy failed.',
<<<<<<< HEAD
          progress: i / steps.length,
=======
          failedStep: step,
          progress: i / DEPLOY_STEPS.length,
>>>>>>> origin/dev
        }));
        return;
      }
    }
  }, []);

  return { state, deploy, reset };
}
