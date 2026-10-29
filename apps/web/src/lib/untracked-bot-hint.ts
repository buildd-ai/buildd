/**
 * Said wherever buildd answers "I do not have that PR" or lists the PRs it has: dependency-bot
 * PRs are not adopted on their own (see the top of this file), so a missing one is not an error.
 */
export const DEPENDENCY_BOT_UNTRACKED_HINT =
  'buildd tracks PRs it opened or adopted. A dependency bot\'s PR (Renovate, Dependabot) is not adopted automatically; request_pr_review adopts it, after which it is listed and readable like any other.';
