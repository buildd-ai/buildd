import { NextRequest, NextResponse } from 'next/server';
import {
  READOUT_POLICY_VERSION,
  formatReadoutSummary,
  formatReadoutText,
} from '@buildd/core/memory-digest-readout';
import {
  claimVerdictNotification,
  findDeliveredVerdict,
  persistReadout,
  runMemoryDigestReadout,
  upsertReadoutArtifact,
} from '@buildd/core/memory-digest-readout-source';
import {
  cleanupNoticeLine,
  memoryDigestCleanupSpec,
} from '@buildd/core/experiment-cleanup';
import { notify } from '@/lib/pushover';
import { appBaseUrl } from '@/lib/app-url';
import { fileExperimentCleanupTask } from '@/lib/experiment-cleanup-task';
import { withCronRun, type CronReport } from '@/lib/cron-run';

/**
 * Daily readout of the workspace-memory-digest experiment.
 *
 * ── Why a cron route and not a scheduled agent task ─────────────────────────
 *
 * Every number in this readout is arithmetic over rows
 * (`packages/core/memory-digest-readout.ts`), so an agent would add tokens,
 * latency and non-determinism to a computation that has exactly one right
 * answer. A cron route also gets auth, run history and a health verdict for
 * free from `withCronRun`, and — the part that matters for an experiment being
 * read by a human on a phone — the same function that answers this endpoint is
 * importable, so a page or an MCP action shows the identical figures rather
 * than a second implementation that drifts.
 *
 * ── Why this is quiet almost every day ─────────────────────────────────────
 *
 * The experiment has no end date, so there is nothing to schedule a single
 * report for. Instead the verdict is recomputed daily and notifies only when it
 * is TERMINAL: the post-boundary cohort has crossed the exposure the design
 * requires, or accrual has clearly stopped. Everything else is `accruing`,
 * which is the expected answer and gets no push at all.
 *
 * `claimVerdictNotification` makes that "once, ever" rather than "once a day":
 * it is an atomic insert that returns a row only to the first caller. Without
 * it a terminal verdict would push every morning until someone muted the
 * channel, and a muted channel is worse than no channel because it looks like
 * one.
 *
 * ── Why it retires itself, and what "retired" honestly means ────────────────
 *
 * Deduping the notification still left the expensive half running for ever: a
 * concluded experiment was recomputed every morning, including the full cohort
 * scan, to discover again that it had nothing to say. So the FIRST thing this
 * route does is ask whether a terminal verdict has already been delivered for
 * this policy version — one primary-key lookup over the two enumerable claim
 * keys — and if so it returns without computing the readout at all.
 *
 * That is a route that no-ops, not a schedule that was switched off, and it is
 * described that way deliberately. The scheduler still ticks once a day and
 * still gets a 200. What stops is the work: no cohort scan, no persistence, no
 * artifact write, no notification.
 *
 * The two alternatives are both worse:
 *
 *  - **Flip `enabled: false` in `cron-manifest.json`.** The manifest is a
 *    build-time declaration synced to the external scheduler by `cron-sync.yml`
 *    (crons here are not platform-native). A runtime event cannot edit it —
 *    it would need a commit, a review and a deploy — so "self-disable" would
 *    mean "a human disables it after reading the push", which is exactly the
 *    manual step worth removing.
 *  - **Delete or disable the job at the external scheduler over its API.** That
 *    puts live scheduler state out of sync with the manifest that is supposed
 *    to be its source of truth, so the next `cron:sync` recreates the job and
 *    the disable silently un-happens. It would also hand a public-facing route
 *    scheduler-admin credentials to use on itself.
 *
 * ── Why the retired path still reports a verdict ────────────────────────────
 *
 * `evaluateCronHealth` discards any run that reports neither `changed` nor
 * `errors`: a route that reports nothing buys a heartbeat row and no health
 * signal, and is unalarmable by construction. So the retired path reports
 * `changed: 0, errors: 0` — a judged run that did not fail. That reads as
 * healthy-and-idle for ever (the alarm needs every judged run to have FAILED),
 * while still alarming if the retired path itself starts throwing, which is the
 * one thing that can still go wrong here.
 *
 * An `indeterminate` verdict — no rows for the policy version, or a boundary
 * that cannot be derived — reports `errors: 1` instead, so three consecutive
 * runs over a broken collection path alarm through cron health rather than
 * reading as a clean bill of health over an empty set.
 *
 * `changed` stays "did this run deliver the verdict", and is NOT incremented by
 * the artifact write. An artifact upsert happens on nearly every run, so
 * counting it as work would make `totalChanged > 0` permanently true and
 * suppress the alarm above for ever.
 *
 * ── Why the verdict files WORK and not a reminder ───────────────────────────
 *
 * A concluded experiment leaves scaffolding behind, and the previous plan for
 * it was a line in this notification saying "remember to clean this up". A
 * reminder is a task nobody owns: it is read once on a phone, and the schedule
 * it asks about keeps ticking until somebody happens to act. So the terminal
 * verdict files a real buildd task instead —
 * `lib/experiment-cleanup-task.ts`, described by
 * `@buildd/core/experiment-cleanup`, narrowly scoped and with its
 * prohibitions spelled out rather than left to the claiming agent's judgement.
 *
 * ── The ordering, which is the whole dedupe ─────────────────────────────────
 *
 * claim → file → push, deliberately, in that order:
 *
 *  - **After the claim**, because the claim IS the dedupe. Filing first would
 *    let two concurrent runs both pass the "no claim yet" test and file two
 *    tasks; the claim is the only thing that makes this once-ever, and adding a
 *    second check-then-act here would be a parallel mechanism that can disagree
 *    with the first.
 *  - **Before the push**, because the notification has to be able to name the
 *    task. The push is read once; a task id that arrives after it does not.
 *  - **Never load-bearing.** A filing that throws is caught: the readout is
 *    already persisted, the artifact is already published, and the push still
 *    goes out — carrying "no cleanup task could be filed … by hand" instead of
 *    an id, because silence there is indistinguishable from success. The claim
 *    is therefore never spent on a run that failed to deliver the verdict; it
 *    is spent on a run that delivered the verdict and failed to file follow-up
 *    work, which is recoverable by the one human reading the push.
 */

export const dynamic = 'force-dynamic';

/** Where a human reads the verdict. Auth-gated (`(protected)`), which is fine
 *  for the one recipient of the push; no share token is minted just to make a
 *  link followable — that would be a bearer credential in a notification. */
function artifactUrlFor(artifactId: string): string {
  return `${appBaseUrl()}/app/artifacts/${artifactId}`;
}

export async function GET(req: NextRequest) {
  return withCronRun('memory-digest-readout', req, report => runJob(report));
}

async function runJob(report: CronReport): Promise<NextResponse> {
  // Cheap first: if the verdict is already out, this job has nothing left to do
  // and must not pay for the cohort scan to find that out.
  const delivered = await findDeliveredVerdict(READOUT_POLICY_VERSION);
  if (delivered) {
    report({
      processed: 0,
      changed: 0,
      errors: 0,
      result: {
        retired: true,
        policyVersion: READOUT_POLICY_VERSION,
        deliveredVerdict: delivered.status,
        deliveredAt: delivered.claimedAt,
        artifactId: delivered.artifactId,
        artifactUrl: delivered.artifactUrl,
      },
    });
    return NextResponse.json({
      retired: true,
      reason:
        'A terminal verdict has already been delivered for this policy version. The readout is not recomputed; the artifact holds the verdict.',
      delivered,
      notified: false,
      alreadyNotified: true,
    });
  }

  const readout = await runMemoryDigestReadout({ policyVersion: READOUT_POLICY_VERSION });

  // Persisted first, and never load-bearing for the notification: the verdict
  // has to survive a push that nobody reads, and a persistence outage must not
  // be able to suppress the push.
  let persistError: string | null = null;
  try {
    await persistReadout(readout);
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.warn('[cron:memory-digest-readout] failed to persist readout:', persistError);
  }

  // The artifact is written BEFORE the claim so the notification can carry its
  // link, and it is idempotent (keyed upsert), so writing it on a run that then
  // loses the claim race costs nothing. An indeterminate readout is deliberately
  // NOT published: overwriting a real verdict with "no rows — the collection
  // path may be broken" would destroy the artifact exactly when it matters.
  let artifact: Awaited<ReturnType<typeof upsertReadoutArtifact>> = null;
  let artifactError: string | null = null;
  if (!readout.verdict.indeterminate) {
    try {
      artifact = await upsertReadoutArtifact(readout);
    } catch (err) {
      artifactError = err instanceof Error ? err.message : String(err);
      console.warn('[cron:memory-digest-readout] failed to upsert artifact:', artifactError);
    }
  }
  const artifactUrl = artifact ? artifactUrlFor(artifact.id) : null;

  let notified = false;
  let alreadyNotified = false;
  let cleanupTaskId: string | null = null;
  let cleanupTaskError: string | null = null;

  if (readout.verdict.terminal) {
    const claimed = await claimVerdictNotification(readout.verdict.notificationKey, {
      status: readout.verdict.status,
      artifactId: artifact?.id ?? null,
      artifactUrl,
    });
    if (claimed) {
      // Gated on the claim above, so this runs at most once ever — and never
      // for an `accruing` or `indeterminate` verdict, neither of which is
      // terminal (`buildVerdict` sets `terminal: false` for both).
      const spec = memoryDigestCleanupSpec({
        verdict: readout.verdict.status,
        artifactUrl,
      });
      if (artifact) {
        try {
          const filed = await fileExperimentCleanupTask({
            // The workspace the artifact was just written to: the cleanup task
            // lands next to the verdict the push links, and there stays exactly
            // one workspace-resolution rule for this experiment.
            workspaceId: artifact.workspaceId,
            spec,
          });
          cleanupTaskId = filed?.id ?? null;
          if (!cleanupTaskId) cleanupTaskError = 'insert returned no row';
        } catch (err) {
          cleanupTaskError = err instanceof Error ? err.message : String(err);
          console.warn('[cron:memory-digest-readout] failed to file cleanup task:', cleanupTaskError);
        }
      } else {
        // No artifact means no resolvable workspace (or a failed write). There
        // is nowhere to file a task; say so in the push rather than silently
        // dropping the follow-up work.
        cleanupTaskError = 'no workspace resolved for the readout artifact';
      }

      notify({
        app: 'alerts',
        // priority 0, not the module default of -1: a silent notification for
        // a terminal experiment verdict is a notification that is not read.
        priority: 0,
        title: `memory digest experiment — ${readout.verdict.status}`,
        // One extra line: what was filed to clean the experiment up, or that
        // nothing was. Belt and braces behind the task itself — the task is the
        // mechanism, this line is how the recipient knows it exists.
        message: [formatReadoutSummary(readout), cleanupNoticeLine(cleanupTaskId, cleanupTaskError)].join('\n'),
        // A push is read once and gone; the link is what makes it checkable.
        // Omitted rather than faked if the artifact could not be written — a
        // dead link in the only notification this experiment ever sends is
        // worse than a notification with no link.
        ...(artifactUrl ? { url: artifactUrl, urlTitle: 'Open the readout' } : {}),
      });
      notified = true;
    } else {
      alreadyNotified = true;
    }
  }

  report({
    processed: readout.cohortRows,
    changed: notified ? 1 : 0,
    errors: readout.verdict.indeterminate ? 1 : 0,
    result: {
      status: readout.verdict.status,
      terminal: readout.verdict.terminal,
      backend: readout.backend,
      policyVersion: readout.policyVersion,
      boundaryAt: readout.boundary?.at ?? null,
      nPerArm: readout.verdict.nPerArm,
      requiredNPerArm: readout.verdict.requiredNPerArm,
      notified,
      alreadyNotified,
      persisted: persistError === null,
      artifactId: artifact?.id ?? null,
      artifactUrl,
      artifactError,
      // Stage one of retirement, filed as work. Not counted in `changed`:
      // `changed` means "delivered the verdict", and a filing that failed must
      // not read as a run that accomplished nothing.
      cleanupTaskId,
      cleanupTaskError,
      // True from the NEXT run onwards: this run took the terminal claim.
      retiresFromNextRun: notified || alreadyNotified,
    },
  });

  return NextResponse.json({
    verdict: readout.verdict,
    notified,
    alreadyNotified,
    persisted: persistError === null,
    persistError,
    artifact: artifact ? { ...artifact, url: artifactUrl } : null,
    artifactError,
    cleanupTaskId,
    cleanupTaskError,
    readout,
    // The rendered report, so curling the endpoint by hand is the same
    // experience as running the CLI.
    text: formatReadoutText(readout),
  });
}
