import { detectMigrationsDir } from '../spec-conformance-detect';
import { detector } from './context';

// Candidate locations of an environment-contract manifest.
const ENV_MANIFEST_CANDIDATES = ['.buildd/env.yaml'];

export const detectEnvManifest = detector(
  { id: 'env-manifest', label: 'Environment manifest', importance: 'recommended' },
  (ctx) => {
    const present = ENV_MANIFEST_CANDIDATES.find((p) => ctx.hasFile(p));
    if (present) {
      return {
        status: 'detected',
        value: present,
        evidence: [{ kind: 'path', paths: [present], note: 'Environment manifest present.' }],
        fix: null,
      };
    }
    const status = ctx.absentStatus();
    if (status === 'unknown') return { status, evidence: [ctx.absentNote('An environment manifest')], fix: null };

    const withLock = ctx.ecosystems.filter((e) => e.lockfile);
    if (withLock.length > 0) {
      return {
        status,
        evidence: [
          {
            kind: 'path',
            paths: withLock.map((e) => e.lockfile as string),
            note: 'No environment manifest, but a lockfile makes the install command deterministic.',
          },
        ],
        fix: {
          kind: 'scaffold',
          summary: 'Generate an environment manifest from the detected toolchain.',
          templateId: 'env-manifest',
        },
      };
    }
    return {
      status,
      evidence: [
        {
          kind: 'absent',
          note:
            ctx.ecosystems.length > 0
              ? 'No environment manifest and no lockfile to generate one from.'
              : 'No environment manifest and no recognised toolchain to generate one from.',
        },
      ],
      fix: { kind: 'owner-decision', summary: 'Describe how to install and verify this repo, or waive this item.' },
    };
  },
);

export const detectMigrationsDirItem = detector(
  { id: 'migrations-dir', label: 'Migrations directory', importance: 'recommended' },
  (ctx) => {
    const dir = detectMigrationsDir(ctx.files);
    if (dir) {
      const configured = ctx.gitConfig.specConformance?.migrationsDir;
      return {
        status: 'detected',
        value: dir,
        evidence: [{ kind: 'path', paths: [`${dir}/`], note: 'Migrations directory found.' }],
        fix:
          configured === dir
            ? null
            : {
                kind: 'apply-config',
                summary: 'Record the migrations directory so spec-conformance checks look in the right place.',
                configPatch: { specConformance: { migrationsDir: dir } },
              },
      };
    }
    // Absent is fine: many repos have no database. Only truncation makes it unknowable.
    return {
      status: ctx.absentStatus(),
      evidence: [ctx.absentNote('A migrations directory')],
      fix: null,
    };
  },
);
