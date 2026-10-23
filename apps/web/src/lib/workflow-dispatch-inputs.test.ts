import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowDispatchInputs, readWorkflowDispatchInputs, workflowFilePath } from './workflow-dispatch-inputs';

const repoRoot = join(import.meta.dir, '../../../..');

describe('parseWorkflowDispatchInputs', () => {
  it("reads buildd's own release.yml: amend and amend_confirm are declared", () => {
    const yaml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    const inputs = parseWorkflowDispatchInputs(yaml);
    expect(inputs).toContain('amend');
    expect(inputs).toContain('amend_confirm');
    expect(inputs).toEqual(['force', 'dry_run', 'amend', 'amend_confirm', 'exclude', 'exclude_confirm']);
    // Agrees with Bun's own YAML parser on the real file.
    const parsed = Bun.YAML.parse(yaml) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } };
    expect(inputs).toEqual(Object.keys(parsed.on.workflow_dispatch.inputs));
  });

  it('reads input keys only, not their nested fields or block scalars', () => {
    const yaml = `name: Ship
"on":
  push:
    branches: [main]
  workflow_dispatch:
    # what to ship
    inputs:
      version:
        description: |
          The version.
          type: not-a-key
        required: true
      'confirm': # typed twice
        type: string
jobs:
  ship:
    runs-on: ubuntu-latest
`;
    expect(parseWorkflowDispatchInputs(yaml)).toEqual(['version', 'confirm']);
  });

  it('a dispatch trigger with no inputs is [], no dispatch trigger is null', () => {
    expect(parseWorkflowDispatchInputs('on: workflow_dispatch\njobs: {}\n')).toEqual([]);
    expect(parseWorkflowDispatchInputs('on: [push, workflow_dispatch]\n')).toEqual([]);
    expect(parseWorkflowDispatchInputs('on:\n  workflow_dispatch:\n  push:\n')).toEqual([]);
    expect(parseWorkflowDispatchInputs('on:\n  workflow_dispatch: {}\n')).toEqual([]);
    expect(parseWorkflowDispatchInputs('on: push\n')).toBeNull();
    expect(parseWorkflowDispatchInputs('on:\n  push:\n    branches: [main]\n')).toBeNull();
    expect(parseWorkflowDispatchInputs('name: x\n')).toBeNull();
  });

  it('does not take a nested `on:` or a job named workflow_dispatch for the trigger', () => {
    const yaml = 'on:\n  push:\n    workflow_dispatch:\n      inputs:\n        amend: {}\n';
    expect(parseWorkflowDispatchInputs(yaml)).toBeNull();
  });
});

describe('readWorkflowDispatchInputs', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('reads the file at the ref from .github/workflows', async () => {
    const calls: string[] = [];
    const gh: any = async (_i: number, path: string) => {
      calls.push(path);
      return { content: b64('on:\n  workflow_dispatch:\n    inputs:\n      amend: {}\n') };
    };
    const out = await readWorkflowDispatchInputs({ installationId: 1, repoFullName: 'o/r', workflowFile: 'release.yml', ref: 'dev' }, gh);
    expect(out).toEqual({ ok: true, inputs: ['amend'], path: '.github/workflows/release.yml' });
    expect(calls).toEqual(['/repos/o/r/contents/.github/workflows/release.yml?ref=dev']);
  });

  it('a missing file or a GitHub error is a read failure, not "no inputs"', async () => {
    const missing: any = async () => null;
    const boom: any = async () => { throw new Error('404'); };
    const p = { installationId: 1, repoFullName: 'o/r', workflowFile: 'release.yml', ref: 'dev' };
    expect((await readWorkflowDispatchInputs(p, missing)).ok).toBe(false);
    expect((await readWorkflowDispatchInputs(p, boom)).ok).toBe(false);
    expect((await readWorkflowDispatchInputs({ ...p, workflowFile: '12345' }, missing)).ok).toBe(false);
  });

  it('workflowFilePath keeps a full path and prefixes a bare name', () => {
    expect(workflowFilePath('release.yml')).toBe('.github/workflows/release.yml');
    expect(workflowFilePath('.github/workflows/ship.yaml')).toBe('.github/workflows/ship.yaml');
  });
});
