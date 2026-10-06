/**
 * render-invoice-table-shots.ts — before/after phone screenshots of the
 * fictional Harborline invoices list, for the invoice-phone demo story (v7).
 *
 *   bun run scripts/demo/stories/shots/render-invoice-table-shots.ts
 *   → scripts/demo/stories/shots/invoices-list-mobile-{before,after}.png
 *     (then re-run build-invoice-phone.py)
 *
 * Harborline does not exist; these are mockups drawn from the HTML below at the
 * phone viewport the visual auditor captures (390 wide at 2x). "before" is the
 * real failure the story is about: the page lays out a 7-column table at its
 * desktop width, so on a 390px screen the table runs off the right edge and
 * the Due, Tax, Total and Status columns are cut off. "after" is the fix:
 * each invoice stacks as a card, and the Tax column, empty for every invoice
 * on this account, is hidden. Every name and number is fictional.
 */
import { chromium } from 'playwright';
import { join } from 'path';

const OUT = new URL('.', import.meta.url).pathname;

const ROWS = [
  { no: 'INV-2026-0431', customer: 'Kestrel Outfitters', issued: '01 Oct', due: '31 Oct', total: '$4,120.00', status: 'Open' },
  { no: 'INV-2026-0430', customer: 'Mori Design Studio', issued: '30 Sep', due: '30 Oct', total: '$1,860.50', status: 'Paid' },
  { no: 'INV-2026-0429', customer: 'Tern Logistics', issued: '28 Sep', due: '28 Oct', total: '$9,302.75', status: 'Open' },
  { no: 'INV-2026-0428', customer: 'Alder & Pike Ltd', issued: '25 Sep', due: '25 Oct', total: '$615.00', status: 'Overdue' },
  { no: 'INV-2026-0427', customer: 'Bluewake Charters', issued: '22 Sep', due: '22 Oct', total: '$2,748.20', status: 'Paid' },
  { no: 'INV-2026-0426', customer: 'Northbay Marine', issued: '19 Sep', due: '19 Oct', total: '$12,040.00', status: 'Paid' },
];

const CSS = `
*{box-sizing:border-box;margin:0}
body{font:14px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;color:#1d2433;background:#f4f6f9}
header{background:#143a5a;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;font-weight:600}
header i{width:14px;height:14px;background:#3cc7b4;display:inline-block}
main{padding:16px}
h1{font-size:20px;margin-bottom:4px}
.sub{color:#5b6476;margin-bottom:14px}
.status{display:inline-block;padding:2px 8px;font-size:12px;font-weight:600;border-radius:10px}
.Open{background:#e6f0fb;color:#1f5fa8}.Paid{background:#e4f6ee;color:#1d7a4f}.Overdue{background:#fde8e6;color:#b13a2c}
table{border-collapse:collapse;background:#fff;width:760px}
th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e3e7ee;white-space:nowrap}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6476;background:#f9fafc}
td.num{text-align:right}
.cards{display:grid;gap:10px}
.card{background:#fff;border:1px solid #e3e7ee;padding:14px}
.card .top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.card .no{font-weight:600}
.card .total{font-size:18px;font-weight:600}
.card .meta{display:flex;justify-content:space-between;color:#5b6476;font-size:13px;margin-top:4px}
`;

const frame = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${CSS}</style></head>
<body><header><i></i>Harborline</header><main><h1>Invoices</h1><p class="sub">6 invoices this month</p>${body}</main></body></html>`;

// Before: the desktop table, laid out at its own width; a 390px screen cuts it off at the right edge.
const before = frame(`<table><thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Tax</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
${ROWS.map((r) => `<tr><td>${r.no}</td><td>${r.customer}</td><td>${r.issued}</td><td>${r.due}</td><td>—</td><td class="num">${r.total}</td><td><span class="status ${r.status}">${r.status}</span></td></tr>`).join('')}
</tbody></table>`);

// After: each invoice is a card; the Tax column (empty for every invoice here) is gone.
const after = frame(`<div class="cards">${ROWS.map((r) => `<div class="card"><div class="top"><span class="no">${r.no}</span><span class="status ${r.status}">${r.status}</span></div>
<div class="top"><span>${r.customer}</span><span class="total">${r.total}</span></div><div class="meta"><span>Issued ${r.issued}</span><span>Due ${r.due}</span></div></div>`).join('')}</div>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const [name, html] of [['before', before], ['after', after]] as const) {
  await page.setContent(html);
  // The phone's own frame: whatever lays out past 390px is off screen, as on a real phone.
  await page.screenshot({ path: join(OUT, `invoices-list-mobile-${name}.png`), clip: { x: 0, y: 0, width: 390, height: 844 } });
}
await browser.close();
console.log('wrote invoices-list-mobile-{before,after}.png');
