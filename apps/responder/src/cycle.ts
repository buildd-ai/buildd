/**
 * One observation cycle: evaluate → decide → page or suppress → record.
 *
 * ── Notification discipline ─────────────────────────────────────────────────
 * Page on **onset**, stay quiet while the condition persists, re-page only
 * after a renotify window. This is not a new convention:
 * `apps/web/src/app/api/cron/queue-stall/route.ts` already implements it with
 * `RENOTIFY_HOURS = 24`, and this app uses the same default and the same
 * reasoning — long enough that a permanently-broken condition cannot page
 * anyone daily into banner blindness, short enough that a problem nobody acted
 * on comes back.
 *
 * The incident ran fourteen hourly ticks. Paging on each would have been
 * worse than paging once, because a channel that pages fourteen times for one
 * outage is a channel that gets muted before the next one.
 *
 * ── Every decision is recorded, including the decision not to page ──────────
 * "We chose not to tell you, and here is until when" is the harder half of the
 * contract, because suppression is invisible by nature. An operator asking
 * "why did nobody tell me" has to be able to find the line.
 *
 * ── Observe-only ────────────────────────────────────────────────────────────
 * There is no action surface in this file and no flag that would enable one.
 * Actions are a later phase, each behind its own flag and its own bound; this
 * cycle returns state and verdicts and does nothing else. `cycle.test.ts`
 * asserts that.
 */

import {
  appendEvidence,
  saveState,
  type EvidenceRecord,
  type ResponderState,
} from './evidence';
import { narrateWithinBudget, type NarrateFn } from './narrative';
import type { NotifyFn, Page } from './notify';
import type { Detector, Snapshot, Verdict } from './types';

export interface NotifyDecision {
  verdict: Verdict;
  action: 'notify' | 'suppress' | 'clear' | 'record';
  trigger?: 'onset' | 'renotify';
  reason?: 'within_renotify_window';
  lastNotifiedAt?: string;
  nextEligibleAt?: string;
  /** State as it would be if this decision is carried out. */
  nextState: ResponderState;
}

const PAGING_STATES = new Set<Verdict['state']>(['firing', 'blind']);

/**
 * Pure. Given verdicts and the current windows, say what should happen.
 *
 * Kept separate from the I/O in `runCycle` for one reason: the paging
 * discipline is the part most likely to be got wrong and the part hardest to
 * observe in production, so it has to be exhaustively testable without a
 * filesystem, a clock or a network.
 */
export function decideNotifications(
  verdicts: readonly Verdict[],
  state: ResponderState,
  now: number,
  renotifyHours: number,
): NotifyDecision[] {
  const renotifyMs = renotifyHours * 3_600_000;
  const decisions: NotifyDecision[] = [];
  let working = state;

  for (const verdict of verdicts) {
    const key = verdict.conditionKey;

    if (verdict.state === 'warming') {
      decisions.push({ verdict, action: 'record', nextState: working });
      continue;
    }

    if (!PAGING_STATES.has(verdict.state)) {
      // `clear`. Only interesting if this condition is currently paged: then
      // the window is dropped so a recurrence pages at once instead of waiting
      // out a window for an outage that already ended.
      const open = working.notified[key];
      if (!open) continue;
      const { [key]: _dropped, ...rest } = working.notified;
      working = { ...working, notified: rest };
      decisions.push({ verdict, action: 'clear', nextState: working });
      continue;
    }

    const open = working.notified[key];
    if (!open) {
      working = {
        ...working,
        notified: {
          ...working.notified,
          [key]: {
            firstNotifiedAt: new Date(now).toISOString(),
            lastNotifiedAt: new Date(now).toISOString(),
            onsetAt: verdict.onsetAt,
            pageCount: 1,
          },
        },
      };
      decisions.push({ verdict, action: 'notify', trigger: 'onset', nextState: working });
      continue;
    }

    const last = Date.parse(open.lastNotifiedAt);
    const nextEligibleAt = new Date(last + renotifyMs).toISOString();
    if (now - last < renotifyMs) {
      decisions.push({
        verdict,
        action: 'suppress',
        reason: 'within_renotify_window',
        lastNotifiedAt: open.lastNotifiedAt,
        nextEligibleAt,
        nextState: working,
      });
      continue;
    }

    working = {
      ...working,
      notified: {
        ...working.notified,
        [key]: {
          ...open,
          lastNotifiedAt: new Date(now).toISOString(),
          onsetAt: verdict.onsetAt ?? open.onsetAt,
          pageCount: open.pageCount + 1,
        },
      },
    };
    decisions.push({ verdict, action: 'notify', trigger: 'renotify', nextState: working });
  }

  return decisions;
}

export interface PageContext {
  appVersion: Record<string, unknown> | null;
  runnerVersion: Record<string, unknown> | null;
}

function versionLine(label: string, body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const parts = Object.entries(body)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${label}: ${parts.join(' ')}` : null;
}

/**
 * Build the page.
 *
 * The detector's own `summary` comes first and always. The narrative, when
 * there is one, is appended below it — never substituted for it. That ordering
 * is the whole degradation story: a reader who gets only the first paragraph
 * still knows which condition tripped and when.
 */
export function renderPage(
  verdict: Verdict,
  narrative: string | null,
  ctx: PageContext,
): Page {
  const lines = [verdict.summary];

  const versions = [
    versionLine('app', ctx.appVersion),
    versionLine('runner', ctx.runnerVersion),
  ].filter((l): l is string => l !== null);
  if (versions.length) lines.push('', ...versions);

  if (narrative) lines.push('', narrative);

  return {
    title: `buildd responder: ${verdict.detector}${verdict.state === 'blind' ? ' (blind)' : ''}`,
    // High priority. Both conditions mean work is not being done, and the
    // renotify window is what keeps that from being noisy.
    priority: 1,
    message: lines.join('\n'),
  };
}

/** A detector that threw. Reported as blindness, never swallowed. */
function detectorFailureVerdict(detector: Detector, err: unknown): Verdict {
  const message = err instanceof Error ? err.message : String(err);
  return {
    detector: detector.id,
    state: 'blind',
    conditionKey: `${detector.id}:blind`,
    summary:
      `Detector ${detector.id} cannot see: it threw while evaluating (${message}). ` +
      'Its condition is unmonitored until this is fixed.',
    onsetAt: null,
    facts: { reason: 'detector_threw', error: message },
  };
}

export interface CycleInput {
  stateDir: string;
  detectors: readonly Detector[];
  snapshot: Snapshot;
  state: ResponderState;
  now: number;
  renotifyHours: number;
  notify: NotifyFn;
  narrate: NarrateFn;
  narrativeTimeoutMs: number;
  /** Distinguishes "no credential configured" from "the call failed". */
  hasNarrativeCredential: boolean;
}

export interface CycleResult {
  state: ResponderState;
  verdicts: Verdict[];
  pagesSent: number;
}

export async function runCycle(input: CycleInput): Promise<CycleResult> {
  const at = new Date(input.now).toISOString();

  const verdicts: Verdict[] = input.detectors.map(detector => {
    try {
      return detector.evaluate(input.snapshot, input.now);
    } catch (err) {
      // One malformed snapshot field must not silence every other detector.
      return detectorFailureVerdict(detector, err);
    }
  });

  appendEvidence(input.stateDir, {
    kind: 'cycle',
    at,
    verdicts,
    inputs: {
      claimSamples: input.snapshot.claimSamples.length,
      cronRuns: input.snapshot.cronRuns?.length ?? null,
      cronRunsError: input.snapshot.cronRunsError ?? null,
      appVersionStatus: input.snapshot.appVersion?.status ?? null,
      runnerVersionStatus: input.snapshot.runnerVersion?.status ?? null,
    },
  });

  const decisions = decideNotifications(
    verdicts,
    input.state,
    input.now,
    input.renotifyHours,
  );

  const pageCtx: PageContext = {
    appVersion: input.snapshot.appVersion?.body ?? null,
    runnerVersion: input.snapshot.runnerVersion?.body ?? null,
  };

  // One narrative per cycle, shared by every page in it: the conditions in a
  // single cycle are usually one incident seen twice, and two model calls
  // would double the cost and the latency to say the same thing.
  const toPage = decisions.filter(d => d.action === 'notify');
  let narrative: string | null = null;
  let narrativeStatus: 'included' | 'unavailable' | 'no-credential' = 'no-credential';
  if (toPage.length > 0 && input.hasNarrativeCredential) {
    narrative = await narrateWithinBudget(
      input.narrate,
      {
        verdicts: toPage.map(d => d.verdict),
        appVersion: pageCtx.appVersion,
        runnerVersion: pageCtx.runnerVersion,
      },
      input.narrativeTimeoutMs,
    );
    narrativeStatus = narrative ? 'included' : 'unavailable';
  }

  let state = input.state;
  let pagesSent = 0;

  for (const decision of decisions) {
    const { verdict } = decision;

    if (decision.action === 'record') {
      appendEvidence(input.stateDir, {
        kind: 'warming',
        at,
        conditionKey: verdict.conditionKey,
        summary: verdict.summary,
      });
      continue;
    }

    if (decision.action === 'clear') {
      const pagedSince = state.notified[verdict.conditionKey]?.firstNotifiedAt ?? null;
      state = decision.nextState;
      appendEvidence(input.stateDir, {
        kind: 'cleared',
        at,
        conditionKey: verdict.conditionKey,
        pagedSince,
      });
      continue;
    }

    if (decision.action === 'suppress') {
      appendEvidence(input.stateDir, {
        kind: 'suppressed',
        at,
        conditionKey: verdict.conditionKey,
        reason: 'within_renotify_window',
        lastNotifiedAt: decision.lastNotifiedAt!,
        nextEligibleAt: decision.nextEligibleAt!,
        onsetAt: verdict.onsetAt,
        summary: verdict.summary,
      });
      continue;
    }

    const result = await input.notify(renderPage(verdict, narrative, pageCtx));
    if (!result.ok) {
      // The window is NOT opened. A transport failure must not be
      // indistinguishable from a delivered page, or one dropped request
      // silences the condition for a whole renotify window.
      appendEvidence(input.stateDir, {
        kind: 'notify_failed',
        at,
        conditionKey: verdict.conditionKey,
        error: result.error ?? `status ${result.status}`,
      });
      continue;
    }

    state = decision.nextState;
    pagesSent++;
    const record: EvidenceRecord = {
      kind: 'notified',
      at,
      conditionKey: verdict.conditionKey,
      detector: verdict.detector,
      trigger: decision.trigger!,
      onsetAt: verdict.onsetAt,
      summary: verdict.summary,
      narrative: narrativeStatus,
      facts: verdict.facts,
    };
    appendEvidence(input.stateDir, record);
  }

  saveState(input.stateDir, state);
  return { state, verdicts, pagesSent };
}
