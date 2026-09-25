import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * visual-qa.yml is the only way a worker sandbox (no DATABASE_URL, by design)
 * gets real-shaped screenshots: `gh workflow run visual-qa.yml --ref <branch>
 * -f routes=… -f viewport=mobile`, then `gh run download -n qa-screenshots`.
 * The visual-review skill documents exactly that contract, so these pin it.
 *
 * Parsed YAML, not grep, so a reformat cannot quietly defeat them.
 */

const wf = Bun.YAML.parse(
  readFileSync(join(__dirname, '..', '.github/workflows/visual-qa.yml'), 'utf8'),
) as any;
const on = wf.on ?? wf[true as unknown as string];
const job = wf.jobs['visual-qa'];
const steps: any[] = job.steps;
const step = (name: RegExp) => {
  const s = steps.find(x => name.test(x.name ?? ''));
  expect(s).toBeDefined();
  return s;
};

describe('visual-qa.yml dispatch contract', () => {
  test('workflow_dispatch exposes routes / viewport / mission_id / task_id / judge', () => {
    const inputs = on.workflow_dispatch?.inputs ?? {};
    for (const k of ['routes', 'viewport', 'mission_id', 'task_id']) {
      expect(inputs[k]?.type).toBe('string');
      expect(inputs[k]?.required).toBe(false);
    }
    expect(inputs.judge?.type).toBe('boolean');
    expect(inputs.judge?.default).toBe(false);
  });

  test('capture maps the inputs to QA_* env (never interpolated into the script)', () => {
    const capture = step(/^Capture/);
    expect(capture.env.QA_ROUTES).toContain('inputs.routes');
    expect(capture.env.QA_VIEWPORT).toContain('inputs.viewport');
    expect(capture.env.QA_MISSION_ID).toContain('inputs.mission_id');
    expect(capture.env.QA_TASK_ID).toContain('inputs.task_id');
    expect(capture.run).not.toContain('inputs.');
  });

  test('screenshots + a11y upload under a stable artifact name with short retention', () => {
    const upload = step(/^Upload/);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
    expect(upload.if).toBe('always()');
    expect(upload.with.name).toBe('qa-screenshots');
    expect(upload.with.path).toContain('screenshots');
    expect(upload.with.path).toContain('a11y');
    expect(upload.with['retention-days']).toBeLessThanOrEqual(7);
  });

  const JUDGE_GATE = "github.event_name == 'pull_request' || inputs.judge";

  test('judge steps run on the release-PR path, and on dispatch only with judge=true', () => {
    const judgeSteps = steps.filter(s => /judge|Judge/.test(s.name ?? ''));
    expect(judgeSteps.length).toBeGreaterThanOrEqual(3); // prepare, OAuth judge, report
    for (const s of judgeSteps) expect(s.if).toBe(JUDGE_GATE);
    expect(step(/^Post results/).if).toBe(`always() && (${JUDGE_GATE})`);
  });

  // /api/qa/judge bills a server API key per token. CI judges on the team's
  // OAuth seat instead, via claude-code-action.
  test('the judge runs on OAuth via claude-code-action, never the per-token endpoint', () => {
    const all = JSON.stringify(wf);
    expect(all).not.toContain('BUILDD_QA_KEY');
    expect(all).not.toContain('BUILDD_QA_URL');
    const oauth = steps.find(s => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'));
    expect(oauth).toBeDefined();
    expect(oauth.uses).toBe('anthropics/claude-code-action@v1');
    expect(oauth.with.claude_code_oauth_token).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(oauth.with.anthropic_api_key).toBeUndefined();
  });

  test('the OAuth judge can only read/write the QA output dir: no Bash, no network', () => {
    const oauth = steps.find(s => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'));
    const args: string = oauth.with.claude_args;
    const allowed = /--allowedTools\s+"([^"]+)"/.exec(args)?.[1].split(',') ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    for (const t of allowed) expect(t).toMatch(/^(Read|Glob|Write|Edit)\(\/\/tmp\/qa\//);
    const denied = /--disallowedTools\s+"([^"]+)"/.exec(args)?.[1].split(',') ?? [];
    for (const t of ['Bash', 'WebFetch', 'WebSearch']) expect(denied).toContain(t);
    const turns = Number(/--max-turns\s+(\d+)/.exec(args)?.[1]);
    expect(turns).toBeGreaterThan(0);
    expect(turns).toBeLessThanOrEqual(60);
  });

  test('release-PR label gate is unchanged', () => {
    expect(on.pull_request.branches).toEqual(['main']);
    expect(job.if).toContain("github.head_ref == 'dev'");
    expect(job.if).toContain("contains(github.event.pull_request.labels.*.name, 'visual-qa')");
  });

  test('Neon branch name is unique per run so concurrent dispatches cannot collide', () => {
    const neon = step(/^Create Neon/);
    const nameLine = (neon.run as string).split('\n').find(l => l.includes('BRANCH_NAME='));
    expect(nameLine).toContain('github.run_id');
    expect(nameLine).toContain('github.run_attempt');
  });

  // A curl failing after the branch exists used to abort (bash -e) before
  // branch_id was written, so cleanup skipped and the prod clone leaked.
  test('branch_id is published before anything that can fail after creation', () => {
    const lines = (step(/^Create Neon/).run as string).split('\n');
    const published = lines.findIndex(l => l.includes('branch_id=') && l.includes('GITHUB_OUTPUT'));
    const created = lines.findIndex(l => /BRANCH_ID=\$\(/.test(l));
    expect(created).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(created);
    const between = lines.slice(created, published).join('\n');
    expect(between).not.toContain('curl');
  });

  test('concurrent dispatches on one ref do not cancel each other', () => {
    expect(String(wf.concurrency.group)).toContain('github.run_id');
  });

  test('connection URIs are never echoed', () => {
    for (const s of steps) {
      const run: string = s.run ?? '';
      for (const line of run.split('\n')) {
        if (/^\s*echo\b/.test(line) && !line.includes('GITHUB_OUTPUT')) {
          expect(line).not.toMatch(/CONNECTION_URI|DATABASE_URL|database_url/);
        }
      }
    }
  });
});
