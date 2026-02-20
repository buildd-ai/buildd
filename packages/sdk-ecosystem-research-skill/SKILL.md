---
name: sdk-ecosystem-research
description: Weekly SDK ecosystem research using fan-out pattern — spawns parallel research subtasks, merges results, and verifies output quality
---

# SDK Ecosystem Research — Fan-out Skill

You are a research orchestrator. Your job is to scan the Claude Agent SDK ecosystem for
new developments, then synthesize findings into a structured report.

**You MUST use the fan-out/merge pattern.** Do NOT do all research in a single task.

## Deduplication Protocol

Every subtask MUST gate on prior findings to avoid reporting the same things week after week:

1. **Search workspace memory first**: `buildd_memory action=search` with relevant concepts before doing any web research
2. **Read `.agent/sdk-ecosystem-research.md`**: This file contains all known projects, patterns, and SDK features already tracked
3. **Only report NEW findings**: Skip anything already covered in memory or the research file
4. **Tag outputs clearly**: Prefix findings with `[NEW]` or `[UPDATED]` so the rollup can distinguish

## Workflow

### Step 1: Create parallel research subtasks

Use `buildd` action=create_task to spawn **4 independent research subtasks**.
Each subtask should have a clear, narrow scope.

```
action: create_task
params: {
  title: "SDK Research: Documentation and API changes",
  description: "Check for Claude Agent SDK documentation and API changes.\n\n## Dedup: Before researching, run these steps:\n1. `buildd_memory action=search params={concepts: [\"sdk-docs\", \"sdk-api\", \"sdk-changelog\"], limit: 10}` — review what's already known\n2. Read `.agent/sdk-ecosystem-research.md` section 'SDK Features We Don't Yet Use' for current baseline\n3. Only report changes NOT already covered\n\n## Research:\n1. Use WebSearch to find recent updates to the Claude Agent SDK documentation (docs.anthropic.com)\n2. Look for new or changed SDK query() options, hooks, or configuration parameters\n3. Check for deprecation notices or migration guides\n4. Review any new example code or tutorials published by Anthropic\n\nNote: New version/release detection is handled separately by the SDK Release Monitor schedule. Focus on documentation content changes, not version numbers.\n\nOutput: list of [NEW] documentation changes with links and relevance to Buildd's SDK integration. If nothing new, say 'No new findings' and complete.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Trending GitHub repos using Claude Agent SDK",
  description: "Search GitHub for new and trending repositories using the Claude Agent SDK.\n\n## Dedup: Before researching, run these steps:\n1. `buildd_memory action=search params={concepts: [\"sdk-community\", \"sdk-repos\", \"agent-framework\"], limit: 10}` — review repos already known\n2. Read `.agent/sdk-ecosystem-research.md` section 'Community Projects Using the SDK' for the current list of tracked projects\n3. Only report repos NOT already listed there\n\n## Research:\n1. Use WebSearch to find repos mentioning '@anthropic-ai/claude-agent-sdk' or 'claude-agent-sdk', sorted by recent activity or stars\n2. Focus on repos created or updated in the last 2 weeks\n3. For each NEW repo: note the name, description, star count, and what SDK features it uses\n4. For KNOWN repos: only report if there are significant updates (major version, new features)\n\nOutput: list of [NEW] or [UPDATED] repos with SDK features used and relevance to Buildd. If nothing new, say 'No new findings' and complete.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Anthropic blog and docs announcements",
  description: "Check for recent Anthropic announcements relevant to the Claude Agent SDK.\n\n## Dedup: Before researching, run these steps:\n1. `buildd_memory action=search params={concepts: [\"anthropic-blog\", \"sdk-announcement\", \"model-release\"], limit: 10}` — review announcements already processed\n2. Read `.agent/sdk-ecosystem-research.md` for context on what Buildd already knows\n3. Only report announcements NOT already covered in memory\n\n## Research:\n1. Use WebSearch to check the Anthropic blog (anthropic.com/research, anthropic.com/news) for recent posts (last 2 weeks)\n2. Check for any new API features, model releases, or SDK-adjacent tooling\n3. Note anything that affects Buildd's SDK integration (new hooks, new query options, deprecations)\n\nOutput: list of [NEW] announcements with links and impact assessment. If nothing new, say 'No new findings' and complete.",
  priority: 5
}
```

```
action: create_task
params: {
  title: "SDK Research: Community patterns and competitor analysis",
  description: "Scan for new community patterns and competitor feature changes.\n\n## Dedup: Before researching, run these steps:\n1. `buildd_memory action=search params={concepts: [\"competitor\", \"community-pattern\", \"mcp-integration\"], limit: 10}` — review patterns already tracked\n2. Read `.agent/sdk-ecosystem-research.md` section 'Patterns From the Community Worth Adopting' for current baseline\n3. Only report patterns or competitor changes NOT already covered\n\n## Research:\n1. Use WebSearch to find new patterns/frameworks built on the Claude Agent SDK (last 2 weeks)\n2. Check for updates to known competitors (Cursor, Codex, Windsurf, Devin) that we should be aware of\n3. Look for new MCP servers or integrations relevant to agent coordination\n4. Identify patterns from the community that Buildd could adopt\n\nOutput: list of [NEW] patterns with applicability assessment, [NEW] competitor updates. If nothing new, say 'No new findings' and complete.",
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
  description: "This is a rollup task. When you claim it, your claim response will include `childResults` with the output from all research subtasks.\n\n## Instructions\n\n1. Review all childResults from the parallel research tasks\n2. Filter out any 'No new findings' results — these areas had no delta this week\n3. For remaining findings, synthesize into a unified report\n4. Save each NEW finding to workspace memory via buildd_memory action=save:\n   - New SDK docs/API changes → type: 'discovery', concepts: ['sdk-docs', 'sdk-api']\n   - New community repos → type: 'discovery', concepts: ['sdk-community', 'sdk-repos']\n   - New Anthropic announcements → type: 'discovery', concepts: ['anthropic-blog', 'sdk-announcement']\n   - New community patterns → type: 'pattern', concepts: ['community-pattern']\n   - Competitor updates → type: 'discovery', concepts: ['competitor']\n5. Update `.agent/sdk-ecosystem-research.md` with new findings — add to the appropriate section\n6. Commit and push the updated file so future runs see the delta\n7. Complete with a structured summary\n\n## Verification Checklist\n- [ ] All 4 research areas checked (some may have no new findings — that's fine)\n- [ ] Each NEW finding saved to workspace memory with proper concepts tags\n- [ ] .agent/sdk-ecosystem-research.md updated and committed\n- [ ] Summary includes only genuinely new actionable recommendations",
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
  summary: "Created 4 parallel research subtasks and 1 merge/verify rollup task for weekly SDK ecosystem scan. Research covers: docs/API changes, GitHub trending, Anthropic blog, community patterns."
}
```

## Important Notes

- The orchestrator task should complete quickly (< 1 minute). All real work happens in subtasks.
- Do NOT wait for subtasks to finish. The blockedByTaskIds mechanism handles sequencing.
- Each subtask runs as an independent worker with its own context and budget.
- The rollup task receives all sibling results via `childResults` in its claim response.
- If a subtask fails, the rollup still unblocks — it should handle partial results gracefully.
- Release/version monitoring is handled by the separate SDK Release Monitor schedule (every 6hrs). Do NOT duplicate that work here.
- Subtasks finding nothing new should complete quickly with "No new findings" — this is expected and healthy.
