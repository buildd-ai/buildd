import { detectStartCommand } from './commands';
import { detector, type ReadinessContext } from './context';
import type { ReadinessItem } from './types';

type Found = Pick<ReadinessItem, 'status' | 'evidence' | 'fix' | 'value'>;

/**
 * Seam for the pure Vercel-preview detection owned by the sibling visual-QA
 * task. Not merged yet, so there is nothing to call: `null` means "preview
 * detection not available". When it lands, this is the one place to bind it
 * (map its `recommendation` into a `Found`); no contract is guessed here.
 */
function evaluatePreviewSource(_ctx: ReadinessContext): Found | null {
  return null;
}

const isPreview = (env: string) => /preview/i.test(env);

export const detectVisualQaSource = detector(
  { id: 'visual-qa-source', label: 'Visual QA source', importance: 'recommended' },
  (ctx) => {
    // Only a Preview deployment makes the preview source a candidate. With none
    // (or no access to deployments at all) the answer is sandbox-or-missing and
    // needs no preview detection; Vercel is never required.
    if ((ctx.deployments ?? []).some((d) => isPreview(d.environment))) {
      const viaPreview = evaluatePreviewSource(ctx);
      if (viaPreview) return viaPreview;
      return {
        status: 'unknown',
        evidence: [{ kind: 'signal', note: 'Preview deployments exist, but preview detection not available.' }],
        fix: null,
      };
    }

    const why =
      ctx.deployments === null
        ? 'No deployment information available (no access or none configured)'
        : 'No preview deployments found';
    const start = detectStartCommand(ctx);
    if (start) {
      return {
        status: 'detected',
        value: 'sandbox',
        evidence: [
          { kind: 'signal', note: `${why}; the app can boot in the sandbox.` },
          { kind: 'manifest', paths: [start.path], note: `Start command \`${start.command}\`.` },
          { kind: 'signal', note: 'The app must provide its own dev-auth bypass for the sandbox; that is an owner decision, never scaffolded.' },
        ],
        fix: null,
      };
    }
    const unreadable = ['package.json', 'Makefile'].filter((m) => ctx.unreadable(m));
    if (unreadable.length > 0) {
      return {
        status: 'unknown',
        evidence: [{ kind: 'signal', paths: unreadable, note: 'Manifest present but not read, so a start command is not ruled out.' }],
        fix: null,
      };
    }
    if (ctx.truncated) {
      return { status: 'unknown', evidence: [ctx.absentNote('A start command')], fix: null };
    }
    return {
      status: 'missing',
      evidence: [{ kind: 'absent', note: `${why}, and no start command was found in a manifest script or Makefile.` }],
      fix: { kind: 'owner-decision', summary: 'Choose how UI changes get looked at (boot recipe for the sandbox, or a preview source), or waive this item.' },
    };
  },
);
