import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import policy from './product-language.json';
import { policyPreset } from './policy-presets';
import { evaluateSubject, extractChangedSubjects, policyExitCode, type ProjectPolicy, type SubjectContext } from './pipeline';
import type { SemanticEvaluator } from './semantic';

type Stage = 'agent' | 'commit' | 'ci';
interface Change { file: string; before: string; after: string; patch?: string; contexts?: Record<string, SubjectContext> }

const git = (args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed; check the repository/index (no empty-success fallback).`);
  return result.stdout;
};

/** Full blobs from HEAD and the index. Never read unstaged file contents. */
export function readStagedChanges(run = git): Change[] {
  const paths = run(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=AM', '-z', '--', '*.tsx']).split('\0').filter(Boolean);
  return paths.map(file => {
    // Added files have no HEAD blob. Ask git's object inventory rather than swallowing all errors.
    const tracked = run === git ? spawnSync('git', ['cat-file', '-e', `HEAD:${file}`]).status === 0 : true;
    return { file, before: tracked ? run(['show', `HEAD:${file}`]) : '', after: run(['show', `:${file}`]),
      patch: run(['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=0', '--', file]) };
  });
}

function validateInput(value: unknown): { changes: Change[]; customRules?: ProjectPolicy['customRules'] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { changes?: unknown }).changes)) throw new Error('Input requires changes[].');
  const input = value as { changes: Change[]; customRules?: ProjectPolicy['customRules'] };
  for (const c of input.changes) {
    if (!c || typeof c.file !== 'string' || typeof c.before !== 'string' || typeof c.after !== 'string'
      || (c.patch !== undefined && typeof c.patch !== 'string')) throw new Error('Each change requires file, before and after strings; patch is optional.');
    if (c.contexts !== undefined) {
      if (!c.contexts || typeof c.contexts !== 'object' || Array.isArray(c.contexts)) throw new Error('contexts must map new-side line numbers to explicit context.');
      for (const [line, ctx] of Object.entries(c.contexts)) {
        if (!/^\d+$/.test(line) || !ctx || typeof ctx.source !== 'string' || !ctx.source.trim()) throw new Error('Each context needs a line and provenance source.');
        if (ctx.role && !['status', 'action', 'heading', 'description', 'diagnostic', 'unknown'].includes(ctx.role)) throw new Error('Invalid context role.');
      }
    }
  }
  if (input.customRules !== undefined) {
    if (!Array.isArray(input.customRules)) throw new Error('customRules must be an array.');
    for (const r of input.customRules) {
      if (!r || typeof r.id !== 'string' || !Array.isArray(r.roles) || typeof r.pattern !== 'string' || typeof r.correction !== 'string') throw new Error('Invalid custom rule.');
      new RegExp(r.pattern); // Fail malformed policy before inspecting any changes.
    }
  }
  return input;
}

export async function runLocalCheck(value: unknown, stage: Stage, semantic?: SemanticEvaluator, selected: ProjectPolicy = policy) {
  if (!['agent', 'commit', 'ci'].includes(stage)) throw new Error('stage must be agent, commit or ci.');
  const input = validateInput(value);
  const configured: ProjectPolicy = { ...selected, customRules: input.customRules ?? selected.customRules };
  const subjects = input.changes.flatMap(c => {
    const extracted = extractChangedSubjects(c);
    return extracted.map(subject => {
      const context = c.contexts?.[String(subject.line)];
      if (!context) return { subject, context: undefined };
      const matches = (s: typeof subject) => s.line === subject.line
        && (context.prop === undefined || s.prop === context.prop)
        && (context.component === undefined || s.component === context.component)
        && (context.start === undefined || s.start === context.start);
      if (extracted.filter(matches).length > 1) throw new Error('Context is ambiguous; specify prop, component or start span.');
      return { subject, context: matches(subject) ? context : undefined };
    });
  });
  const evaluated = (await Promise.all(subjects.map(s => evaluateSubject(s.subject, configured, s.context, semantic)))).flat();
  const findings = stage === 'agent' ? evaluated.map(f => ({ ...f, enforced: false })) : evaluated;
  const decisions = evaluated.flatMap(f => f.decision ? [f.decision] : []).filter(d => d.attempts > 0);
  const cacheHits = evaluated.filter(f => f.decision?.cache?.hit).length;
  return {
    policy: `${configured.id}@${configured.version}`, stage, subjects: subjects.length, findings,
    invocation: stage === 'agent' ? 'advisory' : 'deterministic-only',
    exitCode: stage === 'agent' ? 0 : policyExitCode(findings),
    scope: 'Deterministic pass does not establish semantic quality or actual runtime state.',
    coverage: { command: 'executed', agentHook: 'not integrated', preCommitHook: 'not integrated', ci: 'not integrated', pr: 'existing copyReview unchanged' },
    model: { status: decisions.length ? 'advisory exploration' : cacheHits ? 'cached advice' : 'not exercised', cacheHits, cache: semantic?.cacheStats ?? null,
      provider: decisions.length || cacheHits ? 'openrouter' : null,
      version: decisions[0]?.model ?? evaluated.find(f => f.decision?.cache?.hit)?.decision?.model ?? null,
      decisions: decisions.length, latencyMs: decisions.length ? decisions.reduce((sum, d) => sum + d.latencyMs, 0) : cacheHits ? 0 : null,
      costUsd: decisions.length && decisions.every(d => d.costUsd !== null) ? decisions.reduce((sum, d) => sum + d.costUsd!, 0) : cacheHits && !decisions.length ? 0 : null },
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const stage = (args.find(a => a.startsWith('--stage='))?.slice(8) ?? 'commit') as Stage;
    const inputPath = args.find(a => a.startsWith('--input='))?.slice(8);
    if ((!inputPath && !args.includes('--staged')) || (inputPath && args.includes('--staged'))) throw new Error('Use --input=<snapshots.json> OR --staged, optionally --stage=agent|commit|ci.');
    if (args.some(a => a !== '--staged' && a !== '--jev' && !['--input=', '--stage=', '--team=', '--workspace=', '--policy=', '--cache='].some(prefix => a.startsWith(prefix)))) throw new Error('Unknown argument.');
    const selected = policyPreset(args.find(a => a.startsWith('--policy='))?.slice(9)).policy;
    if (!args.includes('--jev') && args.some(a => a.startsWith('--team=') || a.startsWith('--workspace=') || a.startsWith('--cache='))) throw new Error('Credential scope/cache is only used with explicit --jev exploration.');
    const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : { changes: readStagedChanges() };
    const semantic = args.includes('--jev') ? await (await import('./explore')).localJevEvaluator(
      args.find(a => a.startsWith('--team='))?.slice(7), args.find(a => a.startsWith('--workspace='))?.slice(12), undefined,
      args.find(a => a.startsWith('--cache='))?.slice(8) ?? git(['rev-parse', '--git-path', 'project-policy-cache']).trim()) : undefined;
    const report = { ...await runLocalCheck(input, stage, semantic, selected), sourceCommit: git(['rev-parse', 'HEAD']).trim(),
      sourceDirty: !!git(['status', '--porcelain', '--', 'scripts/project-policy']).trim() };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local policy check failed.');
    process.exitCode = 2;
  }
}
