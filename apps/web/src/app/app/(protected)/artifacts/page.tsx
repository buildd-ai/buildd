import { redirect } from 'next/navigation';

/**
 * The artifacts list is retired (owner decision 2026-10-09): artifacts live
 * where their work is, on the mission's Records and the task page. Old links
 * land on Missions; a single artifact still opens at /app/artifacts/<id>.
 */
export default function ArtifactsPage(): never {
  redirect('/app/missions');
}
