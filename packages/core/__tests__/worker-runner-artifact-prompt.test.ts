import { describe, expect, test } from 'bun:test';
import { artifactTemplates } from '../artifact-templates';

/**
 * Mirrors the output requirement section of WorkerRunner.buildPrompt()
 * to verify artifact template injection logic.
 */
function buildOutputRequirementSection(outputRequirement: string): string {
  const outputContext: string[] = ['\n## Output Requirement'];
  if (outputRequirement === 'pr_required') {
    outputContext.push('This task **requires a PR**. Make your changes, commit, push, and create a PR before completing.');
  } else if (outputRequirement === 'artifact_required') {
    outputContext.push('This task **requires you to create an artifact** as a deliverable. Use the `create_artifact` tool before completing the task.\n');
    outputContext.push('Available artifact templates:');
    for (const [name, tpl] of Object.entries(artifactTemplates)) {
      const props = (tpl.schema as any).properties || {};
      const fields = Object.keys(props).join(', ');
      outputContext.push(`- **${name}** (${tpl.description}): { ${fields} }`);
    }
    outputContext.push('\nChoose the template that best fits your deliverable, or create a custom artifact with type and structured content.');
  } else if (outputRequirement === 'none') {
    outputContext.push('This task has **no output requirement**. Complete with a summary — no commits, PRs, or artifacts needed unless the work calls for it.');
  } else {
    outputContext.push('Output: **auto** — if you make commits, create a PR or artifact. If no code changes needed, just complete with a summary.');
  }
  return outputContext.join('\n');
}

describe('WorkerRunner artifact template injection', () => {
  test('injects artifact templates when outputRequirement is artifact_required', () => {
    const result = buildOutputRequirementSection('artifact_required');

    expect(result).toContain('requires you to create an artifact');
    expect(result).toContain('create_artifact');
    expect(result).toContain('Available artifact templates:');

    // Verify all 4 template names are present
    expect(result).toContain('research_report');
    expect(result).toContain('decision_recommendation');
    expect(result).toContain('content_draft');
    expect(result).toContain('monitoring_alert');

    // Verify schema fields are listed
    expect(result).toContain('findings');
    expect(result).toContain('summary');
    expect(result).toContain('options');
    expect(result).toContain('recommendation');
    expect(result).toContain('severity');
  });

  test('does NOT inject templates when outputRequirement is auto', () => {
    const result = buildOutputRequirementSection('auto');

    expect(result).not.toContain('artifact templates');
    expect(result).not.toContain('research_report');
    expect(result).toContain('auto');
  });

  test('does NOT inject templates when outputRequirement is none', () => {
    const result = buildOutputRequirementSection('none');

    expect(result).not.toContain('artifact templates');
    expect(result).not.toContain('research_report');
    expect(result).toContain('no output requirement');
  });

  test('does NOT inject templates when outputRequirement is pr_required', () => {
    const result = buildOutputRequirementSection('pr_required');

    expect(result).not.toContain('artifact templates');
    expect(result).not.toContain('research_report');
    expect(result).toContain('requires a PR');
  });

  test('includes template descriptions from artifact-templates.ts', () => {
    const result = buildOutputRequirementSection('artifact_required');

    // Verify descriptions from the actual templates are included
    for (const [, tpl] of Object.entries(artifactTemplates)) {
      expect(result).toContain(tpl.description);
    }
  });
});
