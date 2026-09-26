/**
 * render-harborline-shots.ts — the visual-review screenshots of the fictional
 * Harborline billing portal, for the multi-currency demo story.
 *
 *   bun run scripts/demo/stories/shots/render-harborline-shots.ts
 *   → scripts/demo/stories/shots/<name>.png   (then re-run build-multi-currency.py)
 *
 * Harborline does not exist, so neither does its invoice page: these are mockups
 * drawn from the HTML below, at the two viewports the visual auditor captures
 * (desktop 1280 wide at 1x, phone 390 wide at 2x; full height, like
 * scripts/qa/capture.ts). Every name, amount and number is fictional. The PNGs
 * are committed so seeding needs no browser; re-run this after editing the page.
 */
import { chromium } from 'playwright';
import { join } from 'path';

const OUT = new URL('.', import.meta.url).pathname;

type Line = { desc: string; qty: number; unit: number };
type Invoice = {
  number: string; currency: 'EUR' | 'JPY'; locale: string; customer: string; city: string;
  issued: string; due: string; lines: Line[]; taxLabel: string; taxRate: number;
  baseRate: number; // 1 unit of `currency` in USD, snapshotted at issue
};

const INVOICES: Record<'eur' | 'jpy', Invoice> = {
  eur: {
    number: 'INV-2026-0412', currency: 'EUR', locale: 'de-DE', customer: 'Kestrel Outfitters GmbH', city: 'Berlin',
    issued: '12 Sep 2026', due: '12 Oct 2026', taxLabel: 'VAT 19%', taxRate: 0.19, baseRate: 1.0872,
    lines: [
      { desc: 'Fleet tracking, Growth plan (September)', qty: 1, unit: 1234.5 },
      { desc: 'Additional vessel seats', qty: 6, unit: 48.75 },
      { desc: 'Port-call API overage (12,400 calls)', qty: 1, unit: 186.0 },
      { desc: 'Onboarding workshop, half day', qty: 1, unit: 1450.0 },
    ],
  },
  jpy: {
    number: 'INV-2026-0419', currency: 'JPY', locale: 'ja-JP', customer: 'Mori Design Studio K.K.', city: 'Osaka',
    issued: '14 Sep 2026', due: '14 Oct 2026', taxLabel: 'Consumption tax 10%', taxRate: 0.1, baseRate: 0.00671,
    lines: [
      { desc: 'Fleet tracking, Starter plan (September)', qty: 1, unit: 98000 },
      { desc: 'Additional vessel seats', qty: 4, unit: 7600 },
      { desc: 'Port-call API overage (3,100 calls)', qty: 1, unit: 22800 },
    ],
  },
};

function amounts(inv: Invoice) {
  const minor = inv.currency === 'JPY' ? 1 : 100;
  // Per-line rounding, the mission's recorded decision: the total is the sum of rounded lines.
  const lines = inv.lines.map((l) => ({ ...l, amount: Math.round(l.qty * l.unit * minor) / minor }));
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax = Math.round(subtotal * inv.taxRate * minor) / minor;
  const total = subtotal + tax;
  return { lines, subtotal, tax, total, base: Math.round(total * inv.baseRate * 100) / 100 };
}

const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2933; background: #f4f6f8; }
  .top { background: #0f3b57; color: #fff; display: flex; align-items: center; gap: 28px; padding: 0 32px; height: 56px; }
  .brand { font-weight: 700; letter-spacing: .2px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  .brand i { width: 18px; height: 18px; border-radius: 4px; background: #3fb6a8; display: inline-block; }
  .nav { display: flex; gap: 20px; font-size: 13px; opacity: .85; }
  .nav b { opacity: 1; border-bottom: 2px solid #3fb6a8; padding-bottom: 16px; margin-bottom: -18px; }
  .who { margin-left: auto; font-size: 13px; opacity: .85; }
  .wrap { max-width: 960px; margin: 32px auto; padding: 0 24px; }
  .card { background: #fff; border: 1px solid #dde3e9; border-radius: 10px; padding: 28px 32px; }
  .row { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  h1 { font-size: 22px; font-weight: 650; }
  .muted { color: #62707d; font-size: 13px; }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: #fff4e0; color: #9a5b00; }
  .cur { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: #e6f4f2; color: #1f7a6f; margin-left: 8px; }
  .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0; }
  .meta div b { display: block; font-size: 14px; color: #1f2933; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: #62707d; font-weight: 600; padding: 10px 0; border-bottom: 1px solid #dde3e9; }
  td { padding: 12px 0; border-bottom: 1px solid #eef1f4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { margin-left: auto; width: 340px; margin-top: 16px; }
  .totals div { display: flex; justify-content: space-between; padding: 6px 0; font-variant-numeric: tabular-nums; }
  .totals .grand { border-top: 2px solid #1f2933; margin-top: 6px; padding-top: 10px; font-weight: 700; font-size: 17px; }
  .foot { margin-top: 20px; padding: 12px 14px; background: #f7f9fb; border: 1px dashed #c9d2da; border-radius: 8px; font-size: 13px; color: #45525e; }
  .btn { display: inline-block; background: #0f3b57; color: #fff; font-weight: 600; padding: 12px 22px; border-radius: 8px; font-size: 15px; }
  .actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; align-items: center; }
  .ghost { color: #0f3b57; font-weight: 600; font-size: 14px; padding: 12px 8px; }
  .field { border: 1px solid #c9d2da; border-radius: 8px; padding: 12px 14px; margin-top: 6px; color: #9aa5b1; background: #fff; }
  label { display: block; font-size: 13px; font-weight: 600; margin-top: 16px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .paybox { display: grid; grid-template-columns: 1.2fr 1fr; gap: 24px; }
  .big { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 6px 0 4px; }
  /* phone */
  .phone .top { padding: 0 16px; gap: 12px; height: 52px; }
  .phone .nav, .phone .who { display: none; }
  .phone .burger { margin-left: auto; width: 22px; height: 14px; border-top: 2px solid #fff; border-bottom: 2px solid #fff; position: relative; }
  .phone .burger::after { content: ""; position: absolute; left: 0; right: 0; top: 4px; border-top: 2px solid #fff; }
  .phone .wrap { margin: 16px auto; padding: 0 12px; }
  .phone .card { padding: 18px 16px; }
  .phone .row { flex-direction: column; gap: 10px; }
  .phone h1 { font-size: 19px; }
  .phone .meta { grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
  .phone table thead { display: none; }
  .phone table, .phone tbody, .phone tr, .phone td { display: block; width: 100%; }
  .phone tr { border-bottom: 1px solid #eef1f4; padding: 10px 0; }
  .phone td { border: 0; padding: 2px 0; }
  .phone td.q { display: inline; color: #62707d; font-size: 13px; }
  .phone td.u { display: inline; color: #62707d; font-size: 13px; }
  .phone td.u::before { content: " × "; }
  .phone td.a { text-align: left; font-weight: 600; margin-top: 2px; }
  .phone .totals { width: 100%; }
  .phone .actions { flex-direction: column-reverse; align-items: stretch; }
  .phone .btn { text-align: center; padding: 14px; }
  .phone .ghost { text-align: center; }
  .phone .paybox { grid-template-columns: 1fr; }
  .phone .big { font-size: 30px; }
`;

function shell(body: string, phone: boolean, active: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head>
  <body class="${phone ? 'phone' : ''}"><div class="top"><span class="brand"><i></i>Harborline</span>
  <span class="nav">${['Invoices', 'Payments', 'Usage', 'Settings'].map((n) => (n === active ? `<b>${n}</b>` : `<span>${n}</span>`)).join('')}</span>
  <span class="who">Customer portal</span>${phone ? '<span class="burger"></span>' : ''}</div><div class="wrap">${body}</div></body></html>`;
}

function invoicePage(inv: Invoice, phone: boolean) {
  const fmt = (n: number) => new Intl.NumberFormat(inv.locale, { style: 'currency', currency: inv.currency }).format(n);
  const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  const a = amounts(inv);
  const rate = inv.currency === 'JPY' ? `1 JPY = ${inv.baseRate} USD` : `1 EUR = ${inv.baseRate} USD`;
  return shell(`<div class="card">
    <div class="row"><div><h1>Invoice ${inv.number}<span class="cur">${inv.currency}</span></h1>
      <p class="muted">${inv.customer} · ${inv.city}</p></div><span class="pill">Due ${inv.due}</span></div>
    <div class="meta"><div class="muted">Issued<b>${inv.issued}</b></div><div class="muted">Billing currency<b>${inv.currency}</b></div>
      <div class="muted">Amount due<b>${fmt(a.total)}</b></div></div>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead><tbody>
    ${a.lines.map((l) => `<tr><td>${l.desc}</td><td class="num q">${l.qty}</td><td class="num u">${fmt(l.unit)}</td><td class="num a">${fmt(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <div class="totals"><div><span>Subtotal</span><span>${fmt(a.subtotal)}</span></div><div><span>${inv.taxLabel}</span><span>${fmt(a.tax)}</span></div>
      <div class="grand"><span>Total</span><span>${fmt(a.total)}</span></div></div>
    <p class="foot">Billed in ${inv.currency}. Base amount ${usd(a.base)} at ${rate}, the rate fixed when this invoice was issued.</p>
    <div class="actions"><span class="ghost">Download PDF</span><span class="btn">Pay ${fmt(a.total)}</span></div>
  </div>`, phone, 'Invoices');
}

function payPage(inv: Invoice, phone: boolean) {
  const fmt = (n: number) => new Intl.NumberFormat(inv.locale, { style: 'currency', currency: inv.currency }).format(n);
  const a = amounts(inv);
  return shell(`<div class="card"><div class="paybox"><div>
      <p class="muted">Pay invoice ${inv.number}</p><div class="big">${fmt(a.total)}</div>
      <p class="muted">${inv.customer} · charged in ${inv.currency}</p>
      <p class="foot">JPY has no minor unit, so the card is charged exactly the invoice total, with no decimals and no conversion at your bank.</p></div>
    <div><label>Card number</label><div class="field">4242 4242 4242 4242</div>
      <div class="split"><div><label>Expiry</label><div class="field">MM / YY</div></div><div><label>CVC</label><div class="field">123</div></div></div>
      <label>Name on card</label><div class="field">Name as it appears on the card</div>
      <div class="actions"><span class="btn" style="width:100%;text-align:center">Pay ${fmt(a.total)}</span></div></div></div>
  </div>`, phone, 'Payments');
}

/** name → [page html builder, invoice]. Names are the artifact filenames' stems. */
const SHOTS: Array<[string, (phone: boolean) => string]> = [
  ['invoices-eur', (p) => invoicePage(INVOICES.eur, p)],
  ['invoices-jpy', (p) => invoicePage(INVOICES.jpy, p)],
  ['pay-jpy', (p) => payPage(INVOICES.jpy, p)],
];

if (import.meta.main) {
  const browser = await chromium.launch({ headless: true });
  for (const [name, html] of SHOTS) {
    for (const vp of [
      { id: 'desktop', width: 1280, height: 900, scale: 1, mobile: false },
      { id: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, isMobile: vp.mobile, hasTouch: vp.mobile });
      const page = await ctx.newPage();
      await page.setContent(html(vp.mobile), { waitUntil: 'load' });
      const file = join(OUT, `${name}-${vp.id}.png`);
      await page.screenshot({ path: file, fullPage: true });
      await ctx.close();
      console.log(file);
    }
  }
  await browser.close();
}
