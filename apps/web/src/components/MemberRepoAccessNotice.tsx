import Link from 'next/link';
import {
  linkGitHubUrl,
  memberRepoAccessMessage,
  type MemberRepoAccessResult,
} from '@/lib/member-repo-access-shared';

/**
 * One line telling a member why the workspace's GitHub repo check refused
 * them, with a "Link GitHub" action when the fix is linking an account.
 * Renders nothing when access is allowed.
 */
export default function MemberRepoAccessNotice({ result, returnTo }: { result: MemberRepoAccessResult; returnTo: string }) {
  const message = memberRepoAccessMessage(result);
  if (!message) return null;
  return (
    <div className="notice notice-err flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="member-repo-access-notice">
      <span>{message}</span>
      {result.reason === 'no_github_link' && (
        <Link href={linkGitHubUrl(returnTo)} className="underline font-medium min-h-11 md:min-h-0 inline-flex items-center">
          Link GitHub
        </Link>
      )}
    </div>
  );
}
