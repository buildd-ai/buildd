import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { consentTeamsForUser, listUserConnections } from '@/lib/mcp-grant-admin';
import SettingsPage from '../_components/SettingsPage';
import ConnectionsSection from './ConnectionsSection';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connected apps: the person's own MCP connections to buildd
 * (lib/mcp-grant-admin.ts). Personal, not team-scoped: a connection can span
 * every team the person is on, so it is read for the signed-in user only.
 */
export default async function ConnectionsSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  const [{ connections, legacy }, teams] = await Promise.all([
    listUserConnections(user.id),
    consentTeamsForUser(user.id),
  ]);
  return (
    <SettingsPage
      title="Connected apps"
      description="Apps you connected to buildd over MCP. Each one reaches only the workspaces you chose, and only while you are on their team. Changes apply on the app's next request."
    >
      <ConnectionsSection initial={{ connections, legacy, teams }} />
    </SettingsPage>
  );
}
