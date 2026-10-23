/**
 * Storage stub for Visual QA.
 *
 * The QA app runs against a scrubbed database clone with no object storage, so
 * a design artifact page shows "Preview unavailable" instead of its frame. This
 * serves one synthetic design for any object key, so the app (started with
 * STORAGE_ENDPOINT pointed here and placeholder keys) signs a URL, reads the
 * file for its screens and frames it. The file is a fixture: no stored bytes
 * from the clone are involved.
 *
 *   QA_STORAGE_STUB_PORT=9100 bun scripts/qa/storage-stub.ts
 *
 * The page shown is chosen by the URL fragment, like a real design does.
 */

export const STUB_SCREENS = [
  { id: 'phone-mission', name: 'Phone mission', width: 390, height: 844 },
  { id: 'desktop-mission', name: 'Desktop mission', width: 1440, height: 900 },
] as const;

export function stubDesignHtml(): string {
  const sections = STUB_SCREENS.map(
    (s) =>
      `<section data-screen="${s.id}" data-viewport="${s.width}x${s.height}" style="width:${s.width}px;height:${s.height}px"><h1>${s.name}</h1><p>Synthetic QA design screen</p></section>`,
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>QA design</title>
<style>body{margin:0;font-family:sans-serif;background:#fff;color:#111}section{display:none;box-sizing:border-box;padding:24px;background:#eef2ff}section.on{display:block}</style>
</head><body>
${sections}
<script>
function show(){var id=decodeURIComponent(location.hash.slice(1))||'${STUB_SCREENS[0].id}';
var all=document.querySelectorAll('section[data-screen]');var hit=false;
all.forEach(function(s){var on=s.getAttribute('data-screen')===id;s.classList.toggle('on',on);hit=hit||on});
if(!hit&&all[0])all[0].classList.add('on')}
addEventListener('hashchange',show);show();
</script></body></html>`;
}

export function startStorageStub(port: number) {
  const body = stubDesignHtml();
  return Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('read only', { status: 405 });
      return new Response(req.method === 'HEAD' ? null : body, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-store',
        },
      });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.QA_STORAGE_STUB_PORT || 9100);
  startStorageStub(port);
  console.log(`[storage-stub] listening on ${port}`);
  await new Promise(() => {});
}
