/**
 * Renders the workspace-onboarding templates in `onboarding-templates/`.
 *
 * Template syntax (docs/design/workspace-onboarding.md section 3):
 *   - `{{name}}` is replaced by the param `name`. A placeholder that is not a
 *     declared param of the template throws; a declared one with no value throws.
 *     `${{ ... }}` (a GitHub Actions expression) is never a placeholder.
 *   - A line holding only `<!-- keep-if: flag -->` opens a section that is kept
 *     when `flag` is set (`true` or a non-empty string) and dropped otherwise;
 *     `<!-- keep-if: !flag -->` inverts it; `<!-- /keep-if -->` closes it.
 *     Sections nest. Marker lines never reach the output.
 *
 * Templates are derived from buildd's own files but are separate files, so
 * editing buildd's CLAUDE.md never changes what another repo receives. Where a
 * command is unknown the output carries a `TODO(owner)` line, never a guess.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OnboardingTemplateId =
  | 'instructions'
  | 'spec-format'
  | 'design-format'
  | 'env-manifest'
  | 'consumer-skill'
  | 'visual-review'
  | 'release-workflow';

export type OnboardingParamValue = string | number | boolean | string[] | null | undefined;
export type OnboardingParams = Record<string, OnboardingParamValue>;

export interface RenderedOnboardingTemplate {
  templateId: OnboardingTemplateId;
  /** Repo-relative path the rendered content is meant to be written to. */
  path: string;
  content: string;
}

export interface RenderOptions {
  /** Test seam: read a template file by name instead of from `onboarding-templates/`. */
  readTemplate?: (file: string) => string;
}

type Normalized = Record<string, string | boolean>;

interface ParamDef {
  required?: boolean;
  /** Relative repo path: no leading `/`, no `..`, trailing `/` and leading `./` stripped. */
  path?: boolean;
  /** Every string value (each array item) must match. */
  pattern?: RegExp;
}

interface TemplateDef {
  file: string;
  /** Returned as-is: no placeholders, no sections. */
  verbatim?: boolean;
  params: Record<string, ParamDef>;
  /** Extra names usable in the template, computed from the normalized params. */
  derive?: (p: Normalized) => Record<string, string>;
  path: (p: Normalized) => string;
}

export const ONBOARDING_TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'onboarding-templates',
);

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;

function todoCommand(label: string, value: string | boolean | undefined): string {
  return typeof value === 'string' && value
    ? `\`${value}\``
    : `TODO(owner): no ${label} command detected, ask before guessing`;
}

const str = (v: string | boolean | undefined): string => (typeof v === 'string' ? v : '');

const TEMPLATES: Record<OnboardingTemplateId, TemplateDef> = {
  instructions: {
    file: 'instructions.md',
    params: {
      projectName: { required: true },
      defaultBranch: { required: true, pattern: BRANCH },
      prTarget: { pattern: BRANCH },
      installCommand: {},
      testCommand: {},
      typecheckCommand: {},
      buildCommand: {},
      testDir: { path: true },
      migrationsDir: { path: true },
      specsRoot: { path: true },
      designRoot: { path: true },
      isPublic: {},
      consumerSkill: {},
      importFrom: { path: true },
    },
    derive: (p) => ({
      prTarget: str(p.prTarget) || str(p.defaultBranch),
      installCommandMd: todoCommand('install', p.installCommand),
      testCommandMd: todoCommand('test', p.testCommand),
      typecheckCommandMd: todoCommand('typecheck', p.typecheckCommand),
      buildCommandMd: todoCommand('build', p.buildCommand),
    }),
    path: () => 'CLAUDE.md',
  },
  'spec-format': {
    file: 'spec-format.md',
    params: {
      specsRoot: { required: true, path: true },
      domains: {},
    },
    path: (p) => `${str(p.specsRoot)}/SPEC-FORMAT.md`,
  },
  'design-format': {
    file: 'design-format.md',
    params: {
      designRoot: { required: true, path: true },
      specsRoot: { path: true },
      isPublic: {},
    },
    path: (p) => `${str(p.designRoot)}/DESIGN-FORMAT.md`,
  },
  'env-manifest': {
    file: 'env-manifest.yaml',
    params: {
      runtime: {},
      installCommand: {},
      readinessCommand: {},
      readinessTimeout: { pattern: /^\d{1,4}$/ },
      requiredEnv: { pattern: ENV_VAR },
    },
    derive: (p) => ({
      runtimeYaml: JSON.stringify(str(p.runtime)),
      installCommandYaml: JSON.stringify(str(p.installCommand)),
      readinessCommandYaml: JSON.stringify(str(p.readinessCommand)),
      readinessTimeout: str(p.readinessTimeout) || '120',
    }),
    path: () => '.buildd/env.yaml',
  },
  'consumer-skill': {
    file: 'consumer-skill.md',
    verbatim: true,
    params: {},
    path: () => '.claude/skills/buildd-mcp-consumer/SKILL.md',
  },
  'visual-review': {
    file: 'visual-review.md',
    params: {
      projectName: {},
      startCommand: {},
      devAuthEnvVar: { pattern: ENV_VAR },
      phoneViewport: { pattern: /^\d{2,4}x\d{2,4}$/ },
    },
    derive: (p) => ({
      projectNameYaml: JSON.stringify(str(p.projectName)),
      phoneViewport: str(p.phoneViewport) || '390x844',
    }),
    path: () => '.claude/skills/visual-review/SKILL.md',
  },
  'release-workflow': {
    file: 'release-workflow.yml',
    params: {
      sourceBranch: { required: true, pattern: BRANCH },
      targetBranch: { required: true, pattern: BRANCH },
      tagPrefix: { pattern: /^[A-Za-z0-9._-]+$/ },
    },
    derive: (p) => ({ tagPrefix: str(p.tagPrefix) || 'v' }),
    path: () => '.github/workflows/release.yml',
  },
};

export const ONBOARDING_TEMPLATE_IDS = Object.keys(TEMPLATES) as OnboardingTemplateId[];

export function getOnboardingTemplateParams(id: OnboardingTemplateId): {
  required: string[];
  optional: string[];
} {
  const def = templateDef(id);
  const names = Object.keys(def.params);
  return {
    required: names.filter((n) => def.params[n].required),
    optional: names.filter((n) => !def.params[n].required),
  };
}

function templateDef(id: string): TemplateDef {
  const def = (TEMPLATES as Record<string, TemplateDef | undefined>)[id];
  if (!def) throw new Error(`Unknown onboarding template: ${id}`);
  return def;
}

function normalizePath(name: string, raw: string): string {
  const p = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!p || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error(`Param ${name} must be a relative repo path, got ${JSON.stringify(raw)}`);
  }
  return p;
}

function normalizeParams(templateId: string, def: TemplateDef, params: OnboardingParams): Normalized {
  const out: Normalized = {};
  for (const [name, spec] of Object.entries(def.params)) {
    const raw = params[name];
    let value: string | boolean | undefined;
    if (raw === undefined || raw === null) value = undefined;
    else if (typeof raw === 'boolean') value = raw;
    else if (Array.isArray(raw)) {
      const items = raw.map((s) => String(s).trim()).filter(Boolean);
      for (const item of items) checkString(name, item, spec);
      value = items.length ? items.join(', ') : undefined;
    } else {
      let s = String(raw).trim();
      if (s) {
        if (spec.path) s = normalizePath(name, s);
        checkString(name, s, spec);
      }
      value = s || undefined;
    }
    if (value === undefined) {
      if (spec.required) throw new Error(`Template ${templateId} requires param ${name}`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

function checkString(name: string, value: string, spec: ParamDef): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Param ${name} must be a single line without control characters`);
  }
  if (spec.pattern && !spec.pattern.test(value)) {
    throw new Error(`Param ${name} has an invalid value: ${JSON.stringify(value)}`);
  }
}

const OPEN_MARKER = /^\s*<!--\s*keep-if:\s*(!?)([A-Za-z_]\w*)\s*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/keep-if\s*-->\s*$/;
const ANY_MARKER = /<!--\s*\/?keep-if/;
const PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;
const STRAY_BRACES = /(?<!\$)\{\{/;

const isSet = (v: string | boolean | undefined): boolean => v === true || (typeof v === 'string' && v !== '');

/**
 * Renders template source text. `known` is every name the source may use as a
 * placeholder or keep-if flag; `values` holds those that are set. Validation
 * covers the whole source, including sections that end up dropped, so a typo
 * can never hide behind an unmet flag.
 */
export function renderTemplateSource(
  source: string,
  values: Record<string, string | boolean | undefined>,
  known: ReadonlySet<string>,
): string {
  const lines = source.split('\n');
  const parsed: Array<
    | { kind: 'open'; flag: string; negate: boolean }
    | { kind: 'close' }
    | { kind: 'text'; text: string }
  > = [];
  let depth = 0;

  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    const open = OPEN_MARKER.exec(line);
    if (open) {
      if (!known.has(open[2])) throw new Error(`Unknown keep-if flag "${open[2]}" at ${at}`);
      depth++;
      parsed.push({ kind: 'open', flag: open[2], negate: open[1] === '!' });
      return;
    }
    if (CLOSE_MARKER.test(line)) {
      if (depth === 0) throw new Error(`Unmatched <!-- /keep-if --> at ${at}`);
      depth--;
      parsed.push({ kind: 'close' });
      return;
    }
    if (ANY_MARKER.test(line)) throw new Error(`Malformed keep-if marker at ${at}: ${line.trim()}`);
    for (const m of line.matchAll(PLACEHOLDER)) {
      if (!known.has(m[1])) throw new Error(`Unknown placeholder {{${m[1]}}} at ${at}`);
    }
    if (STRAY_BRACES.test(line.replace(PLACEHOLDER, ''))) {
      throw new Error(`Malformed placeholder at ${at}: ${line.trim()}`);
    }
    parsed.push({ kind: 'text', text: line });
  });
  if (depth !== 0) throw new Error('Unclosed <!-- keep-if --> section');

  const out: string[] = [];
  const stack: boolean[] = [];
  let droppedSinceText = false;

  for (const entry of parsed) {
    if (entry.kind === 'open') {
      const kept = isSet(values[entry.flag]) !== entry.negate;
      if (!kept && stack.every(Boolean)) droppedSinceText = true;
      stack.push(kept);
      continue;
    }
    if (entry.kind === 'close') {
      stack.pop();
      continue;
    }
    if (!stack.every(Boolean)) continue;
    const text = entry.text.replace(PLACEHOLDER, (_m, name: string) => {
      const v = values[name];
      if (v === undefined) throw new Error(`No value for placeholder {{${name}}}`);
      return String(v);
    });
    if (text.trim() === '') {
      if (droppedSinceText && out.length > 0 && out[out.length - 1].trim() === '') continue;
    } else {
      droppedSinceText = false;
    }
    out.push(text);
  }

  const body = out.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return body === '' ? '' : `${body}\n`;
}

export function renderOnboardingTemplate(
  templateId: OnboardingTemplateId,
  params: OnboardingParams = {},
  options: RenderOptions = {},
): RenderedOnboardingTemplate {
  const def = templateDef(templateId);
  const read = options.readTemplate ?? ((file: string) => readFileSync(join(ONBOARDING_TEMPLATES_DIR, file), 'utf8'));
  const normalized = normalizeParams(templateId, def, params);
  const path = def.path(normalized);
  const source = read(def.file);
  if (def.verbatim) return { templateId, path, content: source };

  const values: Record<string, string | boolean | undefined> = { ...normalized, ...def.derive?.(normalized) };
  const known = new Set([...Object.keys(def.params), ...Object.keys(def.derive?.({}) ?? {})]);
  return { templateId, path, content: renderTemplateSource(source, values, known) };
}
