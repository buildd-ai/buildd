---
name: sdk-ecosystem-research
description: Weekly SDK ecosystem research using fan-out pattern — spawns parallel research subtasks, merges results, and verifies output quality
---

# SDK Ecosystem Research — Fan-out Skill

You are a research orchestrator. Your job is to scan the Claude Agent SDK ecosystem for
new developments, then synthesize findings into a structured report.

**You MUST use the fan-out/merge pattern.** Do NOT do all research in a single task.

## Workflow

### Step 1: Create parallel research subtasks

Use `buildd` action=create_task to spawn **4 independent research subtasks**.
Each subtask should have a clear, narrow scope.

```
action: create_task
params: {
  title: "SDK Research: Documentation and API changes",
  description: "Check for Claude Agent SDK documentation and API changes.\n\n1. Use WebSearch to find recent updates to the Claude Agent SDK documentation (docs.anthropic.com)\n2. Look for new or changed SDK query() options, hooks, or configuration parameters\n3. Check for deprecation notices or migration guides\n4. Review any new example code or tutorials published by Anthropic\n5. Report findings via buildd action=complete_task\n\nNote: New version/release detection is handled separately by the SDK Release Monitor schedule. Focus on documentation content changes, not version numbers.\n\nOutput: list of documentation changes with links and relevance to Buildd's SDK integration.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Trending GitHub repos using Claude Agent SDK",
  description: "Search GitHub for new and trending repositories using the Claude Agent SDK.\n\n1. Use WebSearch to find repos mentioning '@anthropic-ai/claude-agent-sdk' or 'claude-agent-sdk', sorted by recent activity or stars\n2. Focus on repos created or updated in the last 2 weeks\n3. For each interesting repo: note the name, description, star count, and what SDK features it uses\n4. Compare against known projects in .agent/sdk-ecosystem-research.md to identify NEW repos\n5. Report findings via buildd action=complete_task\n\nOutput: list of new/notable repos with SDK features used and relevance to Buildd.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Anthropic blog and docs announcements",
  description: "Check for recent Anthropic announcements relevant to the Claude Agent SDK.\n\n1. Use WebSearch to check the Anthropic blog (anthropic.com/research, anthropic.com/news) for recent posts\n2. Search for Claude Agent SDK documentation updates\n3. Check for any new API features, model releases, or SDK-adjacent tooling\n4. Note anything that affects Buildd's SDK integration (new hooks, new query options, deprecations)\n5. Report findings via buildd action=complete_task\n\nOutput: list of relevant announcements with links and impact assessment.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Community patterns and competitor analysis",
  description: "Scan for new community patterns and competitor feature changes.\n\n1. Use WebSearch to find new patterns/frameworks built on the Claude Agent SDK\n2. Check for updates to known competitors (Cursor, Codex, Windsurf, Devin) that we should be aware of\n3. Look for new MCP servers or integrations relevant to agent coordination\n4. Identify patterns from the community that Buildd could adopt\n5. Report findings via buildd action=complete_task\n\nOutput: notable patterns with applicability assessment, competitor updates.",
  priority: 5
}
```

**Collect all 4 task IDs** from the create_task responses.

### Step 2: Create the merge/verify rollup task

Create a rollup task that is **blocked by all 4 research subtasks**.
This task will auto-unblock when all subtasks complete (or fail).

```
action: create_task
params: {
  title: "SDK Research: Merge and verify weekly findings",
  description: "This is a rollup task. When you claim it, your claim response will include `childResults` with the output from all research subtasks.\n\n## Instructions\n\n1. Review all childResults from the parallel research tasks\n2. Synthesize into a unified report\n3. Compare findings against .agent/sdk-ecosystem-research.md for deltas\n4. Save any significant new observations to workspace memory via buildd_memory action=save:\n   - New SDK versions → type: 'discovery'\n   - New community patterns → type: 'pattern'\n   - Architectural insights → type: 'architecture'\n   - Non-obvious gotchas → type: 'gotcha'\n5. If .agent/sdk-ecosystem-research.md needs updating with new findings, update it\n6. Complete with a structured summary\n\n## Verification Checklist\n- [ ] All 4 research areas covered (npm, GitHub, blog, community)\n- [ ] New findings saved to workspace memory\n- [ ] .agent/sdk-ecosystem-research.md updated if needed\n- [ ] Summary includes actionable recommendations for Buildd",
  priority: 6,
  blockedByTaskIds: ["<task1_id>", "<task2_id>", "<task3_id>", "<task4_id>"]
}
```

**Replace the placeholder IDs with the actual task IDs from Step 1.**

### Step 3: Complete your orchestrator task

After creating all 5 tasks (4 research + 1 rollup), your job as orchestrator is done.
Complete your own task with a summary of what you created:

```
action: complete_task
params: {
  workerId: "<your-worker-id>",
  summary: "Created 4 parallel research subtasks and 1 merge/verify rollup task for weekly SDK ecosystem scan. Research covers: npm versions, GitHub trending, Anthropic blog, community patterns."
}
```

## Important Notes

- The orchestrator task should complete quickly (< 1 minute). All real work happens in subtasks.
- Do NOT wait for subtasks to finish. The blockedByTaskIds mechanism handles sequencing.
- Each subtask runs as an independent worker with its own context and budget.
- The rollup task receives all sibling results via `childResults` in its claim response.
- If a subtask fails, the rollup still unblocks — it should handle partial results gracefully.
