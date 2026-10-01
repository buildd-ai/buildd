import { detector, type ReadinessContext } from './context';
import type { ReadinessEvidence, ReadinessItem } from './types';

const WORKFLOW = /^\.github\/workflows\/([^/]+\.ya?ml)$/;
const RELEASE_SHAPED = /release|deploy|publish/i;
const DISPATCHABLE = /^\s*(?:workflow_dispatch\b|on:.*\bworkflow_dispatch\b)/m;
const RELEASE_SCRIPT = /^(?:release|publish)(?::[\w:-]+)?$/;
const PROD_BRANCHES = ['main', 'master', 'production', 'prod'];
const DEV_BRANCHES = ['dev', 'develop', 'development', 'staging'];

type Found = Pick<ReadinessItem, 'status' | 'evidence' | 'fix' | 'value'>;

function fromWorkflows(ctx: ReadinessContext): Found | { unreadable: string[] } | null {
  const candidates = ctx.files.filter((f) => WORKFLOW.test(f) && RELEASE_SHAPED.test(f.split('/').pop() as string));
  const dispatchable = candidates.filter((f) => f in ctx.manifests && DISPATCHABLE.test(ctx.manifests[f]));
  if (dispatchable.length > 0) {
    const file = (WORKFLOW.exec(dispatchable[0]) as RegExpExecArray)[1];
    const ref = ctx.gitConfig.defaultBranch;
    return {
      status: 'detected',
      value: `workflow_dispatch: ${file}`,
      evidence: [{ kind: 'manifest', paths: dispatchable, note: 'Release-shaped workflow with a workflow_dispatch trigger.' }],
      fix: {
        kind: 'apply-config',
        summary: 'Point the workspace release config at this workflow.',
        configPatch: {
          releaseConfig: { enabled: true, strategy: 'workflow_dispatch', workflowFile: file, ...(ref ? { ref } : {}) },
        },
      },
    };
  }
  const unreadable = candidates.filter((f) => !(f in ctx.manifests));
  return unreadable.length > 0 ? { unreadable } : null;
}

function fromScripts(ctx: ReadinessContext): Found | null {
  const pm = ctx.ecosystems.find((e) => e.ecosystem === 'node')?.packageManager;
  try {
    const scripts = JSON.parse(ctx.manifests['package.json'] ?? '{}')?.scripts ?? {};
    const name = Object.keys(scripts).find((k) => RELEASE_SCRIPT.test(k) && typeof scripts[k] === 'string');
    if (name && pm) return scriptFound(`${pm} run ${name}`, 'package.json');
  } catch {
    // malformed manifest: no script signal
  }
  if (/^release\s*:(?!=)/m.test(ctx.manifests['Makefile'] ?? '')) return scriptFound('make release', 'Makefile');
  return null;
}

function scriptFound(command: string, path: string): Found {
  return {
    status: 'detected',
    value: `script: ${command}`,
    evidence: [{ kind: 'manifest', paths: [path], note: `Release-shaped script \`${command}\`.` }],
    fix: {
      kind: 'apply-config',
      summary: 'Point the workspace release config at this release command.',
      configPatch: { releaseConfig: { enabled: true, strategy: 'script', command } },
    },
  };
}

function fromBranches(ctx: ReadinessContext): Found | null {
  const prod = PROD_BRANCHES.find((b) => ctx.branches.includes(b));
  const dev = DEV_BRANCHES.find((b) => ctx.branches.includes(b));
  if (!prod || !dev) return null;
  return {
    status: 'detected',
    value: `branch_merge: ${dev} -> ${prod}`,
    evidence: [{ kind: 'signal', note: `Long-lived branches ${dev} and ${prod} exist.` }],
    fix: {
      kind: 'apply-config',
      summary: 'Promote the development branch to the production branch through a release PR.',
      configPatch: { releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: prod, releaseBranch: dev } },
    },
  };
}

export const detectReleasePath = detector(
  { id: 'release-path', label: 'Release path', importance: 'recommended' },
  (ctx) => {
    if (ctx.releaseConfig?.enabled) {
      return {
        status: 'detected',
        value: ctx.releaseConfig.strategy,
        evidence: [
          {
            kind: 'signal',
            note: `Releases are configured on the workspace${ctx.releaseConfig.strategy ? ` (${ctx.releaseConfig.strategy})` : ''}.`,
          },
        ],
        fix: null,
      };
    }

    const wf = fromWorkflows(ctx);
    if (wf && 'status' in wf) return wf;
    const found = fromScripts(ctx) ?? fromBranches(ctx);
    if (found) return found;

    const evidence: ReadinessEvidence[] = [];
    if (wf && 'unreadable' in wf) {
      evidence.push({
        kind: 'signal',
        paths: wf.unreadable,
        note: 'Release-shaped workflow present but not read, so its trigger is not confirmed.',
      });
    }
    evidence.push(
      ctx.truncated
        ? ctx.absentNote('A release signal')
        : { kind: 'absent', note: 'No release workflow, script or long-lived release branches found; the repo may have no release path.' },
    );
    // A release path is optional and not always visible in a repo, so absence reads `unknown`, not `missing`.
    return {
      status: 'unknown',
      evidence,
      fix: { kind: 'owner-decision', summary: 'Decide how this repo releases, or waive this item if it does not.' },
    };
  },
);
