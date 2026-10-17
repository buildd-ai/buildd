import { githubApi } from '@/lib/github';
import { findInstructionLeaks } from '@buildd/core/agent-instruction-leak';

/**
 * Files in head...base whose diff adds the runner's injected instruction block.
 * Fails open (empty) when GitHub cannot answer; CI is the backstop.
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
