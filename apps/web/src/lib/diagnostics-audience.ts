/**
 * Who sees layer-3 diagnostics: gate reason codes, runner scheduling and
 * availability, override flags, exact timings (docs/design/design-system.md
 * §5 rule 18). A team admin sees them on their own team's work (`role` is the
 * viewer's role in the team that owns the work), and so does a platform
 * operator. A member never does.
 *
 * Pure, so a page and a test ask the same question. The page passes the
 * answer to `DiagnosticsAudienceProvider` (components/ui/DiagnosticsDisclosure).
 */
import { roleHas, type TeamRole } from '@/lib/permission-registry';

export function canSeeDiagnostics(viewer: { role: TeamRole | null | undefined; operator: boolean }): boolean {
  return viewer.operator || roleHas(viewer.role, 'view_work_diagnostics');
}
