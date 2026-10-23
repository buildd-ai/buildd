/**
 * Dev fixture: a sample design file in the shape agents produce (mission
 * "Designs in buildd"): one HTML page, every screen a
 * `section[data-screen=<id>][data-viewport=WxH]`, and a hash router that shows
 * the screen named by `#<id>` at its size, or lists them all with no hash.
 *
 * Framed by `/app/dev/fixtures?state=design-preview` (DesignPreviewFixture.tsx)
 * the way the artifact page frames a real design: `sandbox="allow-scripts"`,
 * so this document runs in an opaque origin even though it is served from
 * buildd's own host. Static markup, no data, nothing to submit.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

interface Screen { id: string; name: string; w: number; h: number; tone: string }

const SCREENS: Screen[] = [
  { id: 'phone-mission', name: 'Mission (phone)', w: 390, h: 844, tone: 'rgb(232 217 197)' },
  { id: 'phone-task-running', name: 'Task running (phone)', w: 390, h: 844, tone: 'rgb(217 227 232)' },
  { id: 'phone-approval', name: 'Approval (phone)', w: 390, h: 844, tone: 'rgb(227 232 217)' },
  { id: 'desktop-home', name: 'Home (desktop)', w: 1440, h: 900, tone: 'rgb(232 224 217)' },
  { id: 'desktop-mission', name: 'Mission (desktop)', w: 1440, h: 900, tone: 'rgb(217 232 225)' },
  { id: 'desktop-task-running', name: 'Task running (desktop)', w: 1440, h: 900, tone: 'rgb(232 217 228)' },
  { id: 'coverage', name: 'Coverage', w: 1200, h: 700, tone: 'rgb(229 229 229)' },
];

function screenMarkup(s: Screen): string {
  const rows = Array.from({ length: s.w > 800 ? 6 : 4 }, (_, i) =>
    `<div class="row"><span class="dot"></span><span class="bar" style="width:${38 + ((i * 17) % 40)}%"></span></div>`).join('');
  return `
<section data-screen="${s.id}" data-viewport="${s.w}x${s.h}" data-name="${s.name}" style="width:${s.w}px;height:${s.h}px;background:${s.tone}">
  <header><strong>${s.name}</strong><span>${s.w}×${s.h}</span></header>
  <div class="frame">${rows}</div>
  <footer>Sample design · screen <code>${s.id}</code></footer>
</section>`;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sample design</title>
<style>
  html, body { margin: 0; background: rgb(243 240 234); color: rgb(42 37 34); font: 14px/1.4 system-ui, sans-serif; }
  section { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; padding: 24px; }
  section header { display: flex; justify-content: space-between; font-size: 16px; }
  section header span { color: rgb(107 98 90); }
  .frame { flex: 1; background: rgba(255,255,255,0.7); border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; align-items: center; gap: 12px; }
  .dot { width: 14px; height: 14px; border-radius: 50%; background: rgb(200 116 74); flex: none; }
  .bar { height: 12px; border-radius: 6px; background: rgba(0,0,0,0.12); }
  footer { color: rgb(107 98 90); font-size: 12px; }
  body.list section { margin: 24px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.12); }
  body.one { overflow: hidden; }
  body.one section { display: none; }
  body.one section.shown { display: flex; }
</style>
</head>
<body>
${SCREENS.map(screenMarkup).join('\n')}
<script>
  (function () {
    function route() {
      var id = decodeURIComponent(location.hash.replace(/^#/, ''));
      var all = document.querySelectorAll('section[data-screen]');
      var hit = null;
      for (var i = 0; i < all.length; i++) {
        all[i].classList.remove('shown');
        if (all[i].getAttribute('data-screen') === id) hit = all[i];
      }
      document.body.className = hit ? 'one' : 'list';
      if (hit) hit.classList.add('shown');
    }
    window.addEventListener('hashchange', route);
    route();
  })();
</script>
</body>
</html>
`;

export function GET() {
  return new NextResponse(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
