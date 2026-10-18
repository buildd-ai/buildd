import { describe, expect, it } from 'bun:test';
import { COPY_RULES, copyViolations, settingsDescriptionProblems } from '../packages/core/copy-rules';
import { extractCopy, extractNotifyCopy, findRegressions, inScope, parseBaseline, readSources, scanSources, serializeBaseline, updatedBaseline, vocabularyInScope } from './copy-check';

const OLD = 'apps/web/src/app/app/(protected)/settings/old.tsx';
const NEW = 'apps/web/src/app/app/(protected)/settings/new.tsx';
const ids = (t: string) => copyViolations(t).map((r) => r.id);

describe('copy rules', () => {
  it('every rule flags its own bad example and passes its good one', () => {
    for (const rule of COPY_RULES) {
      if (rule.fileLevel) continue;
      expect(rule.test(rule.bad.replace(/\s+/g, ' '))).toBe(true);
      expect(rule.test(rule.good)).toBe(false);
    }
  });

  it('flags "not this, it\'s that": the owner\'s Models card, verbatim', () => {
    // Settings > Models, Claude subscription card (owner, 2026-10-09: "ai slopfest").
    expect(ids("Not chat: A subscription seat signs in a runner; buildd’s server never spends a seat.")).toContain('not-this-its-that');
    expect(ids('Not codex runs: A Claude subscription signs in Claude Code; the Codex CLI cannot use it.')).toContain('not-this-its-that');
    expect(ids('Not cloud runs: Cloud containers never receive a seat; only an owner seat set on your own Cloudflare Worker can.')).toContain('not-this-its-that');
    expect(ids('Not codex runs: The Codex CLI speaks the OpenAI wire; this provider does not serve it.')).toContain('not-this-its-that');
    // The contrast form of the same habit.
    expect(ids('Endpoint runs are metered on its key, not a Claude seat.')).toContain('not-this-its-that');
  });

  it('flags internal words in end-user copy', () => {
    expect(ids('Not codex runs: The Codex CLI speaks the OpenAI wire; this provider does not serve it.')).toContain('internal-jargon');
    expect(ids('Serves Chat · claude runs · cloud runs')).toContain('internal-jargon');
    expect(ids('Cloud containers never receive a seat.')).toContain('internal-jargon');
  });

  it('flags a warning shown where a default would do', () => {
    expect(ids('No policy chosen: agents use team keys.')).toContain('warning-instead-of-default');
    expect(ids('Pick one to apply it to agent runs.')).toContain('warning-instead-of-default');
  });

  it('flags a key or token that pays or spends: the Settings › Keys line, verbatim', () => {
    // Settings index, Keys description (owner, 2026-10-12: "Keys don't pay").
    expect(ids('Your own model keys, used when the team lets personal keys pay.')).toContain('object-pays');
    expect(ids('Your own model keys. The team decides whether they pay for your work.')).not.toContain('object-pays');
    expect(ids('Decision calls made for you spend it.')).toEqual([]);
    expect(ids('Personal keys pay for chat.')).toContain('object-pays');
    expect(ids('The team token spends credits on every call.')).toContain('object-pays');
  });

  it('leaves who is billed alone, and the word "used"', () => {
    for (const t of ['Manage your personal API keys.', 'Billed to your provider account.', 'Who pays', 'Used for chat and Claude agents.', 'Your team pays for agent work.']) {
      expect(ids(t)).toEqual([]);
    }
  });

  it('leaves the rewritten Models copy alone', () => {
    for (const t of ['Keys and subscriptions your agents and chat use.', 'Who pays', 'Team key', "Everyone uses the team's key.", "Mine, then the team's", "Uses your key when you've added one.", 'Mine only', 'You need your own key to start work.', 'Used for chat and Claude agents.', 'Used by Claude agents on your runners.', 'Not set', 'Working', 'Not used by anything']) {
      expect(ids(t)).toEqual([]);
    }
  });

  it('flags descriptions that condition a setting on team policy', () => {
    for (const t of ['Your own model keys, used when the team lets personal keys pay.', 'Used if the admins allow it.', 'Applies unless the team requires SSO.', 'The team decides which models run.']) {
      expect(ids(t)).toContain('conditional-policy');
    }
    for (const t of ['Manage your personal API keys.', 'Managed by your team admins.', 'Team members can edit this.', 'Requires a linked GitHub repository.']) {
      expect(ids(t)).not.toContain('conditional-policy');
    }
  });

  it('flags trailing filler and em dashes', () => {
    for (const t of ['Manage repositories, delivery settings, etc.', 'Manage keys and more.', 'Alerts, tokens and so on.']) expect(ids(t)).toContain('trailing-filler');
    for (const t of ['Manage runner tokens and the cloud runner.', 'Add more runners.']) expect(ids(t)).not.toContain('trailing-filler');
    expect(ids('Runners \u2014 tokens and cloud.')).toContain('em-dash');
    expect(ids('Runners: tokens and cloud.')).not.toContain('em-dash');
  });

  it('flags "Failed to" and a bare "Something went wrong"', () => {
    for (const t of ['Failed to save', 'Failed to update mission', 'Something went wrong', 'Something went wrong.']) expect(ids(t)).toContain('failed-to');
    for (const t of ['Could not save the mission. Try again.', 'Something went wrong loading this page.']) expect(ids(t)).not.toContain('failed-to');
  });

  it('flags a shouting tag: two or more ALL-CAPS words in a row', () => {
    for (const t of ['PR #N: BASE REWRITTEN · cherry-pick?', 'BUILD FAILED on dev', 'Status: NOT SHIPPED', 'MISSION PR · NOT OPENED']) {
      expect(ids(t)).toContain('shouting-tag');
    }
  });

  it('leaves acronyms alone: PR, CI, API, URL and friends', () => {
    for (const t of ['PR CI is red.', 'Set the API URL first.', 'CI API PR URL', 'Open the PR on GitHub.', 'Resets at 14:00 UTC.', 'A newer PR replaces this one. Close it?', 'Prod has NOT shipped.', 'Paste the MCP URL.', 'GET, OPTIONS']) {
      expect(ids(t)).not.toContain('shouting-tag');
    }
  });

  it('holds a Settings description to one short fact', () => {
  expect(settingsDescriptionProblems('Manage your personal API keys.')).toEqual([]);
  expect(settingsDescriptionProblems('Configure team agents, models and tools.')).toEqual([]);
  expect(settingsDescriptionProblems('Manage keys. They are used for chat.')).toContain('more-than-one-sentence');
  expect(settingsDescriptionProblems('Manage keys')).toContain('missing-full-stop');
  expect(settingsDescriptionProblems('Manage the plan, monitor spending, set daily limits, review invoices, export usage and update billing contacts.')).toContain('too-long');
  expect(settingsDescriptionProblems('Your own model keys, used when the team lets personal keys pay.')).toEqual(expect.arrayContaining(['conditional-policy', 'object-pays']));
});

  it('counts an explanation rendered twice in one file', () => {
    const tsx = `export const A = () => <div><p>Uses your team key for every agent you start.</p><details><p>Uses your team key for every agent you start.</p></details></div>;`;
    const { counts } = scanSources([{ path: NEW, content: tsx }]);
    expect(counts['duplicate-explanation'][NEW]).toBe(1);
    const once = `export const A = () => <p>Uses your team key for every agent you start.</p>;`;
    expect(scanSources([{ path: NEW, content: once }]).counts['duplicate-explanation'][NEW]).toBeUndefined();
  });

  it('flags the copy that started this: storage explaining itself', () => {
    expect(ids('No bucket of your own yet. Evidence goes to buildd\'s managed bucket and is kept 30 days.')).toEqual(['empty-yet', 'of-your-own']);
    expect(ids('Where run evidence is kept: failing command output, test reports, CI logs and transcripts.')).toEqual(['self-description']);
    expect(ids('Recommended. Nothing to paste, nothing to go stale.')).toEqual(['reassurance']);
    expect(ids('Codex disabled. Those jobs now run on Claude. Re-enable any time; per-workspace settings are unchanged.')).toEqual(['reassurance']);
    expect(ids('Stored encrypted. Nobody can read it back.')).toEqual(['reassurance']);
  });

  it('leaves plain labels, facts and errors alone', () => {
    for (const t of ['Where it runs', 'This page failed to render', 'No workspaces.', 'Encrypted, never sent to runners.', 'Approve in the browser, then paste the code.']) {
      expect(ids(t)).toEqual([]);
    }
  });
});

describe('state-jargon', () => {
  it('flags internal state words used as state', () => {
    for (const t of ['Held for review', 'Merge is held until CI passes', 'Armed', 'Disarm the gate', 'Force override enabled', 'Task claimed by a runner', 'Next poll in 30s', 'Last heartbeat 2m ago', 'Lease expires soon', 'Status: waiting_input']) {
      expect(ids(t)).toContain('state-jargon');
    }
  });

  it('leaves the plain-English senses alone', () => {
    for (const t of ['Press and hold to see before', 'Agents hold no extra access.', 'Enter the code shown in your terminal', 'Merges are not held.', 'Hold on to your changes']) {
      expect(ids(t)).not.toContain('state-jargon');
    }
  });

  it('skips operator paths by path, not through the baseline', () => {
    const src = (path: string) => scanSources([{ path, content: "export const x = 'Last heartbeat 2m ago';" }]).counts['state-jargon'][path];
    expect(src('apps/web/src/app/app/(protected)/health/HealthClient.tsx')).toBeUndefined();
    expect(src('apps/web/src/app/app/(protected)/tasks/Row.tsx')).toBe(1);
  });
});

describe('extractCopy', () => {
  it('does not count sql tagged templates as copy', () => {
    const src = "const q = sql`(${tasks.context}->>'prNumber') IN (${sql.join(ids, sql`, `)})`;\nconst t = sql<number>`count(*) filter (where status = 'a b')`;";
    expect(extractCopy('apps/web/src/app/app/(protected)/home/page.tsx', src)).toEqual([]);
  });

  it('serializeBaseline emits each rule once', () => {
    const out = serializeBaseline(parseBaseline(serializeBaseline(Object.fromEntries(COPY_RULES.map((r) => [r.id, {}])) as never)));
    for (const r of COPY_RULES) expect(out.split(`"${r.id}":`).length - 1).toBe(1);
  });

  it('reads a JSX sentence whole, nested markup and expressions included', () => {
    const src = 'export const A = () => <p>No bucket <strong>of your own</strong> for {name} yet.</p>;';
    expect(extractCopy(NEW, src).map((s) => s.text)).toEqual(['No bucket of your own for N yet.']);
  });

  it('reads string and template literals in props and toasts', () => {
    const src = [
      'const a = <Field hint="Nothing to configure here." />;',
      'setMsg({ text: `Saved for ${n} teams. Nobody can read it back.` });',
    ].join('\n');
    expect(extractCopy(NEW, src)).toEqual([
      { line: 1, text: 'Nothing to configure here.' },
      { line: 2, text: 'Saved for N teams. Nobody can read it back.' },
    ]);
  });

  it('never reads comments, imports, class lists, hrefs, console output or sql templates', () => {
    const src = [
      "import x from 'no bucket of your own yet';",
      '// No bucket of your own yet.',
      'const c = <div className="px-4 py-2 text-text-muted" href="/app/settings/storage" />;',
      "console.error('No bucket of your own yet.');",
      "const q = sql`${col} IS NOT NULL AND status NOT IN ('closed')`;",
    ].join('\n');
    expect(extractCopy(NEW, src)).toEqual([]);
  });

  it('scopes to rendered app code: no API routes, tests or dev fixtures', () => {
    expect(inScope('apps/web/src/components/settings/ProviderKeyCard.tsx')).toBe(true);
    expect(inScope('apps/web/src/app/api/workers/route.ts')).toBe(false);
    expect(inScope('apps/web/src/app/app/(protected)/settings/Foo.dom.test.tsx')).toBe(false);
    expect(inScope('apps/web/src/app/app/dev/chat/chat-fixtures.ts')).toBe(false);
  });

  it('scans a lib/ module only when it carries the @ui-copy marker', () => {
    const lib = 'apps/web/src/lib/mission-portfolio.ts';
    expect(inScope(lib)).toBe(false);
    expect(inScope(lib, "export const prompt = 'You are an agent. Nothing to configure.';")).toBe(false);
    expect(inScope(lib, "// @ui-copy: rendered on the Missions page\nexport const x = 1;")).toBe(true);
    expect(inScope(lib, "/**\n * @ui-copy\n */\nexport const x = 1;")).toBe(true);
    expect(inScope('apps/web/src/lib/mission-portfolio.test.ts', '// @ui-copy')).toBe(false);
    const marked = "// @ui-copy\nexport const hint = 'Nothing to configure here.';";
    expect(scanSources([{ path: lib, content: marked }]).counts.reassurance[lib]).toBe(1);
    expect(scanSources([{ path: lib, content: marked.replace('// @ui-copy\n', '') }]).counts.reassurance[lib]).toBeUndefined();
  });

  it('the tree has tagged lib/ copy modules, and readSources picks them up', () => {
    const libs = readSources().filter((s) => s.path.startsWith('apps/web/src/lib/'));
    expect(libs.map((s) => s.path)).toContain('apps/web/src/lib/mission-portfolio.ts');
    expect(libs.every((s) => s.content.includes('@ui-copy') || s.content.includes('notifyTeamOf(') || vocabularyInScope(s.path))).toBe(true);
  });
});

describe('vocabulary surfaces (catalog-word)', () => {
  const TOP = 'apps/runner/src/top/state.ts';
  const KERNEL = 'packages/workflow-kernel/src/delivery-display.ts';

  it('reads top, runner CLI output, MCP replies, the kernel display table and PR comments', () => {
    for (const p of [TOP, 'apps/runner/src/runner-hold.ts', 'apps/runner/src/claim-words.ts', 'packages/core/mcp-tools.ts', KERNEL, 'apps/web/src/lib/pr-activity-comment.ts']) {
      expect(vocabularyInScope(p)).toBe(true);
    }
    expect(vocabularyInScope('apps/runner/src/workers.ts')).toBe(false);
    expect(vocabularyInScope('apps/runner/src/top/state.test.ts')).toBe(false);
    const paths = readSources().map((s) => s.path);
    expect(paths).toContain(TOP);
    expect(paths).toContain(KERNEL);
  });

  it('applies only the vocabulary rules there', () => {
    const src = "export const a = 'mission is on hold';\nexport const b = 'Nothing to configure here, simply wait.';";
    const { counts } = scanSources([{ path: TOP, content: src }]);
    expect(counts['catalog-word'][TOP]).toBe(1);
    expect(counts['state-jargon'][TOP]).toBe(1);
    expect(counts.reassurance[TOP]).toBeUndefined();
  });

  it('counts a one-word label for catalog-word only, and a word under a case label', () => {
    const src = "export function f(s: string) {\n  switch (s) {\n    case 'landed': return 'Landed';\n    case 'x': return 'Shipped elsewhere';\n  }\n  return s ? ' [HELD]' : 'Paused';\n}";
    expect(extractCopy(KERNEL, src).map((c) => c.text)).toEqual(['Landed', 'Shipped elsewhere', '[HELD]', 'Paused']);
    expect(scanSources([{ path: KERNEL, content: src }]).counts['catalog-word'][KERNEL]).toBe(3);
    // Lower-case keys never read as labels.
    expect(extractCopy(KERNEL, "export const k = { state: 'landed' };")).toEqual([]);
  });
  it('reads MCP replies as an agent does: worker is allowed there, seat and LOCAL are not', () => {
    const MCP = 'packages/core/mcp-tools.ts';
    const src = "export const a = 'Use the worker ID to report progress.';\nexport const b = '[LOCAL]';\nexport const c = 'on a subscription seat';";
    expect(scanSources([{ path: MCP, content: src }]).counts['catalog-word'][MCP]).toBe(2);
    expect(scanSources([{ path: TOP, content: src }]).counts['catalog-word'][TOP]).toBe(3);
  });
});

describe('notification copy', () => {
  const LIB = 'apps/web/src/lib/conflict-retry.ts';
  const ROUTE = 'apps/web/src/app/api/workers/[id]/route.ts';
  const src = [
    "const prompt = `You are an agent. BASE REWRITTEN \u2014 nothing to configure.`;",
    'void notifyTeamOf({ taskId }, \'needsAttention\', {',
    '  title: `PR #${n}: BASE REWRITTEN · cherry-pick?`,',
    "  message: ok ? `${t}\\nNothing to configure.` : 'Retry it.',",
    "  url, urlTitle: `PR #${n}`, priority: 1,",
    '});',
  ].join('\n');

  it('reads title, message and urlTitle of a notifyTeamOf payload, and nothing else in the file', () => {
    expect(extractNotifyCopy(LIB, src)).toEqual([
      { line: 3, text: 'PR #N: BASE REWRITTEN · cherry-pick?' },
      { line: 4, text: 'N Nothing to configure.' },
      { line: 4, text: 'Retry it.' },
      { line: 5, text: 'PR #N' },
    ]);
  });

  it('scans notify payloads in untagged lib/ modules and API routes, never their prompts', () => {
    for (const path of [LIB, ROUTE]) {
      const { counts } = scanSources([{ path, content: src }]);
      expect(counts['shouting-tag'][path]).toBe(1);
      expect(counts.reassurance[path]).toBe(1);
      expect(counts['em-dash'][path]).toBeUndefined();
    }
    expect(scanSources([{ path: 'apps/web/src/lib/conflict-retry.test.ts', content: src }]).counts['shouting-tag']).toEqual({});
  });

  it('readSources picks up notify modules and routes', () => {
    const paths = readSources().map((s) => s.path);
    for (const p of ['apps/web/src/lib/conflict-retry.ts', 'apps/web/src/lib/release/subscribers.ts', 'apps/web/src/lib/auto-merge.ts', 'apps/web/src/app/api/cron/stall-notify/route.ts']) {
      expect(paths).toContain(p);
    }
  });

  it('no notification title in the tree leads with a PR number or shouts', () => {
    const titles = readSources().filter((s) => s.content.includes('notifyTeamOf(')).flatMap(({ path, content }) => extractNotifyCopy(path, content, ['title']).map((s) => `${path}:${s.line} ${s.text}`));
    expect(titles.length).toBeGreaterThan(10);
    expect(titles.filter((t) => /#N\b/.test(t.slice(t.indexOf(' ') + 1)))).toEqual([]);
    expect(titles.filter((t) => copyViolations(t.slice(t.indexOf(' ') + 1)).some((r) => r.id === 'shouting-tag' || r.id === 'em-dash'))).toEqual([]);
  });
});

describe('ratchet', () => {
  const bad = 'export const A = () => <p>No rules yet.</p>;';

  it('reports a regression by the file that introduced it, not pre-existing debt', () => {
    const before = scanSources([{ path: OLD, content: bad }]);
    const after = scanSources([{ path: OLD, content: bad }, { path: NEW, content: bad }]);
    const r = findRegressions(before.counts, after.counts, after.violations);
    expect(r.map((x) => x.rule)).toEqual(['empty-yet']);
    expect(r[0].offenders.map((v) => v.file)).toEqual([NEW]);
  });

  it('--update locks in paid-down debt and refuses new debt', () => {
    const before = scanSources([{ path: OLD, content: bad }]).counts;
    const fixed = scanSources([{ path: OLD, content: 'export const A = () => <p>No rules.</p>;' }]).counts;
    expect(updatedBaseline(before, fixed, false).next['empty-yet']).toEqual({});
    const worse = scanSources([{ path: OLD, content: bad }, { path: NEW, content: bad }]).counts;
    expect(updatedBaseline(before, worse, false).refused).toEqual(['empty-yet']);
  });

  it('round-trips the baseline and rejects a malformed one', () => {
    const { counts } = scanSources([{ path: OLD, content: bad }]);
    expect(parseBaseline(serializeBaseline(counts))).toEqual(counts);
    expect(() => parseBaseline('{}')).toThrow(/missing rule/);
  });

  it('the committed baseline holds against the tree (guard the guard: the scan finds files)', async () => {
    const sources = readSources();
    expect(sources.length).toBeGreaterThan(300);
    const { readFileSync } = await import('fs');
    const { counts, violations } = scanSources(sources);
    const baseline = parseBaseline(readFileSync('scripts/copy-check.baseline.json', 'utf8'));
    expect(findRegressions(baseline, counts, violations)).toEqual([]);
  });
});
