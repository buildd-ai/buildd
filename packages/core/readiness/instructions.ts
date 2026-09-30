import { detector } from './context';

// Generic: the instruction-file conventions of the common coding agents.
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules'];
const INSTRUCTION_DIRS = ['.cursor/rules'];

export const detectAgentInstructions = detector(
  { id: 'agent-instructions', label: 'Agent instructions file', importance: 'core' },
  (ctx) => {
    const found = [
      ...INSTRUCTION_FILES.filter((f) => ctx.hasFile(f)),
      ...INSTRUCTION_DIRS.filter((d) => ctx.hasDir(d)).map((d) => `${d}/`),
    ];
    if (found.length > 0) {
      return {
        status: 'detected',
        value: found[0],
        evidence: [{ kind: 'path', paths: found, note: 'Agent instructions present.' }],
        fix: null,
      };
    }
    return {
      status: ctx.absentStatus(),
      evidence: [ctx.absentNote('No agent instructions file')],
      fix:
        ctx.absentStatus() === 'unknown'
          ? null
          : {
              kind: 'scaffold',
              summary: 'Add an agent instructions file naming the real test, typecheck and build commands.',
              templateId: 'instructions',
            },
    };
  },
);
