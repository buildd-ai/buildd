---
title: Human-in-the-Loop Protocol
status: superseded
owner: max
last_verified: 2026-10-15
summary: Every human answer to an agent MUST either reach a live session or become a durable retry task, and MUST NOT be accepted for a worker that can never act on it, applied twice, or reported as delivered when dropped.
domain: tasks
surfaces: [apps/web/src/lib/worker-instructions.ts, apps/web/src/lib/question-hold.ts, apps/web/src/app/api/workers/[id]/respond/route.ts, apps/web/src/app/api/workers/[id]/route.ts, apps/runner/src/workers.ts, apps/web/src/lib/worker-exit-taxonomy.ts, apps/web/src/app/api/workers/[id]/question-check/route.ts, apps/runner/src/question-gate.ts, packages/core/question-brief.ts, packages/core/question-gate.ts, packages/core/human-attention.ts, apps/web/src/lib/recoverable-blocker-repair.ts, apps/web/src/lib/home-attention.ts, packages/core/needs-you.ts, apps/web/src/lib/park-disposition.ts, apps/web/src/lib/note-question-disposition.ts, apps/web/src/components/tasks/TaskQuestion.tsx]
related: [agent-question-protocol, human-answer-delivery]
keywords: [deliver_pending, receive_messages, instructionIds, instructionsAcknowledged, turn boundary, waiting_input, waitingFor, pendingInstructions, instructionHistory, deliveryState, AskUserQuestion, send_agent_message, inputAsRetry, needs_input, worker-needs-input-banner, contractViolation, exitCause]
verified_by: [apps/web/src/lib/worker-instructions.test.ts, apps/web/src/app/api/workers/[id]/cmd/route.test.ts, apps/web/src/app/api/tasks/[id]/messages/route.test.ts, apps/runner/__tests__/unit/worker-sync-instructions.test.ts, apps/runner/__tests__/unit/instruction-acks.test.ts, apps/runner/__tests__/unit/backends/codex-multiturn.test.ts, packages/core/__tests__/mcp-tools-receive-messages.test.ts, apps/web/src/lib/question-hold.test.ts, apps/web/src/app/api/workers/[id]/instruct/route.test.ts, apps/web/src/app/api/workers/[id]/respond/route.test.ts, packages/core/__tests__/mcp-tools-send-agent-message.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/app/api/workers/[id]/interrupt/route.test.ts, apps/web/src/app/api/tasks/[id]/approve-plan/route.test.ts, apps/runner/__tests__/unit/worker-manager-state.test.ts, apps/web/src/lib/worker-exit-taxonomy.test.ts, apps/web/src/lib/failure-analytics.test.ts, apps/web/src/lib/stale-workers.test.ts, apps/web/src/lib/task-presentation.test.ts, packages/core/__tests__/question-brief.test.ts, packages/core/__tests__/question-gate.test.ts, apps/web/src/lib/question-gate-check.test.ts, apps/runner/__tests__/unit/question-gate.test.ts, apps/web/src/app/api/workers/[id]/question-check/route.test.ts, apps/web/src/app/api/workers/claim/question-gate.test.ts, apps/web/src/app/api/decisions/[id]/override/route.test.ts, packages/core/__tests__/human-attention.test.ts, apps/web/src/lib/home-attention.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/question-hero.test.ts, packages/core/__tests__/needs-you.test.ts, apps/web/src/lib/note-question-disposition.test.ts, apps/web/src/app/api/tasks/waiting-input/route.test.ts, apps/web/src/components/tasks/TaskQuestion.dom.test.tsx]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "respond-to-worker"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/respond"
    file: "apps/web/src/app/api/workers/[id]/respond/route.ts"
  - id: "instruct-worker"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/instruct"
    file: "apps/web/src/app/api/workers/[id]/instruct/route.ts"
  - id: "durable-answer-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/[id]/respond/route.test.ts"
  - id: "question-gate-check"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/question-check"
    file: "apps/web/src/app/api/workers/[id]/question-check/route.ts"
superseded_by: agent-question-protocol
---
# Contract map

The contract is split by capability. Existing criterion ids are preserved in
their owning child; links to this former aggregate resolve through this map.

- [agent-question-protocol](agent-question-protocol.md)
- [human-answer-delivery](human-answer-delivery.md)
