import { redirect } from 'next/navigation';

/**
 * Nothing in the app links here any more — workers are viewed on the task
 * they ran (/app/tasks/[id]). The old page loaded every worker the user's
 * workspaces had ever run, with task and account joins, on each visit. Keep
 * the route as a redirect so old bookmarks land somewhere useful.
 */
export default async function WorkersPage(): Promise<never> {
  redirect('/app/tasks');
}
