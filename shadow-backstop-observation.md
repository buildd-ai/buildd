# Shadow Backstop Observation — Oct 19, 2026

**Observation window**: 2026-10-12 08:01 to 2026-10-19 08:01 UTC (7 days)  
**Status**: Stable with emergent budget patterns  
**Overall failure rate**: 22% (578/2635 terminal workers)

---

## Worker Failures — Summary

**Total outcomes**: 2635 terminal workers, 231 still running, 4 died early (1%)

### Exit Causes
| Category | Count | % |
|----------|-------|---|
| auth_failure | 289 | 50% |
| budget_limited | 164 | 28% |
| code_failure | 94 | 16% |
| output_unmet | 17 | 3% |

### Top 5 Failure Signatures

1. **Codex credential expired** (211 failures, auth_failure)
   - Signature: `Codex credential for accountId=[REDACTED] expired at <ts>`
   - Last seen: 2026-10-15T23:15:38 UTC
   - Status: Known pattern (see memory: `codex-backend-blockers`)
   - Severity: **HIGH** — 36% of auth failures

2. **Upstream usage limit exceeded** (80 failures, budget_limited)
   - Signature: `You've hit your usage limit. Upgrade to Pro...`
   - Last seen: 2026-10-18T05:31:03 UTC
   - Status: **NEW EMERGENT PATTERN** — not seen in prior backstop reports
   - Severity: **HIGH** — 49% of budget failures

3. **CLI not authenticated** (78 failures, auth_failure)
   - Signature: `Not logged in · Please run /login`
   - Last seen: 2026-10-17T01:53:17 UTC
   - Status: Recurring CLI auth issue
   - Severity: **MEDIUM** — 27% of auth failures

4. **Weekly usage limit hit** (25 failures, budget_limited)
   - Signature: `You've hit your weekly limit · resets Oct <n>, <time>`
   - Last seen: 2026-10-14T01:58:27 UTC
   - Status: New pattern, secondary to #2
   - Severity: **MEDIUM** — 15% of budget failures

5. **Additional daily limit** (16 failures, budget_limited)
   - Signature: `You've hit your usage limit. Upgrade to Pro...` (different rate limit)
   - Last seen: 2026-10-18T06:09:22 UTC
   - Status: New pattern, tertiary to #2
   - Severity: **MEDIUM** — 10% of budget failures

---

## Gate-Level Observations

**Total gate events**: 5000 across 23 gates · 202 rejected · 4181 deferred · 196 bypassed · 288 warned

### Critical Gates

#### 1. path_declaration (2542 events)
- **Deferred**: 2533 (99.6%)
- **Warned**: 9 (0.4%)
- **Reason**: "path declaration denied by a live holder" (path overlap mitigation)
- **Assessment**: Working as designed; 9 warnings about "coordination unavailable, edits proceeded" are advisory
- **Severity**: **LOW** ✓

#### 2. pr_landing (854 events) — ⚠️ Stranded items detected
- **Deferred**: 803 | **Stranded**: 51 | **Bypass rate**: 0%
- **Top blockers**:
  - "branch refresh queued; landing re-reads on new head" (170 cases, 20% of deferrals)
  - "delivery AWAITING_REVIEW; kernel lands only once APPROVED" (67 cases, 8% of deferrals)
- **Last event**: 2026-10-19T07:53:18 UTC
- **Severity**: **MEDIUM** — 51 stranded PR outcomes suggest landing queue backup

#### 3. claim_loop_deferral (796 events) — ⚠️ Stranded items detected
- **Deferred**: 558 | **Bypassed**: 159 | **Stranded**: 79 | **Bypass rate**: 100%
- **Top reasons**:
  - "budget_paused" (266 deferrals, 33% of total)
  - "advisory_manifest" (198 deferrals, 25% of total)
  - "force_claim" (155 deferrals, 19% of total)
- **Last event**: 2026-10-19T06:23:08 UTC
- **Severity**: **MEDIUM** — 79 stranded task claims indicate blocked work pickup

#### 4. ci_retry_skipped (253 events)
- **Rejected**: 55 | **Deferred**: 198 | **Bypass rate**: 0%
- **Top reason**: "no CI retry yet: a fix attempt for this PR is still in flight" (198, 79%)
- **Assessment**: Normal; indicates in-flight fix retries
- **Severity**: **LOW** ✓

#### 5. base_advance_notice (179 events)
- **Warned**: 179 (advisory only)
- **Reason**: "base branch advanced under a live worker on overlapping files"
- **Assessment**: Expected in high-concurrency; purely informational
- **Severity**: **LOW** ✓

### Stalled/Stranded Summary
- **pr_landing stranded**: 51 (landing gate holding PRs)
- **claim_loop_deferral stranded**: 79 (task pickup blocked)
- **Total**: 130 stranded outcomes — not acute spike, but steady accumulation

---

## Knowledge Ingest Stall

**Stalled tasks**: 1 (buildd-ai/buildd)
- **Status**: Using serverless fallback, waiting 2h03m
- **Progress**: 448 of 3771 files (12%)
- **Severity**: **MEDIUM** — slow ingestion but progressing

---

## Dispatch & Coordination Health

| Metric | Value |
|--------|-------|
| Dispatch wake failures (24h) | 59 |
| Outbox pending | 0 (no stuck deliveries) |
| Delivered (24h) | 752 events |
| Latency p50 | 16.8s |
| Latency p95 | 32m |
| Worker reachable | ✓ (43 ms) |

**Assessment**: Coordination stable; no critical queue backups detected.

---

## Pattern Analysis & Severity Assessment

### Emergent Patterns (Candidate for Incident)

1. **Upstream Provider Budget Limits — NEW/HIGH IMPACT**
   - **Signatures**: Usage limits (80 + 25 + 16 = 121 failures, 74% of budget_limited)
   - **Timeline**: Consistent since 2026-10-14
   - **Root cause**: External provider rate/usage limits hitting buildd workers
   - **Impact**: 121 worker failures out of 2635 = 4.6% of all terminals
   - **Status**: NOT yet in open incidents/missions
   - **Recommendation**: File upstream provider diagnostics task (non-blocking; appears to be customer-side limit hits, not platform issue)
   - **Severity**: **MEDIUM** — new pattern but externally driven

2. **Codex Credential Lifecycle — EXISTING PATTERN**
   - **Signature**: Codex credential expired (211 failures, 36% of auth_failures)
   - **Timeline**: Repeating since at least 2026-10-01 (per prior observations)
   - **Root cause**: Known issue per memory (`codex-backend-blockers`)
   - **Status**: Already tracked
   - **Severity**: **HIGH** — consistent 36% of auth failures, but known issue

3. **Stranded Gate Outcomes — EXISTING PATTERN**
   - **Signatures**: 51 pr_landing + 79 claim_loop_deferral stranded (130 total)
   - **Timeline**: Steady accumulation over window
   - **Root cause**: Normal deferrals + branch refresh queues + budget_paused state
   - **Status**: Appears related to base_advance_notice warnings (branch drift)
   - **Severity**: **MEDIUM** — no spike, but gate health should be monitored

---

## Compared to Prior Observations

- **Oct 10 evening** (memory: `shadow-sentinel-oct-8`): 6% failure rate, claim_loop_deferral load 24%
- **Current (Oct 19)**: 22% failure rate, claim_loop_deferral now 796 events (similar proportional load)
- **Difference**: Budget-limit failures have EMERGED as 28% of cause (vs. prior focus on auth expiry + build timeouts)

---

## Recommendations

### Immediate Actions (Non-blocking)
- ✓ Continue shadow observation; no incident paging warranted
- Document emergent budget-limit pattern for future root-cause analysis
- Monitor pr_landing and claim_loop_deferral stranded counts for spike

### Follow-up Investigation (for native Failure Pattern Sentinel)
1. Correlate budget_limited spike (121 failures) with specific accounts/backends
2. Confirm Codex credential refresh is operational (known blockers list)
3. Analyze base_advance_notice warnings for branch-drift correlation to stalled gates

---

## Artifact Metadata

| Field | Value |
|-------|-------|
| Window | 7d (2026-10-12 to 2026-10-19) |
| Failure rate | 22% |
| Primary pattern | Budget limits (28% of failures, NEW) |
| Secondary pattern | Credential expiry (36% of auth failures, KNOWN) |
| Stalled items | 130 (51 PRs + 79 tasks, STEADY) |
| Overall severity | **MEDIUM** — Stable operation with emergent budget pattern |
| Incident-worthy | NO — No systemic crisis, budget limits appear external |
| Ready for Sentinel handoff | YES — Patterns documented for native durable incident tracking |
