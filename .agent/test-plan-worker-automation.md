# Test Plan: Worker Automation & Planning Improvements

## Prerequisites

- Local dev running: `bun dev` (apps/web on :3000, local-ui on :3001)
- Admin API key set: `BUILDD_API_KEY` with admin level
- At least one workspace configured with a linked repo
- Pusher configured for real-time events (or test without for API-only checks)

---

## 1. Plan Review UI in Dashboard

### 1A. Plan panel appears when worker submits plan

**Setup:** Create a task with `mode: planning`

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_ID","title":"Test planning task","description":"Investigate X","mode":"planning"}'
```

**Steps:**
1. Open task detail page in dashboard
2. Claim the task with a worker (local-ui or MCP)
3. Worker submits a plan (via `submit_plan` tool or API)
4. Observe the dashboard - should show:
   - Worker status badge changes to `awaiting_plan_approval` (amber)
   - Task header status shows `awaiting_plan_approval` (amber)
   - PlanReviewPanel appears with plan content rendered as markdown
   - "Approve Plan" and "Request Changes" buttons visible

**Verify without worker** (API shortcut):
```bash
# Claim
curl -X POST http://localhost:3000/api/workers/claim \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_ID"}'

# Submit plan
curl -X POST http://localhost:3000/api/workers/WORKER_ID/plan \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plan":"# Plan\n\n## Approach\n1. Do X\n2. Do Y\n\n## Files\n- src/foo.ts\n- src/bar.ts"}'
```

Then refresh the task page and verify the plan panel renders.

### 1B. Approve plan flow

**Steps:**
1. With plan panel visible, click "Approve Plan"
2. Verify:
   - Success message appears: "Plan approved - worker will continue with implementation"
   - Worker status changes back to `running`
   - Plan panel disappears (status no longer `awaiting_plan_approval`)

**API verify:**
```bash
curl -X POST http://localhost:3000/api/workers/WORKER_ID/plan/approve \
  -H "Authorization: Bearer $API_KEY"
```

### 1C. Request changes flow

**Steps:**
1. With plan panel visible, click "Request Changes"
2. Textarea appears for feedback
3. Enter feedback text, click "Send Feedback"
4. Verify:
   - Success message: "Revision feedback sent to worker"
   - Worker status changes back to `running`
   - Feedback form hides

**API verify:**
```bash
curl -X POST http://localhost:3000/api/workers/WORKER_ID/plan/revise \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"Please add error handling section"}'
```

### 1D. Real-time update via Pusher

**Steps:**
1. Open task detail page with active worker (status: `running`)
2. In a separate terminal, submit a plan via API (curl above)
3. Without refreshing, verify:
   - Status badge updates to `awaiting_plan_approval`
   - PlanReviewPanel appears automatically

---

## 2. Server-Triggered "Request Plan"

### 2A. Request Plan button visibility

**Steps:**
1. Open task with a worker in `running` status
2. Verify "Request Plan" button appears next to the instruction form
3. Open task with worker in `waiting_input` - button should NOT appear
4. Open task with worker in `awaiting_plan_approval` - button should NOT appear

### 2B. Request Plan button sends structured instruction

**Steps:**
1. Click "Request Plan" on a running worker
2. Button shows loading, then "Plan requested" confirmation
3. Verify instruction was stored:

```bash
curl http://localhost:3000/api/workers/WORKER_ID \
  -H "Authorization: Bearer $API_KEY" | jq .pendingInstructions
```

Expected: `"{\"type\":\"request_plan\",\"message\":\"Please pause implementation...\"}"` or `null` (if already consumed by sync)

### 2C. MCP server formats request_plan instruction

**Steps:**
1. Send a request_plan instruction to a worker
2. Worker calls `buildd_update_progress`
3. Verify the response includes formatted plan request:

```bash
# Set up the instruction
curl -X POST http://localhost:3000/api/workers/WORKER_ID/instruct \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"request_plan","message":"Need to review approach before continuing"}'

# Worker syncs (simulated)
curl -X PATCH http://localhost:3000/api/workers/WORKER_ID \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"running","progress":50}'
```

Response should contain `instructions` field with the JSON-encoded request_plan.

### 2D. Instruction history records type

**Steps:**
1. After sending a request_plan instruction, check instruction history
2. Verify the entry has `type: "request_plan"` (not just `"instruction"`)

---

## 3. `submit_plan` MCP Tool

### 3A. Tool appears in tool list

**Steps:**
1. Start the MCP server
2. List tools - verify `buildd_submit_plan` appears in the base tools (available to all levels)

### 3B. CLI worker submits plan

**Steps:**
1. Claim a planning-mode task via MCP
2. Call `buildd_submit_plan` with worker ID and markdown plan
3. Verify:
   - Response: "Your plan has been submitted for review..."
   - Worker status changes to `awaiting_plan_approval` on server
   - Plan artifact created in database

```bash
# Verify plan artifact
curl http://localhost:3000/api/workers/WORKER_ID/plan \
  -H "Authorization: Bearer $API_KEY" | jq .plan.content
```

### 3C. submit_plan with invalid worker ID

**Steps:**
1. Call `buildd_submit_plan` with a non-existent worker ID
2. Verify error response (not a crash)

### 3D. submit_plan without required params

**Steps:**
1. Call `buildd_submit_plan` without `plan` field
2. Verify: error "workerId and plan are required"

---

## 4. GitHub Issue Planning Mode

### 4A. Issue with `buildd:plan` label creates planning task

**Setup:** Have a repo linked to a workspace with webhook configured

**Steps:**
1. Create a GitHub issue with labels: `buildd`, `buildd:plan`
2. Verify webhook creates task with `mode: 'planning'`

**API simulation:**
```bash
curl -X POST http://localhost:3000/api/github/webhook \
  -H "x-github-event: issues" \
  -H "x-hub-signature-256: sha256=VALID_SIG" \
  -H "x-github-delivery: test-123" \
  -d '{
    "action": "opened",
    "installation": {"id": INSTALL_ID},
    "repository": {"id": REPO_ID, "full_name": "owner/repo"},
    "issue": {
      "id": 999,
      "number": 42,
      "title": "Plan: refactor auth",
      "body": "Need to plan auth refactor",
      "html_url": "https://github.com/owner/repo/issues/42",
      "labels": [
        {"name": "buildd"},
        {"name": "buildd:plan"}
      ]
    }
  }'
```

Then verify task was created with `mode: 'planning'`:
```bash
curl http://localhost:3000/api/tasks \
  -H "Authorization: Bearer $API_KEY" | jq '.tasks[] | select(.externalId == "issue-999") | .mode'
```

Expected: `"planning"`

### 4B. Issue without `buildd:plan` label uses execution mode

**Steps:**
1. Create a GitHub issue with only `buildd` label (no `buildd:plan`)
2. Verify task created with `mode: 'execution'` (default)

### 4C. Case insensitivity

**Steps:**
1. Create issue with label `Buildd:Plan` (mixed case)
2. Verify it still triggers planning mode (`.toLowerCase()` comparison)

---

## 5. Task Cleanup API

### 5A. Endpoint requires auth

**Steps:**
1. Call without auth:
```bash
curl -X POST http://localhost:3000/api/tasks/cleanup
```
2. Verify: 401 Unauthorized

3. Call with worker-level token:
```bash
curl -X POST http://localhost:3000/api/tasks/cleanup \
  -H "Authorization: Bearer $WORKER_API_KEY"
```
4. Verify: 401 (worker tokens are not admin)

### 5B. Stalled workers cleanup (>1 hour)

**Setup:** Insert a worker with `status: 'running'` and `updatedAt` > 1 hour ago

```sql
UPDATE workers SET status = 'running', updated_at = NOW() - INTERVAL '2 hours'
WHERE id = 'TEST_WORKER_ID';
```

**Steps:**
1. Call cleanup endpoint:
```bash
curl -X POST http://localhost:3000/api/tasks/cleanup \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```
2. Verify response: `{ "cleaned": { "stalledWorkers": 1, ... } }`
3. Verify worker status is now `failed` with error "Worker timed out"

### 5C. Orphaned tasks cleanup (>2 hours)

**Setup:** Set a task to `status: 'assigned'` with `updatedAt` > 2 hours ago, and no active workers

```sql
UPDATE tasks SET status = 'assigned', updated_at = NOW() - INTERVAL '3 hours'
WHERE id = 'TEST_TASK_ID';
-- Ensure all workers for this task are completed/failed
```

**Steps:**
1. Call cleanup endpoint
2. Verify response includes `orphanedTasks: 1`
3. Verify task status is now `pending`

### 5D. Expired plan approvals (>24 hours)

**Setup:** Set a worker to `status: 'awaiting_plan_approval'` with `updatedAt` > 24 hours ago

**Steps:**
1. Call cleanup endpoint
2. Verify response includes `expiredPlans: 1`
3. Verify worker status is now `failed`

### 5E. No false positives

**Steps:**
1. Create a worker with `status: 'running'` and `updatedAt` = now
2. Call cleanup endpoint
3. Verify `stalledWorkers: 0` - recently active workers not cleaned

### 5F. MCP admin tool

**Steps:**
1. Call `buildd_run_cleanup` via MCP
2. Verify response shows cleanup counts
3. Verify non-admin token gets "requires admin-level token" error

---

## 6. Task Decomposition via Worker

### 6A. Decompose creates child task

**Steps:**
1. Create a parent task:
```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_ID","title":"Build auth system","description":"Implement full auth with OAuth, sessions, and API keys"}'
```

2. Call `buildd_decompose_task` via MCP with the task ID

3. Verify:
   - New task created with title "Decompose: Build auth system"
   - New task has `parentTaskId` set to the parent task ID
   - New task description includes the parent task description
   - New task has `mode: 'execution'` (worker needs to create tasks)
   - New task status is `pending` (ready for claiming)

### 6B. Decomposition task content

**Steps:**
1. After creating decomposition task, verify its description contains:
   - Parent task title and description
   - Instructions to create subtasks via `buildd_create_task`
   - Guidance on 3-7 subtasks

### 6C. Non-admin cannot decompose

**Steps:**
1. Call `buildd_decompose_task` with a worker-level token
2. Verify error: "requires admin-level token"

### 6D. Invalid task ID

**Steps:**
1. Call `buildd_decompose_task` with non-existent task ID
2. Verify error response (not crash)

---

## Integration Scenarios

### E2E: Full Planning Workflow

1. Create task with `mode: planning` via dashboard or API
2. Worker claims task (local-ui)
3. Worker investigates codebase (read-only tools enforced)
4. Worker calls `submit_plan`
5. Dashboard shows plan in PlanReviewPanel
6. Admin clicks "Request Changes" with feedback
7. Worker receives feedback, revises plan, resubmits
8. Admin clicks "Approve Plan"
9. Worker continues in execution mode (can now edit files)
10. Worker completes task

### E2E: Runtime Plan Request

1. Create task with `mode: execution`
2. Worker claims and starts working
3. Admin clicks "Request Plan" button in dashboard
4. Worker receives structured instruction on next progress sync
5. Worker pauses, investigates, calls `submit_plan`
6. Admin reviews and approves
7. Worker continues

### E2E: Decomposition + Subtask Execution

1. Create a large task
2. Admin calls `buildd_decompose_task`
3. Decomposition task created as child
4. Worker claims decomposition task
5. Worker investigates codebase, creates 3-7 subtasks via `buildd_create_task`
6. Worker completes decomposition task
7. Parent task now has subtasks visible in dashboard
8. Other workers claim and execute subtasks independently
