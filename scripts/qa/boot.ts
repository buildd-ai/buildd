/**
 * A route whose document response is 5xx, or whose page threw a module-load
 * error, did not boot: the shot is a blank page, not a visual finding.
 */
const MODULE_LOAD_ERROR = /Failed to load external module|Cannot find module|Failed to fetch dynamically imported module|Loading chunk .* failed/i;

export function isModuleLoadError(message: string): boolean {
  return MODULE_LOAD_ERROR.test(message);
}

export function bootFailure(status: number | null, moduleErrors: string[]): string | null {
  if (status !== null && status >= 500) return `document response was HTTP ${status}`;
  if (moduleErrors.length > 0) return `module-load page error: ${moduleErrors[0].slice(0, 200)}`;
  return null;
}
