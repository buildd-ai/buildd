/**
 * POST /api/cron/page-budget-health
 *
 * Hourly: alert the operator about a page that has been over its speed budget
 * for the last hour (spec 3ef37387 R-31), naming the page and its heaviest
 * loader (R-42), at most once a day per page. See lib/page-budget-watch.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { notifyOperator } from '@/lib/pushover';
import {
  claimPageAlert, deleteExpiredLoads, formatPageBudgetAlert, planPageBudgetAlerts,
  readLastAlerted, readOverBudgetLoads,
} from '@/lib/page-budget-watch';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return withCronRun('page-budget', req, report => run(report));
}

async function run(report: CronReport): Promise<NextResponse> {
  const now = Date.now();
  const [loads, lastAlerted] = await Promise.all([readOverBudgetLoads(now), readLastAlerted()]);
  const due = planPageBudgetAlerts(loads, lastAlerted, now);
  const sent: string[] = [];
  for (const alert of due) {
    if (!(await claimPageAlert(alert.page, now))) continue;
    const { title, message } = formatPageBudgetAlert(alert);
    notifyOperator({ app: 'alerts', title, message, priority: 0 });
    sent.push(alert.page);
  }
  await deleteExpiredLoads(now).catch(() => {});
  report({ processed: loads.length, changed: sent.length, result: { alerted: sent } });
  return NextResponse.json({ ok: true, overBudgetLoads: loads.length, alerted: sent });
}
