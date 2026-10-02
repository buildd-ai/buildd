import { setTuningTokenProvider } from '@buildd/core/tuning';

export { getTuning, loadTuningBundle, getTuningDiagnostics } from '@buildd/core/tuning';
export { clampedInt, clampedNumber, markdownPrompt } from '@buildd/core/tuning';

/**
 * How the private tuning source is read: through the GitHub App installation
 * that already covers the repo. Tuning is config, not a secret, so there is no
 * credential row — only a token minted per fetch.
 */
export async function tuningInstallationToken(repoFullName: string): Promise<string | null> {
  const { installationIdForRepo } = await import('@/lib/workspace-installation');
  const installationId = await installationIdForRepo(repoFullName);
  if (installationId === null) return null;
  const { getInstallationToken } = await import('@/lib/github');
  return getInstallationToken(installationId);
}

setTuningTokenProvider(tuningInstallationToken);
