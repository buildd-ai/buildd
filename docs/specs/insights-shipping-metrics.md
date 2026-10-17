---
title: Insights Shipping Metrics
status: active
owner: max
last_verified: 2026-10-17
summary: Insights MUST label shipping comparisons with exact rolling spans, count tasks shipped and failed or abandoned inside them, and report waiting as item counts with median and p90.
domain: surfaces
surfaces: [apps/web/src/lib/insights-flow.ts, apps/web/src/components/insights/insights-summary.ts, apps/web/src/components/insights/ShippedChart.tsx]
related: [usage-and-cost-accounting]
keywords: [insights, shipped, rolling window, calendar week, weekday, partial day, median, p90, start to production, failed or abandoned]
verified_by: [apps/web/src/lib/insights-metric-grammar.test.ts, apps/web/src/components/insights/insights-summary.test.ts, apps/web/src/components/insights/ShippedChart.test.ts]
supersedes: []
---

# Insights Shipping Metrics

The Insights page answers "does the team ship more, and what slowed it down".
This spec fixes what each number means so two readers cannot take different
things from the same sentence.

## Windows

- **MUST** treat `7d` and `30d` as rolling spans ending at the request's `now`
  (`[now - span, now)`), never calendar weeks or months. Copy says "the last 7
  days", never "this week" or "last week".
- **MUST** compare against the span immediately before (`[now - 2*span, now - span)`).
  The two spans share no instant: a task shipped exactly at the boundary belongs
  to the later span only (start inclusive, end exclusive).
- **MUST** show the exact current and previous spans, in the reader's timezone,
  beside the shipping sentence, and say each bar covers 24 hours from the window's
  start time and does not follow calendar days.
- The clock is injected (`now`), so every window is reproducible in tests.

## Bars

- One bar per 24 elapsed hours (not per local calendar day), so a daylight-saving
  change cannot make a 23- or 25-hour bar. Labels and ranges are rendered in the
  reader's zone; the table names each bar's exact span.
- A slice shorter than 24 hours is **partial**: drawn lighter, legended, and
  marked "(partial day)" in the table.
- **7d** bars sit beside the bar exactly 7 days earlier, the same weekday. **30d**
  bars do not: 30 days earlier is another weekday, so 30d compares in total only.

## Populations

- The unit is the **task**, keyed `parentTaskId ?? taskId`; a task retried or
  given several PRs counts once, by its latest PR. "PRs" in copy are that one PR.
- **Shipped**: reached production in the window: a healthy or degraded release
  carried it, or it merged in a workspace that tracks no releases. Percentage
  change is `round(|n - prev| / prev)`; a change that rounds to 0% reads "about
  the same", and the previous count is always shown.
- **Failed or abandoned**: the task failed or was cancelled with no PR, or its PR
  closed unmerged or was recorded abandoned, with that outcome inside the window.
  A PR superseded by another merged PR is neither shipped nor failed.
- Shipped and failed day totals equal the headline counts.

## Start to production

Median over tasks shipped in the window of: the task's first worker start, to its
first production release (or merge where no releases are tracked). The wait for a
runner before the first start is excluded; retries are included.

## Waiting

- **MUST NOT** headline a cumulative duration ("40 days of waiting"): summed
  across parallel tasks it is not a delay anyone experienced.
- Each category (question, CI, review, runner, retry, release) is reported as the
  number of affected tasks with **median** and **90th percentile** (nearest-rank)
  time per task, or the single duration for one task.
- The cumulative total and share of task time appear only in a row's detail
  line, labelled "in total across tasks".
