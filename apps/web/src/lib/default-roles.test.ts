import { describe, it, expect } from 'bun:test';
import { createHash } from 'crypto';
import { DEFAULT_ROLES, defaultRoleMetadata, planDefaultRoleResync, roleContentHash } from './default-roles';
import { EXPLICIT_ROLE_SLUGS, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

describe('DEFAULT_ROLES', () => {
  const bySlug = Object.fromEntries(DEFAULT_ROLES.map(r => [r.slug, r]));

  // docs/design/role-routing.md §2: whenToUse/notFor ARE the routing prompt.
  // A role with no text is never a candidate, so every seeded role must say
  // either what it is for or, explicitly, that it is not routable.
  describe('routing text (role-routing.md §2)', () => {
    const EXCLUDED = ['reviewer', VISUAL_AUDITOR_ROLE_SLUG];

    it('every role has routing text or an explicit exclusion', () => {
      for (const role of DEFAULT_ROLES) {
        expect(role.routing).toBeDefined();
      }
    });

    it('excludes pipeline-only roles explicitly, and only those', () => {
      const disabled = DEFAULT_ROLES.filter(r => 'disabled' in r.routing).map(r => r.slug).sort();
      expect(disabled).toEqual([...EXCLUDED].sort());
    });

    it('stays within the §2 limits: whenToUse 20–300 chars, notFor ≤ 200', () => {
      for (const role of DEFAULT_ROLES) {
        if ('disabled' in role.routing) continue;
        const { whenToUse, notFor } = role.routing;
        expect(whenToUse.length).toBeGreaterThanOrEqual(20);
        expect(whenToUse.length).toBeLessThanOrEqual(300);
        if (notFor !== undefined) expect(notFor.length).toBeLessThanOrEqual(200);
      }
    });

    it('notFor names at least one neighbouring routable role', () => {
      const routable = DEFAULT_ROLES.filter(r => !('disabled' in r.routing)).map(r => r.slug);
      for (const role of DEFAULT_ROLES) {
        if ('disabled' in role.routing) continue;
        const notFor = role.routing.notFor ?? '';
        const named = routable.filter(s => s !== role.slug && notFor.includes(`(${s})`));
        expect(named.length).toBeGreaterThan(0);
      }
    });

    // Rendered as "<whenToUse> Not for: <notFor>." — a trailing period in
    // notFor would render as "..".
    it('notFor carries no trailing period', () => {
      for (const role of DEFAULT_ROLES) {
        if ('disabled' in role.routing) continue;
        expect(role.routing.notFor ?? '').not.toMatch(/\.\s*$/);
      }
    });

    it('seeds the text into metadata.routing with an updatedAt stamp', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(defaultRoleMetadata(bySlug.builder, now)).toEqual({
        routing: {
          whenToUse: (bySlug.builder.routing as { whenToUse: string }).whenToUse,
          notFor: (bySlug.builder.routing as { notFor?: string }).notFor,
          updatedAt: now.toISOString(),
        },
        defaultRoleVersion: bySlug.builder.version,
      });
      expect(defaultRoleMetadata(bySlug.reviewer, now)).toEqual({
        routing: { disabled: true, updatedAt: now.toISOString() },
        defaultRoleVersion: bySlug.reviewer.version,
      });
    });
  });

  it('seeds the full eight-role set', () => {
    expect(Object.keys(bySlug).sort()).toEqual([
      'analyst', 'builder', 'organizer', 'researcher', 'reviewer', 'spec-validator', 'visual-auditor', 'writer',
    ]);
  });

  // Visual QA is a CI workflow only (visual-qa.yml) — NOT a routable agent role.
  // 'visual-auditor' (the mission audit role, below) is a different slug and
  // must not be renamed to it. If this fails, remove the 'visual-qa' entry.
  it('does NOT seed a visual-qa role (CI-only workflow, not an agent role)', () => {
    expect(bySlug['visual-qa']).toBeUndefined();
  });

  describe('visual-auditor (mission surface audit role)', () => {
    const role = () => bySlug[VISUAL_AUDITOR_ROLE_SLUG];

    it('is seeded under the shared slug constant the claim gate routes on', () => {
      expect(role()).toBeDefined();
      expect(EXPLICIT_ROLE_SLUGS).toContain(role().slug);
    });

    it('is a separate role from the PR reviewer', () => {
      expect(role().slug).not.toBe(bySlug.reviewer.slug);
      expect(role().content).not.toBe(bySlug.reviewer.content);
    });

    it('is read-only: can look and capture, cannot edit files or delegate', () => {
      expect([...role().allowedTools].sort()).toEqual(['AskUserQuestion', 'Bash', 'Glob', 'Grep', 'Read', 'mcp__buildd__buildd']);
      for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(role().allowedTools).not.toContain(t);
      expect(role().canDelegateTo).toEqual([]);
    });

    it('prompt carries the capture recipe and the evidence contract', () => {
      const c = role().content;
      expect(c).toContain('visual-review');
      expect(c).toContain('visual-qa.yml');
      expect(c).toContain('scripts/qa/shoot.sh');
      expect(c).toContain('DATABASE_URL');
      expect(c).toContain('upload_artifact');
      expect(c).toContain('missionId');
      for (const key of ['runKey', 'route', 'viewport', 'finding', 'verdict']) expect(c).toContain(key);
      expect(c).toContain('mobile');
      expect(c).toContain('desktop');
      expect(c).toContain('[surface fix]');
      expect(c).toMatch(/never open (a )?PR/i);
    });

    // Task 8bc5b5ac: an auditor dispatched the workflow, said it would wait for a
    // background watcher, and ended its turn — the runner recorded that as
    // completion, so the evidence check rejected it for missing screenshots. The
    // prompt must tell the auditor to block on the run itself, in the same turn.
    it('prompt blocks on the dispatched run in the foreground, never ends the turn to wait for a notification', () => {
      const c = role().content;
      expect(c).toMatch(/never end your turn/i);
      expect(c).toMatch(/background watcher|notification/i);
      expect(c).toMatch(/foreground/i);
      expect(c).toContain('gh run watch');
    });

    // The fix-task title is parsed by ensureMissionSurfaceAudit
    // (surfaceFixRoute) to scope the round-2 re-check, so its shape is
    // load-bearing, not a style preference.
    it('prompt files each issue as a routed [surface fix] task in this mission', () => {
      const c = role().content;
      const act = c.slice(c.indexOf('## 4. Act on verdicts'), c.indexOf('## 5. Complete'));
      expect(act).toContain('create_task');
      expect(act).toContain('[surface fix] <route>: <finding>');
      expect(act).toContain('missionId');
      expect(act).toMatch(/route pattern/i);
      expect(act).toContain('fixTaskId');
      expect(act).toMatch(/one fix task per (distinct )?defect/i);
      expect(act).toMatch(/does not block/i);
    });

    // visual-qa-human-review.md, "Auditor prompt": the review queue is the
    // question, and the artifact PATCH now merges metadata.qa.
    it('prompt posts no note for unsure: the human review queue asks instead', () => {
      const c = role().content;
      const act = c.slice(c.indexOf('## 4. Act on verdicts'), c.indexOf('## 5. Complete'));
      const unsure = act.slice(act.indexOf('- **unsure**'));
      expect(unsure).toMatch(/review queue/i);
      expect(unsure).toMatch(/do not\s+`?post_note`?/i);
      expect(c).not.toMatch(/unsure[^\n]*post_note`? with `type: 'question'`/);
    });

    it('prompt sends only { qa: { fixTaskId } } in update_artifact, which the server merges', () => {
      const act = role().content.slice(role().content.indexOf('## 4. Act on verdicts'));
      expect(act).toContain('update_artifact');
      expect(act).toMatch(/metadata: \{ qa: \{ fixTaskId/);
      expect(act).toMatch(/only/i);
      expect(act).toMatch(/merges/i);
    });

    it('prompt explains re-check rounds, human rounds, and prior-finding resolution', () => {
      const c = role().content;
      expect(c).toMatch(/round 2/i);
      expect(c).toMatch(/at most 2 automatic rounds/i);
      expect(c).toMatch(/human/i);
      expect(c).toContain('Resolved:');
      expect(c).toContain('Still there:');
      expect(c).toMatch(/do not (open|create) (another|a new) (\[surface audit\]|audit)/i);
    });

    it('bumps the role version for the prompt change, and knows the v1 content so an unedited row can be re-synced', () => {
      expect(role().version).toBeGreaterThanOrEqual(2);
      expect(role().supersededContentHashes.length).toBeGreaterThan(0);
      expect(role().supersededContentHashes).not.toContain(roleContentHash(role().content));
    });

    // post_note is non-blocking: the session would end, the runner's fallback
    // completion would hit the visual_evidence 400, and the worker would be
    // recorded failed (output_unmet). AskUserQuestion is what the runner parks
    // as waiting_input, which keeps the task open and the mission held.
    it('prompt parks a boot failure with AskUserQuestion, never a failed task or a note', () => {
      const c = role().content;
      const boot = c.slice(c.indexOf('## Boot failure'), c.indexOf('## Pull Gates'));
      expect(boot).toMatch(/did not\s+boot/i);
      expect(boot).toContain('AskUserQuestion');
      expect(boot).toContain('waiting_input');
      expect(boot).toMatch(/do not (mark|fail|complete)/i);
      expect(boot).toMatch(/do not use\s+`post_note`/i);
    });

    // The mission page's Visual review turns "blocked" by matching this
    // question prefix on the parked worker (auditBootFailed).
    it('prompt asks the exact boot-failure question the Visual review step detects', async () => {
      const { BOOT_FAILURE_QUESTION_PREFIX } = await import('./mission-visual-review');
      const c = role().content.replace(/\s+/g, ' ');
      expect(c).toContain(`question "${BOOT_FAILURE_QUESTION_PREFIX}:`);
    });
  });

  describe('planDefaultRoleResync (a role version bump reaches existing teams)', () => {
    const auditor = bySlug[VISUAL_AUDITOR_ROLE_SLUG];
    const v1Hash = auditor.supersededContentHashes[0];
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'row-1', slug: auditor.slug, source: 'system', contentHash: v1Hash, metadata: { defaultRoleVersion: 1 }, ...over,
    });

    it('updates an unedited system row still on an older version', () => {
      const plan = planDefaultRoleResync([row()]);
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ id: 'row-1', slug: auditor.slug, version: auditor.version });
      expect(plan[0].content).toBe(auditor.content);
      expect(plan[0].contentHash).toBe(createHash('sha256').update(auditor.content).digest('hex'));
    });

    it('treats a row with no version stamp as version 1', () => {
      expect(planDefaultRoleResync([row({ metadata: {} })])).toHaveLength(1);
    });

    it('never overwrites a row a team edited, one already current, or a non-system row', () => {
      expect(planDefaultRoleResync([row({ contentHash: 'edited' })])).toEqual([]);
      expect(planDefaultRoleResync([row({ metadata: { defaultRoleVersion: auditor.version } })])).toEqual([]);
      expect(planDefaultRoleResync([row({ source: 'user' })])).toEqual([]);
      expect(planDefaultRoleResync([row({ slug: 'custom-role' })])).toEqual([]);
    });
  });

  it('Organizer defaults to Sonnet (router upshifts to Opus for complex coordination)', () => {
    expect(bySlug.organizer.model).toBe('sonnet');
  });

  it('Builder defaults to Opus (router downshifts via complexity)', () => {
    expect(bySlug.builder.model).toBe('opus');
  });

  it('Researcher / Writer / Analyst default to Sonnet', () => {
    expect(bySlug.researcher.model).toBe('sonnet');
    expect(bySlug.writer.model).toBe('sonnet');
    expect(bySlug.analyst.model).toBe('sonnet');
  });

  describe('Analyst analytics consumer tools', () => {
    const role = () => bySlug.analyst;

    it('uses grouped analytics and lifecycle tools with knowledge tools', () => {
      for (const tool of ['mcp__buildd__buildd_analytics', 'mcp__buildd__buildd_work', 'mcp__buildd__recall', 'mcp__buildd__learn']) {
        expect(role().allowedTools).toContain(tool);
      }
      expect(role().allowedTools).not.toContain('mcp__buildd__buildd');
      expect(bySlug.builder.allowedTools).not.toContain('mcp__buildd__buildd_analytics');
    });

    it('documents aggregate metrics and narrower detail access', () => {
      expect(role().content).toContain('get_manifest_coverage');
      expect(role().content).toContain('get_path_claim_stats');
      expect(role().content).toContain('family: "gate"');
      expect(role().content).toContain('analytics:read');
      expect(role().content).toMatch(/per-user/i);
      expect(role().content).toContain('cost detail');
    });

    it('resyncs the previous unedited analyst prompt', () => {
      expect(role().version).toBeGreaterThanOrEqual(2);
      expect(role().supersededContentHashes).toHaveLength(1);
      expect(planDefaultRoleResync([{
        id: 'analyst-row', slug: 'analyst', source: 'system',
        contentHash: role().supersededContentHashes[0], metadata: { defaultRoleVersion: 1 },
      }])).toHaveLength(1);
    });
  });

  it('no role defaults to `inherit` — model must be explicit for routing', () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.model).not.toBe('inherit');
    }
  });

  it('Organizer can delegate to all execution roles', () => {
    const delegates = bySlug.organizer.canDelegateTo;
    for (const slug of ['builder', 'researcher', 'writer', 'analyst']) {
      expect(delegates).toContain(slug);
    }
  });

  it('every role has unique slug, name, description, and prompt content', () => {
    const slugs = new Set(DEFAULT_ROLES.map(r => r.slug));
    expect(slugs.size).toBe(DEFAULT_ROLES.length);
    for (const role of DEFAULT_ROLES) {
      expect(role.name.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(0);
      expect(role.content.length).toBeGreaterThan(20);
    }
  });

  it('Builder prompt uses recall (not buildd_memory query_knowledge) for pull gates', () => {
    const c = bySlug.builder.content;
    // Migrated from buildd_memory query_knowledge → recall
    expect(c).toContain('recall');
    // Must gate on both memory (error diagnosis) and code (before editing)
    expect(c).toContain('scope=code');
  });

  it('Organizer prompt uses recall for spec and memory pull gates', () => {
    const c = bySlug.organizer.content;
    // Migrated from buildd_memory query_knowledge → recall
    expect(c).toContain('recall');
    expect(c).toContain('scope=spec');
  });

  it('every role prompt includes a recall-based save-dedup gate', () => {
    for (const role of DEFAULT_ROLES) {
      // Every role must gate memory saves with a prior recall dedup check
      expect(role.content).toContain('recall');
    }
  });
  // The Organizer prompt used to order the agent to "Always set `kind` and
  // `complexity` — they drive how much Claude-horsepower the task gets". Neither
  // half was true: plan approval (approve-plan.ts) does not copy those fields
  // onto the task row, so they change nothing about routing on that path.
  it('Organizer prompt does not claim plan-level kind/complexity drive model choice', () => {
    const c = bySlug.organizer.content;
    expect(c).not.toContain('Always set `kind` and `complexity`');
    expect(c).not.toContain('how much Claude-horsepower the task gets');
  });

  // The seeded prompt is what every organizer plans against, so a stale branch
  // model here means organizers keep planning for a shape the machinery does not
  // implement. Two shapes exist: per-task PRs into trunk (the default), and
  // per-task PRs based on the mission integration branch when the mission opts in.
  // "ONE task = ONE branch = ONE PR" is true in both — what changes is the base.
  describe('Organizer sequencing rules', () => {
    const c = () => bySlug.organizer.content;

    it('keeps ONE task = ONE branch = ONE PR and says the base is what varies', () => {
      expect(c()).toContain('ONE task = ONE branch = ONE PR');
      // NOT /base/ — the word appears in the `baseBranch` field list above this
      // section, so that assertion stayed green with the whole section deleted.
      // Match a phrase only the rewritten section contains.
      expect(c()).toMatch(/the platform picks the base, not you/);
      // The clause must not read as a prohibition on the integration branch.
      expect(c()).not.toContain('Never fan out parallel tasks that touch the same files.');
    });

    it('names the mission integration branch and the single mission PR', () => {
      expect(c()).toContain('mission/<slug>-<id8>');
      expect(c()).toContain('integration branch');
      // One PR from the integration branch into trunk — not one PR standing in
      // for the mission's task PRs.
      expect(c()).toMatch(/\*{0,2}one\*{0,2} PR from the integration branch/i);
    });

    it('states that the integration branch is opt-in and off by default', () => {
      expect(c()).toMatch(/opt-in/i);
      expect(c()).toMatch(/off by default|unless the mission has explicitly opted in/i);
    });

    it('makes path overlap the reason to chain, in both shapes', () => {
      expect(c()).toContain('Serialize on path overlap');
      expect(c()).toContain('in both shapes');
      // Blanket "same repo => chain" survives only as the non-opted-in rule.
      expect(c()).toMatch(/Without an integration branch, tasks on the \*\*same repo\*\* MUST be chained/);
    });

    it('keeps DONE = MERGED and scopes "merged" to the integration branch when there is one', () => {
      expect(c()).toContain('DONE = MERGED');
      expect(c()).toContain('cannot be claimed until the upstream PR is actually merged');
      expect(c()).toMatch(/merged into the integration branch/);
    });

    it('does not claim mission tasks share a branch or a single PR', () => {
      // The false Option-A assertion the mission-delivery audit found in five
      // artifacts. Tasks never shared a branch, and under the integration-branch
      // shape that branch is their shared *base*, not their shared head.
      expect(c()).not.toMatch(/share (one|a single|the same) branch/i);
      expect(c()).not.toMatch(/push (commits )?to (one|the same|a shared) branch/i);
    });

    it('does not promise parallelism the platform will not deliver', () => {
      // A plan step cannot declare its file scope (`PlanStep` has no
      // `pathManifest` and approve-plan sets none), so claim time serializes
      // same-mission siblings whatever the plan says. The prompt used to tell
      // the organizer that disjoint-path steps run in parallel, which made it
      // drop `dependsOn` and buy nothing but lost ordering.
      expect(c()).not.toMatch(/run in parallel in the same repo/);
      expect(c()).toMatch(/shorter wait per link/);
    });

    it('keeps the example plan valid JSON and consistent with the rules', () => {
      const block = c().match(/Example plan for a code mission[^\n]*\n```json\n([\s\S]*?)```/);
      expect(block).not.toBeNull();
      const plan = JSON.parse(block![1]) as Array<Record<string, unknown>>;
      expect(plan).toHaveLength(2);
      expect(plan[0].dependsOn).toBeUndefined();
      // Same-repo chain: the default (trunk-based) shape's rule.
      expect(plan[1].dependsOn).toEqual(['step-1']);
      expect(plan[1].baseBranch).toBe('step-1');
      for (const step of plan) {
        expect(typeof step.ref).toBe('string');
        expect(step.outputRequirement).toBe('pr_required');
        // Every plan step carries a 2–4 word display label.
        const words = String(step.label ?? '').trim().split(/\s+/).filter(Boolean);
        expect(words.length).toBeGreaterThanOrEqual(2);
        expect(words.length).toBeLessThanOrEqual(4);
      }
    });

    it('asks for a short 2–4 word label on every plan step', () => {
      expect(c()).toMatch(/`label` — .*2–4 word/);
    });
  });

  describe('Reviewer escalation doctrine', () => {
    const c = () => bySlug.reviewer.content;

    it('does not hardcode the retired schema.ts path rule', () => {
      expect(c()).not.toContain('drizzle/*.sql, packages/core/db/schema.ts');
      expect(c()).not.toContain('Do NOT approve a PR that touches the DB schema. Escalate it.');
    });

    it('defers schema/migration risk to the mechanical policy verdict, not reviewer discretion', () => {
      expect(c()).toMatch(/mechanical/);
      expect(c()).toMatch(/no generated migration is not a schema change/);
    });

    it('splits security findings into a request-changes branch and an escalate branch', () => {
      // Escalate branch: the fix itself is the open question.
      expect(c()).toMatch(/auth\/authz boundary/);
      expect(c()).toMatch(/cannot name a concrete fix/);
      // Request-changes branch: fix and tests are nameable.
      expect(c()).toContain('REQUEST CHANGES (do NOT escalate) when you find a security-shaped defect');
      expect(c()).toMatch(/can name the\s+concrete fix/);
      expect(c()).toMatch(/can name the regression test/);
      // No longer a single unconditional line.
      expect(c()).not.toContain('You detect a possible security issue');
    });

    it('never lets either security branch merge without review', () => {
      expect(c()).toMatch(/Both paths block the merge/);
    });

    it('does not claim the reviewer receives the diff, and points it at the base branch', () => {
      // The prompt carries a file list (and the patch only when a workspace
      // opts in), so "you receive the diff" sent reviewers to rebuild it
      // against whatever branch they guessed.
      expect(c()).not.toMatch(/^- The PR diff$/m);
      expect(c()).toMatch(/base branch/i);
      expect(c()).toMatch(/Reading the Diff/);
      expect(c()).toMatch(/never assume `main`/i);
    });
  });

  it('Organizer prompt names roleSlug as the real routing lever and documents tier', () => {
    const c = bySlug.organizer.content;
    // roleSlug is what actually selects a model for a planned task.
    expect(c).toMatch(/`roleSlug`[^\n]*model/);
    // tier is the working override on the direct-creation surface.
    expect(c).toContain('`tier`');
    expect(c).toContain('premium');
    expect(c).toContain('budget');
  });
});
