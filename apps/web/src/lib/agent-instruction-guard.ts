import { githubApi } from '@/lib/github';
import { findInstructionLeaks } from '@buildd/core/agent-instruction-leak';

/**
 * Files in head...base whose diff adds the runner's injected instruction block.
 * Fails open (empty) when GitHub cannot answer. The backstop is the CI step
 * scripts/check-no-agent-instructions.sh (no-prod-data.yml), which also covers
 * pushes to an already-open PR; this guard only runs at PR creation.
 */
export async function findLeakedInstructionFiles(
  installationId: number,
  repoFullName: string,
  base: string,
  head: string,
): Promise<string[]> {
  try {
    const cmp = await githubApi(installationId, `/repos/${repoFullName}/compare/${base}...${head}?per_page=100`);
    return findInstructionLeaks(Array.isArray(cmp?.files) ? cmp.files : []);
  } catch {
    return [];
  }
}
