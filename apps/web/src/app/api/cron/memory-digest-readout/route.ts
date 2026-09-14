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
import { notify } from '@/lib/pushover';
import { appBaseUrl } from '@/lib/app-url';
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

  if (readout.verdict.terminal) {
    const claimed = await claimVerdictNotification(readout.verdict.notificationKey, {
      status: readout.verdict.status,
      artifactId: artifact?.id ?? null,
      artifactUrl,
    });
    if (claimed) {
      notify({
        app: 'alerts',
        // priority 0, not the module default of -1: a silent notification for
        // a terminal experiment verdict is a notification that is not read.
        priority: 0,
        title: `memory digest experiment — ${readout.verdict.status}`,
        message: formatReadoutSummary(readout),
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
    readout,
    // The rendered report, so curling the endpoint by hand is the same
    // experience as running the CLI.
    text: formatReadoutText(readout),
  });
}
