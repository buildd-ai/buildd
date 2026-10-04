/**
 * Static instructional text of the organizer's planning context
 * (`mission-context.ts`), resolved through the versioned prompts table
 * (`@buildd/core/prompts`). The text here is the public default; an active
 * prompts row replaces it. Everything computed per mission stays in
 * `mission-context.ts` and fills a `{{placeholder}}`; an active row must keep
 * exactly the default's placeholders or it is rejected and this text runs.
 *
 * Pure: no DB, no env.
 */

export const MISSION_PROMPT_IDS = {
  criteriaRearm: 'buildd.mission.criteria_rearm',
  coordinateOnly: 'buildd.mission.coordinate_only',
  coordinateOnlyException: 'buildd.mission.coordinate_only_exception',
  coordinationWorkspace: 'buildd.mission.coordination_workspace',
  priorWorkGate: 'buildd.mission.prior_work_gate',
  efficiencyMode: 'buildd.mission.efficiency_mode',
  repeatResults: 'buildd.mission.repeat_results',
  existingChain: 'buildd.mission.existing_chain',
  manyCycles: 'buildd.mission.many_cycles',
  awaitingInput: 'buildd.mission.awaiting_input',
  budgetWait: 'buildd.mission.budget_wait',
  sequencingIntegration: 'buildd.mission.sequencing_integration',
  sequencingDirect: 'buildd.mission.sequencing_direct',
} as const;

/** Placeholders: overall, reason, blockReason, verdictBlock. */
export const CRITERIA_REARM_TEMPLATE =
  `\n## ⚠ RE-ARMED BY A BLOCKED COMPLETION GATE\n` +
  `Every deliverable task in this mission is terminal, so nothing is pending — ` +
  `and the mission still CANNOT complete, because its goal criteria came back ` +
  `**{{overall}}**. {{reason}}\n\n` +
  `Refusal: {{blockReason}}\n\n` +
  `{{verdictBlock}}` +
  `**Do not propose completion this cycle.** Proposing it again produces the same ` +
  `refusal and no progress. Exactly one of these is the right output:\n` +
  `1. File the work that closes a named gap (\`create_task\` with a concrete ` +
  `pathManifest). This is the expected outcome when a criterion names something real ` +
  `that no open task covers.\n` +
  `2. Argue the criterion is wrong or unmeasurable as written, via \`post_note\` ` +
  `(type=question) naming which criterion and why. Say what it should say instead. ` +
  `Do NOT silently work around it.\n` +
  `3. If a criterion needs evidence that exists but was never attached (an artifact, ` +
  `a doc, a command result), file the task that attaches it.\n\n` +
  `Note the mechanics: an \`artifact_exists\` criterion is satisfied by a buildd ` +
  `artifact (\`create_artifact\`), NOT by a file merged in a PR. An \`all_prs_merged\` ` +
  `criterion needs the PRs actually merged, not just opened and approved. If a prior ` +
  `task delivered the substance but not the form the criterion checks, that is a real ` +
  `gap — file it or say the criterion is measuring the wrong thing.\n` +
  `If nothing here can move, say so plainly: an unchanged verdict escalates to the ` +
  `mission owner rather than repeating this cycle.`;

export const MISSION_PROMPT_DEFAULTS = {
  coordinateOnly:
    '\n## COORDINATE-ONLY MODE — Pre-Filed Tasks Detected\n' +
    'Pre-filed tasks were detected when this mission was first evaluated. ' +
    '**You must NOT create new build tasks.** Your role is coordination:\n\n' +
    '- [ ] Monitor the tasks listed in "Active Tasks" below\n' +
    '- [ ] Report blocked tasks and notify via post_note if a human decision is needed\n' +
    '- [ ] When ALL pre-filed tasks are terminal (completed/failed/cancelled), signal `missionComplete: true` in structuredOutput\n\n' +
    'The platform retries failed tasks and handles PR conflicts and CI failures itself. Do not file retry tasks for them.\n\n' +
    'Do NOT create new tasks unless (a) a listed task failed terminally because its approach is wrong, and you file a replacement with a different approach (`parentTaskId=<original task id>`, `failureContext` naming the change), ' +
    'or (b) the mission description explicitly authorizes gap-filling. ' +
    'Adding tasks beyond the pre-filed chain creates duplicates and wasted work.',
  coordinateOnlyException:
    '**EXCEPTION — coordinate-only mode is lifted for the blocking criteria above.** ' +
    'You may create tasks for gaps named in a non-passing criterion, and only for those. ' +
    'Each such task must quote the criterion it unblocks in its description. ' +
    'This is not authorization to re-decompose the mission: no new tasks for anything ' +
    'the blocking criteria do not name.',
  coordinationWorkspace:
    '**Current workspace: `__coordination` (meta-workspace)**\n' +
    'This workspace has no repo and is NOT a project workspace.\n' +
    'For code missions (builder tasks), you MUST create a dedicated workspace with a repo before creating tasks.',
  priorWorkGate:
    '**Prior-work gate**: Before creating any task, check "Related prior work" above. ' +
    'If a retrieved item scores ≥0.82 similarity AND its PR was merged within 14 days, ' +
    'do NOT create the task. Instead: `post_note type=decision` naming the PR and explaining ' +
    'why decomposition was skipped for that item.',
  efficiencyMode:
    '**Efficiency mode**: This mission has an established pattern. Be fast:\n' +
    '- If the work is routine (same type as prior tasks), create the task with the proven role — don\'t over-analyze.\n' +
    '- Only do a full evaluation if something has changed (failures, new requirements, blocked work).\n' +
    '- For recurring monitoring/check-ins, keep the same structure unless results indicate a problem.',
  repeatResults:
    '⚠️ Recent tasks produced nearly identical results. Focus on what has CHANGED since the last run. ' +
    'Do NOT repeat the same analysis — identify new developments, blockers removed, or status changes. ' +
    'If nothing meaningful has changed, create fewer or no sub-tasks.',
  existingChain:
    '\n**Existing task chain detected** — there are pending/active tasks with `dependsOn` set. ' +
    'Do NOT create overlapping tasks. If additional work is needed, add to the existing chain.',
  manyCycles:
    'This mission has been through many cycles. Strongly consider whether objectives are met and completion should be proposed — the goal-criteria gate decides whether it closes.',
  awaitingInput:
    'These tasks are paused — a human must respond before they can continue. Consider working around these dependencies or spawning independent tasks.',
  budgetWait:
    'These tasks hit a session/usage limit and are queued to auto-resume when the budget window reopens. They are NOT failed — do NOT create retry children. They count as active work in progress.',
  sequencingIntegration:
    '**Sequencing**: This mission has task PRs and an integration branch{{workingBranch}}'
    + ', so sibling task PRs are not a conflict: each targets the integration branch and merges '
    + 'there unattended, and dependents unblock without a human. Chain a plan step with '
    + '`dependsOn` and `baseBranch` only when it touches the same files as another step or as an '
    + 'open PR of this mission. Chain on path overlap; the platform serializes '
    + 'same-mission siblings at claim time regardless, so an integration branch buys '
    + 'a shorter wait per link, not parallelism.',
  sequencingDirect:
    '**Sequencing**: This mission already has task PRs. That is not by itself a reason to '
    + 'serialize — each task gets its own branch and its own PR. Chain a plan step with '
    + '`dependsOn` and `baseBranch` when it touches the same files as another step or as an open '
    + 'PR of this mission; beyond that, follow the Sequencing Rules in your role prompt.',
} as const satisfies Record<Exclude<keyof typeof MISSION_PROMPT_IDS, 'criteriaRearm'>, string>;
