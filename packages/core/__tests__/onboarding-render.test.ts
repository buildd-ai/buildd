import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ONBOARDING_TEMPLATES_DIR,
  ONBOARDING_TEMPLATE_IDS,
  getOnboardingTemplateParams,
  renderOnboardingTemplate,
  renderTemplateSource,
  type OnboardingParams,
  type OnboardingTemplateId,
} from '../onboarding-render';

// A Python/uv service with none of buildd's layout, names or toolchain.
const FIXTURE: OnboardingParams = {
  projectName: 'acme-ledger',
  defaultBranch: 'trunk',
  prTarget: 'trunk',
  installCommand: 'uv sync --frozen',
  testCommand: 'uv run pytest -q',
  typecheckCommand: 'uv run mypy src',
  buildCommand: 'uv build',
  testDir: 'tests',
  migrationsDir: 'alembic',
  specsRoot: 'specifications',
  designRoot: 'proposals',
  domains: ['ledger', 'reporting', 'ingest'],
  isPublic: true,
  consumerSkill: true,
  runtime: 'python@3.12',
  readinessCommand: 'uv run pytest -q tests/smoke',
  readinessTimeout: 180,
  requiredEnv: ['LEDGER_DSN'],
  startCommand: 'uv run uvicorn acme.app:app --port 8000',
  devAuthEnvVar: 'ACME_DEV_USER',
  phoneViewport: '390x844',
  sourceBranch: 'develop',
  targetBranch: 'trunk',
  tagPrefix: 'rel-',
};

// Only what each template requires, nothing optional: every keep-if is unmet.
const MINIMAL: Record<OnboardingTemplateId, OnboardingParams> = {
  instructions: { projectName: 'acme-ledger', defaultBranch: 'trunk' },
  'spec-format': { specsRoot: 'specifications' },
  'design-format': { designRoot: 'proposals' },
  'env-manifest': {},
  'consumer-skill': {},
  'visual-review': {},
  'release-workflow': { sourceBranch: 'develop', targetBranch: 'trunk' },
};

// Names and paths that belong to buildd's own repo. None may appear in what a
// stranger's repo receives, except inside a value the caller passed in.
const DENYLIST = [
  'apps/web',
  'apps/runner',
  'bun run',
  'bun install',
  'bunx',
  'bun.lock',
  'Neon',
  'proxy.ts',
  'turbo',
  'packages/core',
  'packages/shared',
  'buildd-ai',
  'buildd.dev',
  'buildd.ai',
  'docs/specs',
  'docs/design',
  'check-specs',
  'specs:check',
  'specs:lint',
  'drizzle',
  'vercel',
  'pusher',
  'shoot.sh',
  'scrub-pii',
  'visual-qa.yml',
  'missions · tasks',
  '· billing',
];

function passedValues(params: OnboardingParams): string[] {
  const out: string[] = [];
  for (const v of Object.values(params)) {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) out.push(...v.map(String));
  }
  return out.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

function residue(content: string, params: OnboardingParams): string[] {
  let text = content;
  for (const v of passedValues(params)) text = text.split(v).join('');
  const lower = text.toLowerCase();
  return DENYLIST.filter((d) => lower.includes(d.toLowerCase()));
}

describe('renderOnboardingTemplate: anti-blind-copy gate (AC-10)', () => {
  for (const id of ONBOARDING_TEMPLATE_IDS) {
    test(`${id}: no buildd residue against a non-buildd fixture, all sections kept`, () => {
      const r = renderOnboardingTemplate(id, FIXTURE);
      expect(r.content.length).toBeGreaterThan(0);
      expect(residue(r.content, FIXTURE)).toEqual([]);
    });

    test(`${id}: no buildd residue with only required params, all optional sections dropped`, () => {
      const params = MINIMAL[id];
      const r = renderOnboardingTemplate(id, params);
      expect(r.content.length).toBeGreaterThan(0);
      expect(residue(r.content, params)).toEqual([]);
    });
  }

  test('the denylist check itself catches residue (guard against a vacuous test)', () => {
    expect(residue('run `bun run test` in apps/web', {})).toEqual(['apps/web', 'bun run']);
  });

  test('a denylisted string is allowed only when the caller passed it', () => {
    const params = { ...FIXTURE, testCommand: 'bun run test' };
    const r = renderOnboardingTemplate('instructions', params);
    expect(r.content).toContain('`bun run test`');
    expect(residue(r.content, params)).toEqual([]);
    expect(residue(r.content, { ...params, testCommand: 'pytest' })).toEqual(['bun run']);
  });

  test('no template renders a marker, placeholder or keep-if comment into the output', () => {
    for (const id of ONBOARDING_TEMPLATE_IDS) {
      for (const params of [FIXTURE, MINIMAL[id]]) {
        const { content } = renderOnboardingTemplate(id, params);
        expect(content).not.toContain('keep-if');
        expect(content).not.toMatch(/(?<!\$)\{\{/);
      }
    }
  });
});

describe('renderOnboardingTemplate: per template', () => {
  test('every template file on disk is registered, and every id has a file', () => {
    const probed = ONBOARDING_TEMPLATE_IDS.map((id) => {
      let file = '';
      renderOnboardingTemplate(id, MINIMAL[id], {
        readTemplate: (f) => {
          file = f;
          return 'x\n';
        },
      });
      return file;
    }).sort();
    expect(probed).toEqual(readdirSync(ONBOARDING_TEMPLATES_DIR).sort());
  });

  test('instructions: fills commands, branch and optional sections from params', () => {
    const { content, path } = renderOnboardingTemplate('instructions', FIXTURE);
    expect(path).toBe('CLAUDE.md');
    expect(content).toStartWith('# acme-ledger - Agent Instructions');
    expect(content).toContain('`uv run pytest -q`');
    expect(content).toContain('**Default branch:** `trunk`');
    expect(content).toContain('Schema migrations live in `alembic`');
    expect(content).toContain('`specifications/SPEC-FORMAT.md`');
    expect(content).toContain('`proposals/DESIGN-FORMAT.md`');
    expect(content).toContain('## This Repo Is Public');
    expect(content).toContain('.claude/skills/buildd-mcp-consumer/SKILL.md');
    expect(content).not.toContain('TODO(owner):');
  });

  test('instructions: unknown commands render a marked TODO(owner) line, never a guess', () => {
    const { content } = renderOnboardingTemplate('instructions', MINIMAL.instructions);
    expect(content).toContain('**Install:** TODO(owner):');
    expect(content).toContain('**Test:** TODO(owner):');
    expect(content).toContain('**Typecheck / lint:** TODO(owner):');
    expect(content).toContain('**Build:** TODO(owner):');
    expect(content).toContain('TODO(owner): say where tests live');
    for (const guess of ['npm ', 'pytest', 'make test', 'cargo', 'go test', 'yarn', 'pnpm']) {
      expect(content).not.toContain(guess);
    }
    expect(content).not.toContain('## Database Migrations');
    expect(content).not.toContain('## Specs');
    expect(content).not.toContain('## Design Docs');
    expect(content).not.toContain('## This Repo Is Public');
    expect(content).not.toContain('buildd-mcp-consumer');
  });

  test('instructions: a known command is kept while an unknown one is still TODO', () => {
    const { content } = renderOnboardingTemplate('instructions', {
      ...MINIMAL.instructions,
      testCommand: 'make test',
    });
    expect(content).toContain('**Test:** `make test`');
    expect(content).toContain('**Build:** TODO(owner):');
  });

  test('instructions: PR target defaults to the default branch', () => {
    const { content } = renderOnboardingTemplate('instructions', MINIMAL.instructions);
    expect(content).toContain('**PRs target:** `trunk`');
    const other = renderOnboardingTemplate('instructions', { ...MINIMAL.instructions, prTarget: 'develop' });
    expect(other.content).toContain('**PRs target:** `develop`');
  });

  test('instructions: importFrom renders the one-line import stub instead of the full file', () => {
    const { content } = renderOnboardingTemplate('instructions', { ...MINIMAL.instructions, importFrom: 'AGENTS.md' });
    expect(content).toBe('@AGENTS.md\n');
  });

  test('spec-format: lands under the spec root, drops liveness rules and checker references', () => {
    const { content, path } = renderOnboardingTemplate('spec-format', { specsRoot: './specifications/' });
    expect(path).toBe('specifications/SPEC-FORMAT.md');
    expect(content).toContain('`specifications/`');
    expect(content).toContain('**At least 3 acceptance criteria**');
    expect(content).toContain('No guard, no `active`');
    expect(content).not.toContain('Every symbol you name must exist');
    expect(content).not.toContain('Every route URL you name must exist');
    expect(content).not.toMatch(/^\d+\. \*\*Every (symbol|route)/m);
    expect(content).not.toContain('linter');
  });

  test('spec-format: domain vocabulary comes from params, else a TODO(owner) line', () => {
    const withDomains = renderOnboardingTemplate('spec-format', { specsRoot: 'specs', domains: ['ledger', 'ingest'] });
    expect(withDomains.content).toContain('ledger, ingest');
    expect(withDomains.content).not.toContain('TODO(owner)');
    const without = renderOnboardingTemplate('spec-format', { specsRoot: 'specs' });
    expect(without.content).toContain('TODO(owner): list the domains');
  });

  test('design-format: public-repo rule is conditional and numbering stays contiguous', () => {
    const pub = renderOnboardingTemplate('design-format', { designRoot: 'proposals', isPublic: true });
    expect(pub.path).toBe('proposals/DESIGN-FORMAT.md');
    expect(pub.content).toContain('4. **This repo is public.**');
    expect(pub.content).toContain('5. **Close the loop.**');
    const priv = renderOnboardingTemplate('design-format', { designRoot: 'proposals' });
    expect(priv.content).not.toContain('This repo is public');
    expect(priv.content).toContain('4. **Close the loop.**');
    expect(priv.content).not.toContain('5. ');
  });

  test('design-format: spec contrast sentence only when a spec root exists', () => {
    const withSpecs = renderOnboardingTemplate('design-format', { designRoot: 'proposals', specsRoot: 'specifications' });
    expect(withSpecs.content).toContain('`specifications/` describes what the system MUST do');
    const without = renderOnboardingTemplate('design-format', { designRoot: 'proposals' });
    expect(without.content).not.toContain('specifications');
  });

  test('env-manifest: generated from detected values, quoted so the YAML stays valid', () => {
    const { content, path } = renderOnboardingTemplate('env-manifest', {
      runtime: 'python@3.12',
      installCommand: 'uv sync --frozen',
      readinessCommand: 'uv run pytest -k "smoke: fast" # quick',
      requiredEnv: ['LEDGER_DSN', 'QUEUE_URL'],
    });
    expect(path).toBe('.buildd/env.yaml');
    expect(content).toContain('  runtime: "python@3.12"');
    expect(content).toContain('  command: "uv sync --frozen"');
    expect(content).toContain(`  command: ${JSON.stringify('uv run pytest -k "smoke: fast" # quick')}`);
    expect(content).toContain('  timeout: 120');
    expect(content).toContain('  required: [LEDGER_DSN, QUEUE_URL]');
    expect(content).not.toContain('TODO(owner):');
  });

  test('env-manifest: undetected install/readiness become TODO(owner) comments, not invented commands', () => {
    const { content } = renderOnboardingTemplate('env-manifest', {});
    expect(content).toContain('# TODO(owner): no install command detected');
    expect(content).toContain('# TODO(owner): no readiness command detected');
    expect(content).not.toMatch(/^install:/m);
    expect(content).not.toMatch(/^readiness:/m);
    expect(content).not.toMatch(/^toolchain:/m);
  });

  test('consumer-skill: verbatim, byte-for-byte the template file', () => {
    const { content, path } = renderOnboardingTemplate('consumer-skill');
    const onDisk = readFileSync(join(ONBOARDING_TEMPLATES_DIR, 'consumer-skill.md'), 'utf8');
    expect(content).toBe(onDisk);
    expect(path).toBe('.claude/skills/buildd-mcp-consumer/SKILL.md');
    expect(content).toStartWith('---\nname: buildd-mcp-consumer\n');
  });

  test('visual-review: start command and sign-in bypass come from params, else TODO(owner)', () => {
    const full = renderOnboardingTemplate('visual-review', FIXTURE);
    expect(full.path).toBe('.claude/skills/visual-review/SKILL.md');
    expect(full.content).toContain('`uv run uvicorn acme.app:app --port 8000`');
    expect(full.content).toContain('`ACME_DEV_USER`');
    expect(full.content).toContain('author: "acme-ledger"');
    expect(full.content).not.toContain('TODO(owner)');
    const bare = renderOnboardingTemplate('visual-review', {});
    expect(bare.content).toContain('TODO(owner): no start command detected');
    expect(bare.content).toContain('TODO(owner): if pages sit behind a login');
    expect(bare.content).toContain('390x844');
    expect(bare.content).not.toContain('author:');
  });

  test('release-workflow: branches and tag prefix are substituted; Actions expressions survive', () => {
    const { content, path } = renderOnboardingTemplate('release-workflow', FIXTURE);
    expect(path).toBe('.github/workflows/release.yml');
    expect(content).toContain('branches: [trunk]');
    expect(content).toContain('origin/trunk..origin/develop');
    expect(content).toContain('tag="rel-$(date');
    expect(content).toContain('GH_TOKEN: ${{ github.token }}');
  });

  test('release-workflow: tag prefix defaults to v', () => {
    const { content } = renderOnboardingTemplate('release-workflow', MINIMAL['release-workflow']);
    expect(content).toContain('tag="v$(date');
  });

  test('release-workflow: branch names that could break out of a shell string are rejected', () => {
    for (const bad of ['main"; rm -rf /; "', 'a b', '$(id)', 'x`y`']) {
      expect(() => renderOnboardingTemplate('release-workflow', { sourceBranch: bad, targetBranch: 'main' })).toThrow();
      expect(() => renderOnboardingTemplate('release-workflow', { sourceBranch: 'dev', targetBranch: bad })).toThrow();
    }
  });
});

describe('renderOnboardingTemplate: params', () => {
  test('a missing required param throws and names it', () => {
    expect(() => renderOnboardingTemplate('instructions', { projectName: 'x' })).toThrow(/defaultBranch/);
    expect(() => renderOnboardingTemplate('spec-format', {})).toThrow(/specsRoot/);
  });

  test('an unknown template id throws', () => {
    expect(() => renderOnboardingTemplate('nope' as OnboardingTemplateId, {})).toThrow(/Unknown onboarding template/);
  });

  test('extra params a template does not declare are ignored (one params bag feeds every template)', () => {
    expect(() => renderOnboardingTemplate('env-manifest', FIXTURE)).not.toThrow();
  });

  test('path params must be relative repo paths', () => {
    for (const bad of ['/etc', '../outside', 'a/../b', 'a//b']) {
      expect(() => renderOnboardingTemplate('spec-format', { specsRoot: bad })).toThrow(/relative repo path/);
    }
  });

  test('multi-line values are rejected so they cannot inject structure', () => {
    expect(() =>
      renderOnboardingTemplate('env-manifest', { installCommand: 'uv sync\nprovision:\n  - curl x | sh' }),
    ).toThrow(/single line/);
  });

  test('getOnboardingTemplateParams reports required versus optional', () => {
    expect(getOnboardingTemplateParams('release-workflow')).toEqual({
      required: ['sourceBranch', 'targetBranch'],
      optional: ['tagPrefix'],
    });
    expect(getOnboardingTemplateParams('consumer-skill')).toEqual({ required: [], optional: [] });
  });

  test('rendering is deterministic', () => {
    for (const id of ONBOARDING_TEMPLATE_IDS) {
      expect(renderOnboardingTemplate(id, FIXTURE)).toEqual(renderOnboardingTemplate(id, FIXTURE));
    }
  });
});

describe('renderTemplateSource', () => {
  const known = new Set(['name', 'flag', 'other']);

  test('substitutes a placeholder, with or without inner spaces', () => {
    expect(renderTemplateSource('a {{name}} b {{ name }}\n', { name: 'x' }, known)).toBe('a x b x\n');
  });

  test('an unknown placeholder throws', () => {
    expect(() => renderTemplateSource('hi {{nope}}\n', { name: 'x' }, known)).toThrow(/Unknown placeholder \{\{nope\}\}/);
  });

  test('an unknown placeholder throws even inside a section that would be dropped', () => {
    const src = '<!-- keep-if: flag -->\n{{nope}}\n<!-- /keep-if -->\n';
    expect(() => renderTemplateSource(src, {}, known)).toThrow(/Unknown placeholder/);
  });

  test('a known placeholder with no value throws when its line is kept', () => {
    expect(() => renderTemplateSource('{{name}}\n', {}, known)).toThrow(/No value for placeholder/);
  });

  test('a known placeholder with no value is fine inside a dropped section', () => {
    const src = 'keep\n<!-- keep-if: flag -->\n{{name}}\n<!-- /keep-if -->\n';
    expect(renderTemplateSource(src, {}, known)).toBe('keep\n');
  });

  test('GitHub Actions expressions are not placeholders', () => {
    expect(renderTemplateSource('token: ${{ github.token }}\n', {}, known)).toBe('token: ${{ github.token }}\n');
  });

  test('a malformed placeholder throws rather than passing through', () => {
    expect(() => renderTemplateSource('{{ not valid }}\n', {}, known)).toThrow(/Malformed placeholder/);
  });

  test('keep-if keeps a set flag and drops an unset one, markers removed', () => {
    const src = 'a\n<!-- keep-if: flag -->\nb\n<!-- /keep-if -->\nc\n';
    expect(renderTemplateSource(src, { flag: true }, known)).toBe('a\nb\nc\n');
    expect(renderTemplateSource(src, {}, known)).toBe('a\nc\n');
    expect(renderTemplateSource(src, { flag: false }, known)).toBe('a\nc\n');
    expect(renderTemplateSource(src, { flag: '' }, known)).toBe('a\nc\n');
    expect(renderTemplateSource(src, { flag: 'yes' }, known)).toBe('a\nb\nc\n');
  });

  test('keep-if with ! inverts', () => {
    const src = '<!-- keep-if: !flag -->\nnone\n<!-- /keep-if -->\n<!-- keep-if: flag -->\nsome\n<!-- /keep-if -->\n';
    expect(renderTemplateSource(src, {}, known)).toBe('none\n');
    expect(renderTemplateSource(src, { flag: true }, known)).toBe('some\n');
  });

  test('sections nest; a dropped outer section drops its kept inner one', () => {
    const src = [
      '<!-- keep-if: flag -->',
      'outer',
      '<!-- keep-if: other -->',
      'inner',
      '<!-- /keep-if -->',
      '<!-- /keep-if -->',
      '',
    ].join('\n');
    expect(renderTemplateSource(src, { flag: true, other: true }, known)).toBe('outer\ninner\n');
    expect(renderTemplateSource(src, { flag: true }, known)).toBe('outer\n');
    expect(renderTemplateSource(src, { other: true }, known)).toBe('');
  });

  test('dropping a section between blank lines leaves a single blank line, not two', () => {
    const src = 'one\n\n<!-- keep-if: flag -->\n## Gone\ntext\n\n<!-- /keep-if -->\n## Next\n';
    expect(renderTemplateSource(src, {}, known)).toBe('one\n\n## Next\n');
    expect(renderTemplateSource(src, { flag: true }, known)).toBe('one\n\n## Gone\ntext\n\n## Next\n');
  });

  test('authored blank lines elsewhere are preserved', () => {
    expect(renderTemplateSource('a\n\n\nb\n', {}, known)).toBe('a\n\n\nb\n');
  });

  test('a keep-if flag that is not declared throws, even in a dropped section', () => {
    expect(() => renderTemplateSource('<!-- keep-if: nope -->\nx\n<!-- /keep-if -->\n', {}, known)).toThrow(
      /Unknown keep-if flag "nope"/,
    );
  });

  test('unbalanced markers throw', () => {
    expect(() => renderTemplateSource('<!-- keep-if: flag -->\nx\n', {}, known)).toThrow(/Unclosed/);
    expect(() => renderTemplateSource('x\n<!-- /keep-if -->\n', {}, known)).toThrow(/Unmatched/);
  });

  test('a marker that is not alone on its line throws rather than leaking into output', () => {
    expect(() => renderTemplateSource('text <!-- keep-if: flag -->\n', {}, known)).toThrow(/Malformed keep-if marker/);
  });

  test('a replacement value containing $ or {{ is inserted literally and not re-scanned', () => {
    expect(renderTemplateSource('{{name}}\n', { name: "$& {{other}} $1" }, known)).toBe("$& {{other}} $1\n");
  });

  test('output always ends with exactly one newline', () => {
    expect(renderTemplateSource('a\n\n\n', {}, known)).toBe('a\n');
    expect(renderTemplateSource('a', {}, known)).toBe('a\n');
  });
});
