/**
 * The server's half of Quality Scout's UI/surface capture port: the
 * `VisualQaActions` over the workspace's GitHub App installation. The port
 * itself (dispatch `visual-qa.yml`, tie the run to the candidate commit, read
 * `captures.json`) lives in @buildd/core/quality-scout/visual-capture, shared
 * with the runner host, which builds its actions over a run-scoped token
 * instead. Re-exported here so existing callers keep their import.
 */
import { getInstallationToken, githubApi } from '@/lib/github';
import {
  readZipEntry,
  toRun,
  VISUAL_QA_WORKFLOW_FILE,
  type RawRun,
  type VisualQaActions,
} from '@buildd/core/quality-scout/visual-capture';

export {
  captureRecordsToShots,
  createVisualQaCapturePort,
  DEFAULT_CAPTURE_TIMEOUT_MS,
  readZipEntry,
  resolveScoutCapturePort,
  VISUAL_QA_ARTIFACT,
  VISUAL_QA_CAPTURES_FILE,
  VISUAL_QA_WORKFLOW_FILE,
  type ScoutCapturePort,
  type ScoutCapturePortResolution,
  type VisualQaActions,
  type VisualQaCapturePortOptions,
  type VisualQaCaptureRecord,
  type VisualQaRun,
} from '@buildd/core/quality-scout/visual-capture';

/** `VisualQaActions` over the workspace's GitHub App installation. */
export function githubVisualQaActions(installationId: number, repoFullName: string): VisualQaActions {
  const repo = `/repos/${repoFullName}`;
  const workflow = `${repo}/actions/workflows/${encodeURIComponent(VISUAL_QA_WORKFLOW_FILE)}`;
  return {
    repoFullName,
    async workflowExists() {
      try {
        await githubApi(installationId, workflow);
        return true;
      } catch (err) {
        if (/GitHub API error: 404\b/.test(err instanceof Error ? err.message : String(err))) return false;
        throw err;
      }
    },
    async dispatch(ref, inputs) {
      await githubApi(installationId, `${workflow}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, inputs }),
      });
    },
    async listDispatchRuns(ref) {
      const data = await githubApi(installationId, `${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`);
      return ((data?.workflow_runs ?? []) as RawRun[]).map(toRun);
    },
    async getRun(runId) {
      return toRun(await githubApi(installationId, `${repo}/actions/runs/${runId}`) as RawRun);
    },
    async readArtifactFile(runId, artifactName, path) {
      const data = await githubApi(installationId, `${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifactName)}`);
      const artifact = ((data?.artifacts ?? []) as Array<{ id: number; name: string; expired: boolean }>)
        .find((a) => a.name === artifactName && !a.expired);
      if (!artifact) return null;
      // The zip endpoint redirects to blob storage; fetch drops the token on the cross-origin hop.
      const token = await getInstallationToken(installationId);
      const res = await fetch(`https://api.github.com${repo}/actions/artifacts/${artifact.id}/zip`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new Error(`GitHub API error: ${res.status} reading artifact ${artifactName}`);
      const entry = readZipEntry(new Uint8Array(await res.arrayBuffer()), path);
      return entry ? new TextDecoder().decode(entry) : null;
    },
  };
}
