import { detectSpecConformanceRoots } from '../spec-conformance-detect';
import { detector, type ReadinessContext } from './context';
import type { ReadinessEvidence } from './types';

/** Filenames under a spec root that describe the format rather than a spec. */
const FORMAT_DOC = /^(?:.*\/)?(?:[\w.-]*format[\w.-]*|readme|template|index)\.md$/i;
const isMarkdown = (f: string) => f.toLowerCase().endsWith('.md');

/** The spec root: explicitly configured, else the shared candidate-list detection `init` uses. */
export function resolveSpecRoot(ctx: ReadinessContext): { root: string | null; configured: boolean } {
  const configured = ctx.gitConfig.specConformance?.specsRoot;
  if (configured) return { root: configured.replace(/\/$/, ''), configured: true };
  return { root: detectSpecConformanceRoots(ctx.files).specsRoot, configured: false };
}

function specFilesUnder(ctx: ReadinessContext, root: string): { formatDocs: string[]; specs: string[] } {
  const under = ctx.files.filter((f) => f.startsWith(`${root}/`) && isMarkdown(f));
  return { formatDocs: under.filter((f) => FORMAT_DOC.test(f)), specs: under.filter((f) => !FORMAT_DOC.test(f)) };
}

/** Whether at least one spec (not a format doc) exists under the detected root. */
export function hasSpecs(ctx: ReadinessContext): boolean {
  const { root } = resolveSpecRoot(ctx);
  return root !== null && specFilesUnder(ctx, root).specs.length > 0;
}

export const detectSpecRoot = detector(
  { id: 'spec-root', label: 'Spec directory', importance: 'core' },
  (ctx) => {
    const { root, configured } = resolveSpecRoot(ctx);
    if (root) {
      return {
        status: 'detected',
        value: root,
        evidence: [
          configured
            ? { kind: 'signal', note: 'Spec root configured on the workspace.' }
            : {
                kind: 'path',
                paths: [`${root}/`],
                note: 'Matches a known spec-directory name; confirm it holds specifications.',
              },
        ],
        fix: null,
      };
    }
    const status = ctx.absentStatus();
    return {
      status,
      evidence: [ctx.absentNote('No spec directory')],
      fix:
        status === 'unknown'
          ? null
          : {
              kind: 'scaffold',
              summary: 'Create a spec directory with a format document so specs can be authored and checked.',
              templateId: 'spec-root',
            },
    };
  },
);

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;
const frontmatterKeys = (text: string): string[] | null => {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  return m[0]
    .split(/\r?\n/)
    .slice(1, -1)
    .map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1])
    .filter((k): k is string => !!k)
    .sort();
};

export const detectSpecFormat = detector(
  { id: 'spec-format', label: 'Spec format document', importance: 'core' },
  (ctx) => {
    const { root } = resolveSpecRoot(ctx);
    if (!root) {
      const status = ctx.absentStatus();
      return {
        status,
        evidence: [ctx.absentNote('No spec directory, so no spec format')],
        fix:
          status === 'unknown'
            ? null
            : { kind: 'scaffold', summary: 'Scaffolded together with the spec directory.', templateId: 'spec-format' },
      };
    }

    const { formatDocs, specs } = specFilesUnder(ctx, root);
    if (formatDocs.length > 0) {
      return {
        status: 'detected',
        value: formatDocs[0],
        evidence: [{ kind: 'path', paths: formatDocs, note: 'Format document present in the spec root.' }],
        fix: null,
      };
    }

    // No format doc: consistent frontmatter across the specs we were able to read also counts.
    const read = specs.filter((s) => s in ctx.manifests);
    const keySets = read.map((s) => frontmatterKeys(ctx.manifests[s])).filter((k): k is string[] => k !== null);
    if (keySets.length >= 2 && keySets.every((k) => k.join() === keySets[0].join())) {
      return {
        status: 'detected',
        evidence: [
          {
            kind: 'manifest',
            paths: read,
            note: `Existing specs share one frontmatter shape (${keySets[0].join(', ')}).`,
          },
        ],
        fix: null,
      };
    }

    if (ctx.truncated) {
      return {
        status: 'unknown',
        evidence: [ctx.absentNote('No spec format document')],
        fix: null,
      };
    }

    const evidence: ReadinessEvidence[] = [
      { kind: 'absent', note: 'No format document in the spec root and no consistent frontmatter among readable specs.' },
    ];
    if (specs.length > 0) {
      // Existing specs may already follow a format worth mirroring: that is a choice, not a scaffold.
      if (specs.some((s) => !(s in ctx.manifests))) {
        evidence.push({ kind: 'signal', note: 'Some specs were not read, so their format is not confirmed.' });
      }
      return {
        status: 'missing',
        evidence: [{ kind: 'path', paths: specs.slice(0, 5), note: 'Specs exist without a format document.' }, ...evidence],
        fix: {
          kind: 'owner-decision',
          summary: 'Specs already exist: decide whether to document their format or adopt a new one.',
        },
      };
    }
    return {
      status: 'missing',
      evidence,
      fix: { kind: 'scaffold', summary: 'Add a spec format document to the spec root.', templateId: 'spec-format' },
    };
  },
);
