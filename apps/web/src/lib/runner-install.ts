/**
 * The one install-and-connect instruction for the buildd runner.
 *
 * Every screen that tells someone how to start a runner renders these lines
 * (via `components/RunnerInstallSteps`) instead of typing its own. They match
 * the install block on buildd.dev and the closing output of
 * `apps/runner/install.sh`:
 *
 *   1. the one-line installer (buildd.dev/install.sh redirects to the script),
 *   2. reload the shell: the installer adds ~/.local/bin to the shell rc, but
 *      that export only applies inside the piped installer's own subshell, so
 *      `buildd` is not on PATH in the terminal that ran the one-liner,
 *   3. bare `buildd`, which serves the local UI where the account is connected.
 *
 * `buildd login --device` exists for a machine with no browser; it is the
 * headless exception, not the main path. There is no `buildd run`.
 */
export const RUNNER_INSTALL_COMMANDS = [
  'curl -fsSL https://buildd.dev/install.sh | bash',
  'exec $SHELL',
  'buildd',
] as const;

/** Where bare `buildd` serves the page that connects the account. */
export const RUNNER_LOCAL_UI_URL = 'http://localhost:8766';

/** For a server with no browser: log in from the terminal before `buildd`. */
export const RUNNER_HEADLESS_LOGIN = 'buildd login --device';
