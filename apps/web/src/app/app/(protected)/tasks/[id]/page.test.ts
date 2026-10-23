import { describe, it, expect } from 'bun:test';

// Source-based, not imported/rendered: this is a server component pulling in
// the DB client, drizzle, auth-helpers, and team-access. Same rationale as
// tasks/page.test.ts's mission-budget plumbing suite — a re-derivation of the
// wiring in this test file would prove nothing about the actual page.
const pageSource = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
// The load (lib/task-view.ts) and the pick it makes (lib/task-view-pick.ts).
const taskViewSource = (await Bun.file(new URL('../../../../../lib/task-view.ts', import.meta.url)).text())
  + (await Bun.file(new URL('../../../../../lib/task-view-pick.ts', import.meta.url)).text());

describe('ship badge plumbing — tasks/[id]/page.tsx (spec §10.3)', () => {
  it('imports the single shared ship-state loader, not a local re-derivation', () => {
    expect(pageSource).toContain("import { resolveShippedRelease } from '@/lib/task-ship-state'");
  });

  it('imports TaskShipBadge — same component TaskCard mounts, not a second implementation', () => {
    expect(pageSource).toContain("import { TaskShipBadge } from '@/components/TaskShipBadge'");
  });

  it('resolves ship state for this task', () => {
    expect(pageSource).toContain('resolveShippedRelease(task.id)');
  });

  it('mounts TaskShipBadge with task.release and the resolved shippedReleaseId', () => {
    expect(pageSource).toContain('<TaskShipBadge release={task.release} shippedReleaseId={shippedRelease?.releaseId ?? null} />');
  });
});

describe('dependency blocking — tasks/[id]/page.tsx reads every dep worker', () => {
  // The gate asks whether ANY worker of a completed dep holds an open PR. Loading
  // only the newest worker hid an older worker's open PR, so the page said
  // "All dependencies resolved" while the claim gate and the list said BLOCKED.
  const depQuery = pageSource.slice(
    pageSource.indexOf('inArray(tasks.id, depTaskIds)'),
    pageSource.indexOf('// Workers for this task'),
  );

  it('the depTasks workers relation is not limited to the latest worker', () => {
    expect(depQuery.length).toBeGreaterThan(0);
    expect(depQuery).not.toMatch(/limit:\s*1\b/);
  });

  it('the Blocked banner picks the PR worker with the shared predicate, not workers[0]', () => {
    expect(pageSource).toContain('findBlockingPrWorker(');
    expect(pageSource).not.toMatch(/\(d(ep)? as any\)\.workers\?\.\[0\]/);
  });

  it('a blocking worker with a prUrl but no prNumber is still listed (generic PR link)', () => {
    // The gate blocks on prUrl alone; requiring prNumber here left the banner
    // saying "waiting on 1 dependency" with nothing listed.
    expect(pageSource).not.toMatch(/w\?\.prUrl && w\.prNumber \?/);
    expect(pageSource).toContain("w.prNumber ? `Merge PR #${w.prNumber}` : 'PR open'");
  });
});

describe('mission continuity — tasks/[id]/page.tsx (docs/design/mission-feed-mobile-continuity.md S6)', () => {
  it('loads executor and review policy with the mission relation', () => {
    expect(pageSource).toContain('executor: true, requiresReview: true, mergePolicy: true');
    expect(pageSource).toContain('missionExecutorOf(task.mission)');
  });

  it('drops the `!task.missionId` gates: a mission task shows its scoped questions', () => {
    expect(pageSource).not.toContain('!task.missionId');
    expect(pageSource).not.toContain('isNull(missionNotes.missionId)');
    expect(pageSource).toMatch(/\n\s*<TaskQuestionFeed\n/);
  });

  it('the mission links land on the task’s row (#t-), never a bare mission URL (AC-12)', () => {
    expect(pageSource).toContain("mode: 'focus'");
    expect(pageSource).not.toMatch(/href=\{`\/app\/missions\/\$\{task\.mission\.id\}`\}/);
  });

  it('puts the phase action first, through the shared TaskActionZone', () => {
    expect(pageSource).toContain("import TaskPageActionZone from './TaskPageActionZone'");
    const header = pageSource.indexOf('data-testid="task-header-status"');
    const zone = pageSource.indexOf('<TaskPageActionZone');
    const description = pageSource.indexOf('{/* Description');
    expect(header).toBeGreaterThan(0);
    expect(zone).toBeGreaterThan(header);
    expect(zone).toBeLessThan(description);
  });

  it('puts the question feed right after the action zone, before anything to read', () => {
    const zoneBlock = pageSource.indexOf('data-testid="task-page-action-zone"');
    const feed = pageSource.search(/\n\s*<TaskQuestionFeed\n/);
    const description = pageSource.indexOf('{/* Description');
    const triage = pageSource.indexOf('{/* Triage metadata');
    expect(feed).toBeGreaterThan(zoneBlock);
    expect(feed).toBeLessThan(triage);
    expect(feed).toBeLessThan(description);
  });

  it('the header is back, title, one mono sub-line and the track: no caps eyebrow, chips or error count', () => {
    const header = pageSource.slice(pageSource.indexOf('data-testid="task-header"'), pageSource.indexOf('{/* Action first'));
    expect(header).toContain('data-testid="task-subline"');
    expect(header).toContain('<Lifecycle state={headerTrack.state} phrase={headerTrack.phrase}');
    expect(header).not.toMatch(/upper[c]ase/);
    expect(header).not.toContain('task-error-count');
    expect(header).not.toContain('Created <ZonedTime');
    expect(header).not.toContain('task.category');
  });

  it('drops "Also running" (Home\'s Agents panel has it) and the bare "Next" link ("Unblocked by this" stays)', () => {
    expect(pageSource).not.toContain('AlsoRunning');
    expect(pageSource).not.toContain('nextChainTask');
    expect(pageSource).toContain('data-testid="task-unblocked"');
  });

  it('the side panel follows the main column: the hero stays the first screen on mobile', () => {
    const main = pageSource.indexOf('data-testid="task-main"');
    const worker = pageSource.indexOf('data-testid="task-active-worker"');
    const aside = pageSource.indexOf('data-testid="task-side-panel"');
    expect(main).toBeGreaterThan(0);
    expect(worker).toBeGreaterThan(main);
    expect(aside).toBeGreaterThan(worker);
    // The worker view leads the main column at every width.
    expect(pageSource).toContain('<div className="mb-8 order-first" data-testid="task-active-worker">');
  });

  it('one question, one surface: the worker view gets the linked note and the feed skips it', () => {
    // The note is linked once, in lib/task-view-pick.ts, for the page, the sheet and the board.
    expect(taskViewSource).toContain('linkQuestionNote(openQuestions, activeWorker.id)');
    expect(pageSource).toContain('const questionNote = taskView.questionNote;');
    // The live run view's props are built by lib/task-live-view.ts, for the sheet too.
    expect(pageSource).toMatch(/liveWorkerViewProps\(\{[^]*?questionNote,[^]*?\}\)/);
    expect(pageSource).toContain('excludeNoteId={questionNote?.id ?? null}');
  });

  it('passes the failed phase a truncated error excerpt to show, and the full error only to classify (and fold)', () => {
    expect(pageSource).toContain('lastError={failedExcerpt ? { excerpt: failedExcerpt, raw: taskWorkers[0]?.error ?? null } : null}');
    expect(pageSource).toContain('truncateExcerpt(taskWorkers[0]?.error');
  });

  it('moves Edit / Reassign / View Source / Delete behind ⋮ (D9: the title has room)', () => {
    expect(pageSource).toContain("import TaskOverflowMenu from './TaskOverflowMenu'");
    const menu = pageSource.slice(pageSource.indexOf('<TaskOverflowMenu'), pageSource.indexOf('</TaskOverflowMenu>'));
    expect(menu).toContain('<EditTaskButton');
    expect(menu).toContain('<ReassignButton');
    expect(menu).toContain('View Source');
    expect(menu).toContain('<DeleteTaskButton');
  });

  it('attempts never render as the Execution plan (D9)', () => {
    expect(pageSource).not.toContain('<PlanChainView');
  });

  it('does not print the deliverable twice (D9)', () => {
    expect(pageSource).toContain('descriptionDuplicatesSummary(');
  });

  it('keeps the status badge testid (AC-19)', () => {
    expect(pageSource).toContain('<span data-testid="task-header-status" data-status={displayStatus}');
  });
});

// Mobile layout (source-level: the page is a server component, see header).
describe('mobile layout — tasks/[id]/page.tsx', () => {
  it('Worker History: badge and PR link share one wrapper that wraps under the text below md', () => {
    const meta = pageSource.match(/data-testid="worker-history-meta"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(meta).toContain('pl-11 md:pl-0');
    expect(meta).toContain('<StatusPill');
    expect(meta).toContain('worker.prUrl &&');
  });

  it('outside a mission the breadcrumb is a single back link, not a second copy of the title', () => {
    const nav = pageSource.slice(pageSource.indexOf('<nav aria-label="Breadcrumb"'), pageSource.indexOf('</nav>'));
    expect(nav).toContain('data-testid="task-back"');
    expect(nav).not.toContain('displayTaskTitle');
  });
});



describe('Worker history branch — tasks/[id]/page.tsx (demo polish)', () => {
  it('shows the branch through displayBranchName with the full name in title', () => {
    expect(pageSource).toContain('title={worker.branch}');
    expect(pageSource).toContain('{displayBranchName(worker.branch)}');
  });
});

describe('a sign-in failure reads in plain words — tasks/[id]/page.tsx', () => {
  it('Worker history shows a worker error through plainWorkerError, raw text on hover', () => {
    expect(pageSource).toContain("import { plainWorkerError } from '@/lib/provider-auth-failure'");
    expect(pageSource).toContain('plainWorkerError(worker.error');
    expect(pageSource).not.toMatch(/>\{worker\.error\}</);
  });

  it('the evidence card gets the worker error, so it can tell the cause is already explained', () => {
    expect(pageSource).toContain('<TaskEvidenceCard status={task.status} result={task.result} workerError={taskWorkers[0]?.error ?? null} backend={taskBackend} failingChecks={verdict?.failingChecks ?? []} />');
  });
});

// C-5 (attempt ordering): every worker/task list the page reads is ordered by
// immutable columns with an id tiebreak, so two rows created in the same instant
// never swap between renders, and the selections derived from them (latest,
// active, PR worker, attempt numbering) never flip.
describe('deterministic attempt order — tasks/[id]/page.tsx', () => {
  it('never orders workers by createdAt without an id tiebreak', () => {
    // `(sqlOrderBy\()?`: the same ordering, before and after the relational-query move.
    expect(pageSource).not.toMatch(/orderBy:\s*(sqlOrderBy\()?desc\(workers\.createdAt\)\)?\s*[,}]/);
    expect(pageSource).not.toMatch(/orderBy:\s*(sqlOrderBy\()?\[\s*desc\(workers\.createdAt\)\s*\]/);
    const withTiebreak = pageSource.match(/orderBy:\s*(sqlOrderBy\()?\[desc\(workers\.createdAt\), desc\(workers\.id\)\]/g) ?? [];
    // Two reads here (dependencies, CI-retry attempts); the
    // task's own workers are read by lib/task-view.ts, with the same tiebreak.
    expect(withTiebreak.length).toBeGreaterThanOrEqual(2);
    expect(taskViewSource).toContain('orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)])');
  });

  it('never orders tasks by createdAt without an id tiebreak', () => {
    expect(pageSource).not.toMatch(/orderBy:\s*(sqlOrderBy\()?asc\(tasks\.createdAt\)\)?\s*[,}]/);
    expect(pageSource).toMatch(/subTasks:\s*\{\s*columns:\s*\{[^}]*\},\s*extras: ROLE_INFERRED_EXTRAS,\s*orderBy:\s*(sqlOrderBy\()?\[asc\(tasks\.createdAt\), asc\(tasks\.id\)\]/);
  });

  it('picks latest / active / PR worker from the shared comparator, not from row order', () => {
    expect(pageSource).toContain("from '@/lib/attempt-order'");
    expect(taskViewSource).toContain('selectTaskWorkers(');
    expect(pageSource).not.toMatch(/taskWorkers\.find\(w => w\.prUrl && w\.prNumber\)/);
  });

  it('numbers CI-retry attempts in task chrono order', () => {
    expect(pageSource).toContain('oldestFirst(ciAttemptRows, compareTasksChrono)');
  });
});
describe('one verdict — tasks/[id]/page.tsx (lib/task-verdict.ts)', () => {
  it('derives the verdict from the record and only applies a cached decision; it never calls the model', () => {
    expect(pageSource).toContain('deriveTaskVerdict({ ...buildVerdictInput({');
    expect(pageSource).toContain('applyVerdictDecision(rulesVerdict, storedVerdictDecision)');
    expect(pageSource).not.toMatch(/decideTaskVerdict|refreshTaskVerdict|decisionCall/);
  });

  it('the verdict block leads the main column, before the action zone', () => {
    const v = pageSource.indexOf('<TaskVerdictBlock');
    expect(v).toBeGreaterThan(pageSource.indexOf('data-testid="task-main"'));
    expect(v).toBeLessThan(pageSource.indexOf('data-testid="task-page-action-zone"'));
  });

  it('no "hiccup, already handled" row and no Done/Checks failing chips on the completed header', () => {
    expect(pageSource).not.toContain('hiccup');
    expect(pageSource).not.toMatch(/<TaskShippedTitle[^>]*status=/);
  });

  it('every captured error stays inspectable through the full-evidence list', () => {
    expect(pageSource).toContain("<TaskErrorEvidence items={errorEvidenceItems.filter(item => item.presentation !== 'unclear')}");
  });
});

// U1 audit (task 01e6293b): below md the actions row (⋯ menu) stacked above the
// title, left-aligned on a running task. Task f36e76cb: beside the title the
// actions reserved a column that wrapped a long PR title onto ~8 lines. Below
// md the title takes the full width and the actions sit right-aligned on the
// row under it (with the status pill); from md up they share the title row.
describe('task header — full-width title on a phone, actions on the title row from md', () => {
  const header = pageSource.slice(pageSource.indexOf('data-testid="task-header"'), pageSource.indexOf('data-testid="task-subline"'));
  const cls = (testid: string) => header.match(new RegExp(`data-testid="${testid}"[^>]*className=\\{?[\`"]([^\`"]*)`))?.[1] ?? '';
  it('the actions never stack above the title', () => {
    expect(header).not.toContain('flex-col-reverse');
    expect(header.indexOf('<TaskTitle')).toBeLessThan(header.indexOf('data-testid="task-header-actions"'));
  });
  it('below md the title spans both columns and the actions take row 2; md puts them back on row 1', () => {
    expect(header).toContain('className="min-w-0 col-span-2 row-start-1 md:col-span-1 md:col-start-1"');
    expect(cls('task-header-actions')).toContain('row-start-2 md:row-start-1');
    expect(cls('task-header-status')).toContain('row-start-2 self-center md:col-start-2 md:row-start-1 md:self-start');
  });
  it('with no status pill the sub-line shares the actions\' row on a phone, and its PR link is a 44px target', () => {
    const sub = pageSource.slice(pageSource.indexOf('data-testid="task-subline"'), pageSource.indexOf('{/* An attempt says what it is an attempt of'));
    expect(sub).toContain("'col-span-2 row-start-3' : 'col-start-1 row-start-2 self-center'");
    expect(sub).toContain('md:col-span-full md:col-start-1 md:row-start-2');
    expect(sub).toContain('inline-flex min-h-11 items-center gap-1 text-accent-text');
  });
  it('the actions are right-aligned, never spread', () => {
    const actions = header.slice(header.indexOf('data-testid="task-header-actions"') - 200, header.indexOf('data-testid="task-header-actions"'));
    expect(actions).not.toContain('justify-between');
  });
});

describe('one worker pick — tasks/[id]/page.tsx', () => {
  it('reads its workers and question through lib/task-view.ts and picks them with pickTaskView', async () => {
    // The page batches the same two reads with its own (lib/task-view.ts taskViewReads) and picks as loadTaskView does.
    expect(pageSource).toContain('taskViewReads(task.id)');
    expect(pageSource).toContain('loadTaskViewRecovery(task, viewer)');
    expect(pageSource).toContain('const taskView = pickTaskView({');
    expect(taskViewSource).toContain('return pickTaskView({ task, workers: workerRows ?? [], openQuestions: openQuestions ?? [], recovery });');
    // No second worker pick beside it.
    expect(pageSource).not.toContain('selectTaskWorkers(');
    expect(pageSource).not.toContain('linkQuestionNote(');
  });
});

describe('diagnostics are a layer for admins and operators — tasks/[id]/page.tsx', () => {
  it('decides the audience from the viewer role in the task team and the operator check', () => {
    expect(pageSource).toContain('canSeeDiagnostics({ role: access.role, operator: isPlatformOperator(user) })');
    expect(pageSource).toContain('<DiagnosticsAudienceProvider visible={diagnosticsVisible}>');
  });

  it('the force-start record and runner scheduling render only inside DiagnosticsDisclosure', () => {
    const forced = pageSource.slice(pageSource.indexOf('const forced = lastForceStart'), pageSource.indexOf('{/* Blocked Banner'));
    expect(forced).toContain('<DiagnosticsDisclosure');
    const details = pageSource.slice(pageSource.indexOf('Details\n'), pageSource.indexOf('</aside>'));
    const plain = details.slice(0, details.indexOf('<DiagnosticsDisclosure>'));
    expect(plain).not.toContain('Claimed by');
    expect(plain).not.toContain('runnerPreference');
    expect(details.slice(details.indexOf('<DiagnosticsDisclosure>'))).toContain('runnerPreference');
  });
});

describe('state words on the task page (terms catalog)', () => {
  it('names the release a task went out in as Released in, never Shipped in', () => {
    expect(pageSource).toContain('Released in <Link href={origin.shipped.href}');
    expect(pageSource).not.toContain('Shipped in <Link');
  });

  it('the mission budget banner names the cause, never "on hold"', () => {
    expect(pageSource).toContain('waits for more budget. Raise the mission budget to start them, or force-start this task.');
    expect(pageSource).not.toMatch(/\bon hold\b/);
  });
});

describe('navigation task hierarchy (R-7 to R-10)', () => {
  it('removes mission strip and execution-plan reads', () => {
    expect(pageSource).not.toContain('<MissionContextBar');
    expect(pageSource).not.toContain('<PlanChainView');
    expect(pageSource).not.toContain('missionContextReads(');
  });
  it('puts the live block before the timeline and includes steering there', () => {
    expect(pageSource.indexOf('data-testid="task-active-worker"')).toBeLessThan(pageSource.indexOf('<TaskTimeline'));
    const block = pageSource.slice(pageSource.indexOf('data-testid="task-active-worker"'), pageSource.indexOf('<TaskTimeline'));
    expect(block).toContain('<WorkerSteerPanel');
  });
  it('loads dependents regardless of completion, and hides unknown-effect errors', () => {
    expect(pageSource).toContain('const dependentsQuery = db.query.tasks.findMany(');
    expect(pageSource).toContain("item.presentation !== 'unclear'");
  });
});

// Spec e28018c2 R-6, R-9, AC-16: dependencies and dependents cross workspaces,
// and both lists go through the one per-viewer resolver.
describe('cross-workspace dependencies on the task page', () => {
  it('reads dependents from every workspace, not just this task\'s', () => {
    const q = pageSource.slice(pageSource.indexOf('const dependentsQuery'), pageSource.indexOf('const dependentsQuery') + 400);
    expect(q).not.toContain('eq(tasks.workspaceId');
  });
  it('resolves both lists for the viewer and renders the hidden count', () => {
    expect(pageSource).toContain('resolveDependencyHolders(reachScope, depTaskIds)');
    expect(pageSource).toContain('resolveDependencyHolders(reachScope, dependentRows.map(d => d.id))');
    expect(pageSource).toContain('blocksList(dependentRows, dependentReach)');
    expect(pageSource).toContain('data-testid="task-unblocked-hidden"');
  });
});

describe('reading width (Navigation R-21)', () => {
  it('keeps the content column at most 840px', () => {
    expect(pageSource).toMatch(/className="max-w-\[840px\] w-full" data-testid="task-content-column"/);
    expect(pageSource).not.toContain('max-w-[900px]');
  });
});
