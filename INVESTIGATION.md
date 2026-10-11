# Investigation: Review System Issues (PR #4429)

## Issue Summary

Two distinct problems in the PR review system, discovered when PR #4429's second review attempt failed:

### Issue 1: Dropped Prose Verdict Not Auto-Re-queued

**Location**: `/api/workers/[id]/route.ts` line 3672

When a reviewer task completes with prose summary but no `structuredOutput.verdict`:
- **For legacy reviews**: Prose fallback extraction engages, constructs a fallback verdict, and the task is retried automatically (lines 3674-3690)
- **For kernel reviews**: Prose fallback is explicitly skipped (`!kernelReviewRound` condition), the task is marked failed, and a comment says "nothing re-reviews a PR whose review ended without a verdict"

The problem: For kernel reviews, there's no automatic re-review mechanism implemented. The code assumes the kernel will handle it, but the kernel doesn't have this logic.

**Evidence**: The error message "Review task completed without structuredOutput.verdict, the verdict was returned as prose and dropped. Review will be redone." indicates the fallback extraction recognized prose but the task failed instead of being retried.

### Issue 2: `request_pr_review` Returns `state: undefined` with Null Status

**Location**: `/api/github/pr/review/route.ts` lines 277-292

When the workflow kernel handles a PR review request and returns `alreadyRequested: true`:

```typescript
status: latest
  ? derivePrReviewStatus({ reviewTask: latest, ... })
  : null,  // ← status can be null here!
```

If the kernel reports `reviewTaskId` but the task is not found in DB (or was deleted), `latest` is null, so `status` is set to null. The MCP layer then renders this as `"state: undefined"` when it tries to access `status?.state`.

This violates the contract that `status` should always be a valid `PrReviewStatus` object when `alreadyRequested: true`.

## Root Causes

1. **Prose fallback only implemented for legacy reviews**: Kernel reviews deliberately skip prose extraction, assuming the kernel handles retries. But the kernel has no such mechanism.

2. **Null status in response**: The kernel path doesn't guarantee `status` is non-null even when returning a valid review task state. A missing DB task creates a null status, which the MCP layer can't safely render.

## Fixes Required

1. Apply prose fallback extraction to kernel reviews as well as legacy reviews
2. Ensure `status` is always non-null when `alreadyRequested: true`, using fallback derivation if the task row is missing
