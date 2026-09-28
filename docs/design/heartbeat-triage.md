# Heartbeat Triage: Ask a Decision Model Before Hiring the Organizer

**Status:** Accepted (shadow shipped; apply off)
**Related:** `apps/web/src/lib/heartbeat-triage.ts`, `apps/web/src/lib/heartbeat-prepass.ts`, `apps/web/src/app/api/cron/schedules/route.ts`, `apps/web/src/lib/mission-context.ts` (`buildHeartbeatContext`), `packages/core/inference-policy.ts`, `packages/core/decision-client.ts`, `scripts/decision-benchmark.ts`, `docs/design/decision-calls.md`

## Problem

A goal mission's heartbeat wakes the organizer on its cadence. The token-free
prepass (`evaluateHeartbeatPrepass`) skips a cycle when the mission is done,
blocked, on a known self-resolving wait, or unchanged. Every other cycle
dispatches a full runner session. That session reads the heartbeat context and,
on most cycles, reports that the work in flight needs nothing from it: "blocked
on merge", "the next task properly depends on the open PR". Each of those costs a
runner slot and minutes of an agent's session to say "wait".

The question the organizer answers first, "does this cycle need me?", is a
fixed-label judgement over text the server already has: `buildMissionContext`
renders the whole heartbeat context on the server before dispatch.

## Proposal

Between the prepass and the dispatch, ask Jev (`decisionCall`, capability
`heartbeat_triage`) one choice question over a condensed copy of that context:

- `wait`: nothing to do this cycle;
- `act`: the organizer must act now.

**The crux:** a wrong `wait` is the expensive error. It silently delays work the
organizer would have filed. So only a confident `wait` may skip, and a skip is
bounded:

- `WAIT_MIN_CONFIDENCE` (0.9) gates the pick;
- the organizer always runs once its last cycle is older than `TRIAGE_MAX_WAIT_MS`
  (3h), so a wrong `wait` costs at most that long;
- a skip restores the prepass's no-change hash, so the next tick triages the same
  state again instead of reading "no change" and never waking the organizer;
- `act`, low confidence, a failed call, no OpenRouter key, the feature set to
  `runner`, a sensitive workspace or a criteria re-arm all dispatch as before.

**Shadow first.** `TRIAGE_APPLY` ships `false`: every cycle gets a look, and none
is skipped. The look is recorded on the dispatched task's context
(`context.heartbeatTriage`), so the organizer's own outcome on the exact same
state grades the pick. That is the gold the offline benchmark lacked.

The state is built from the rendered description text, not from the rows, so
`scripts/decision-benchmark.ts --set heartbeat_triage` can rebuild it from a past
cycle's stored description exactly as the live call saw it.

## Current evidence

A first offline run over a few dozen past completed heartbeat cycles, labelled by
what the organizer did (children filed, retries, completion claims), did not
support applying:

- with strict labels (any reported action counts as `act`), Jev was below the
  always-dispatch baseline, and its confident `wait` picks were right about half
  the time;
- with lenient labels (only filed, retried or completed work counts as `act`), a
  confident `wait` was right roughly three times in four.

The labels are noisy: organizers report `action_taken` for cycles that only
assessed the state. And the sample is too small to read a threshold from. The
prompt was not tuned against it. Shadow records replace this gold with a
same-state comparison.

## Implementation sketch

1. `heartbeat-triage.ts`: question, condensed state, gate, never-throw wrapper,
   the facts lookup (last organizer cycle, data class).
2. `inference-policy.ts`: `heartbeat_triage` is a live server feature, so it
   defaults to server with a team key and appears in Settings → Model features.
3. Cron schedules route: after `buildMissionContext`, before the insert.
4. Benchmark set `heartbeat_triage`, with `wait` precision per threshold.
5. **Later:** grade the shadow records against each cycle's outcome, then set
   `TRIAGE_APPLY` and the threshold from that table.

## Open questions

- **Gold from shadow records.** What counts as the organizer "acting"? Leaning:
  children filed, a task retried or cancelled, a PR merged or a completion
  proposed, all read from rows the cycle wrote, not from its self-report.
- **A second label.** `release_next_step` / `retry_failed` could be executed on
  the server without the organizer. Leaning: not until `wait` is applied and
  measured; each needs a server-side executor.
- **LiteLLM.** Resolved: Jev is not on a LiteLLM proxy, but a team can set its
  decision model (`teams.decision_model`) to any model behind its gateway, and
  triage asks it through the kit's chat endpoint (confidence from logprobs). Its
  picks are shadow like Jev's; a threshold for it needs its own benchmark.

## Non-goals

- Replacing the organizer's planning. Triage only decides whether it runs.
- Any change for teams without an OpenRouter key: they dispatch as today.
- Changing the prepass, the circuit breaker or the planning backoff.
