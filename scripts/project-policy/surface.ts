import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractCopy, readSources } from '../copy-check';
import { policyPreset } from './policy-presets';
import { extractChangedSubjects, evaluateSubject, type ChangedSubject, type ProjectPolicy } from './pipeline';
import { localJevEvaluator } from './explore';
import type { SemanticEvaluator } from './semantic';

function git(args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

/** Contextual descriptions first; stable order makes repeated cached scans resumable. */
const priority = (s: ChangedSubject) => (s.role === 'description' ? 1000 : 0)
  + (s.staticContext?.heading ? 500 : 0) + Math.min(s.after?.length ?? 0, 500);

export async function scanSurface(sources: { path: string; content: string }[], policy: ProjectPolicy,
  semantic?: SemanticEvaluator, offset = 0) {
  const errors: { file: string; message: string }[] = [];
  const subjects: ChangedSubject[] = [];
  for (const source of sources) {
    try { subjects.push(...extractChangedSubjects({ file: source.path, before: '', after: source.content })); }
    catch { errors.push({ file: source.path, message: 'TSX parse failed; not treated as clean.' }); }
  }
  subjects.sort((a, b) => priority(b) - priority(a) || a.file.localeCompare(b.file) || a.start - b.start);
  const rows = [];
  for (let index = 0; index < subjects.length; index++) {
    const subject = subjects[index];
    const findings = await evaluateSubject(subject, policy, undefined, index >= offset ? semantic : undefined);
    rows.push({ subject, findings });
  }
  const findings = rows.flatMap(row => row.findings);
  const decisions = findings.flatMap(f => f.decision ? [f.decision] : []);
  const fresh = decisions.filter(d => d.attempts > 0);
  return {
    policy: `${policy.id}@${policy.version}`, policyAuthority: policy.authority.hash,
    inventory: { files: sources.length, subjects: subjects.length,
      static: subjects.filter(s => s.after !== null).length,
      unresolved: subjects.filter(s => s.after === null || s.role === 'unknown').length,
      withStaticContext: subjects.filter(s => s.staticContext).length },
    coverage: { deterministicViolations: findings.filter(f => f.enforced).length,
      newDecisions: fresh.length, attempts: fresh.reduce((sum, d) => sum + d.attempts, 0),
      cacheHits: decisions.filter(d => d.cache?.hit).length,
      advisoryRevisions: findings.filter(f => f.evaluator === 'model-advisory' && f.verdict === 'revise').length,
      deferred: decisions.filter(d => d.reasonCode === 'local_budget_exhausted').length,
      offset, rendered: false, enforcement: 'model-advisory-only',
      costUsd: fresh.length ? fresh.every(d => d.costUsd !== null) ? fresh.reduce((sum, d) => sum + d.costUsd!, 0) : null : 0,
      latencyTotalMs: fresh.reduce((sum, d) => sum + d.latencyMs, 0) },
    limits: ['Static TSX only; not a census of runtime copy.', 'Custom components, dynamic strings and .ts catalogs require contracts or rendered context.',
      'Static neighbors are partial syntax; no runtime state or visibility is inferred.',
      'Deterministic violations skip the model; the 30-word rule still applies.',
      'Default 20 new decisions; --max-new explicitly raises the budget (maximum 5000). Repeat to reuse cache, or use --offset after persistent failures.'],
    errors, rows,
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (args.some(a => a !== '--jev' && !['policy', 'team', 'workspace', 'cache', 'output', 'offset', 'max-new'].some(name => a.startsWith(`--${name}=`)))) throw new Error('Unknown surface-scan argument.');
    if (!args.includes('--jev') && (arg('team') || arg('workspace') || arg('cache'))) throw new Error('Credential/cache options require --jev.');
    const offset = Number(arg('offset') ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Offset must be a nonnegative integer.');
    const maxNew = Number(arg('max-new') ?? 20);
    if (!Number.isInteger(maxNew) || maxNew < 0 || maxNew > 5000) throw new Error('max-new must be between 0 and 5000.');
    const files = git(['ls-files', '-z', '--', 'apps/web/src']).split('\0').filter(file => file.endsWith('.tsx'));
    if (!files.length) throw new Error('No tracked web TSX files discovered.');
    const sources = files.map(path => ({ path, content: readFileSync(path, 'utf8') }));
    const cache = arg('cache') ?? resolve(git(['rev-parse', '--git-path', 'project-policy-cache']));
    const semantic = args.includes('--jev') ? await localJevEvaluator(arg('team'), arg('workspace'), undefined, cache, maxNew) : undefined;
    const catalogs = readSources().filter(source => source.path.startsWith('apps/web/src/') && source.path.endsWith('.ts'));
    const catalogCandidates = catalogs.reduce((sum, source) => sum + extractCopy(source.path, source.content).length, 0);
    const report = { ...await scanSurface(sources, policyPreset(arg('policy') ?? 'wwvd').policy, semantic, offset),
      unclassifiedTsCandidates: { files: catalogs.length, strings: catalogCandidates, source: 'existing copy-check extractor; not evaluated by the TSX model path' },
      sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--', 'apps/web/src', 'scripts/project-policy']),
      model: args.includes('--jev') ? 'explicit Jev; scoped cache; current authorization required' : 'not exercised' };
    if (arg('output')) await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, rows: `See ${arg('output') ?? 'use --output=<local-json> for full rows'}` }, null, 2));
    if (report.errors.length) process.exitCode = 2;
  } catch {
    console.error('Surface scan failed. Check local sources, arguments and authorized route; no provider body is printed.');
    process.exitCode = 2;
  }
}
