import type { Summary } from './types';

export function renderMarkdown(s: Summary): string {
  return [
    '# Log digest',
    `- total: ${s.total}`,
    `- INFO: ${s.byLevel.INFO}`,
    `- WARN: ${s.byLevel.WARN}`,
    `- ERROR: ${s.byLevel.ERROR}`,
    `- errors in the last 24h: ${s.recentErrors}`,
    `Services with errors: ${s.errorServices.length ? s.errorServices.join(', ') : 'none'}`,
    '',
  ].join('\n');
}
