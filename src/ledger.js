// The farm's PayPal ledger: every season payment, add-on charge, refund, pay link and
// invoice, each with its PayPal object ID, category and PayPal fee. `reconcile()` re-reads
// every object from PayPal and explains any difference; `buildStatement()` adds it all up.
import { db, save } from './state.js';
import { paypal } from './paypal.js';
import { ADDONS } from './farm.js';

const r2 = (n) => Math.round(n * 100) / 100;
const DAY = 86400e3;
const OK_STATUS = {
  capture: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  refund: ['COMPLETED', 'PENDING'],
  order: ['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'],
  invoice: ['SENT', 'UNPAID', 'PARTIALLY_PAID'],
  invoice_paid: ['PAID', 'MARKED_AS_PAID'],
};
const REFUND_CAT = { skip_week: 'Refunds: skipped weeks', missing_item: 'Refunds: missing or spoiled items', cancel_season: 'Refunds: season cancellations' };

function seasonStart() {
  const anchor = Date.parse(db.anchor || db.seeded_at);
  return new Date(anchor - ((db.week || 1) - 1) * 7 * DAY).toISOString();
}

export function buildLedger() {
  const rows = [];
  const start = seasonStart();
  for (const m of db.members || []) {
    if (!m.season?.capture_id) continue;
    rows.push({ id: `season-${m.id}`, at: start, member: m.name, entry: `Season share, ${m.share} (paid at sign-up)`, category: 'Season shares',
      api: 'Orders v2 + Vault', kind: 'capture', paypal_id: m.season.capture_id, amount: m.season.amount, fee: m.season.fee ?? null, settled: true, status: 'Captured' });
  }
  for (const a of db.actions || []) {
    const p = a.paypal || {};
    if (!a.money || !p.tool) continue;
    const base = { id: a.id, at: a.updated_at || a.created_at, member: a.member_name, action_id: a.id, message_id: a.message_id, farmer_approved: Boolean(a.approved_by_farmer) };
    const { kind, amount } = a.money;
    const addonCat = a.effect?.addon ? `Add-ons: ${ADDONS[a.effect.addon].label}` : 'Add-ons';
    if (kind === 'refund' && a.status === 'done') rows.push({ ...base, entry: /^refund/i.test(a.summary) ? a.summary : `Refund: ${a.summary}`, category: REFUND_CAT[a.type] || 'Refunds', api: 'Agent Toolkit create_refund', kind: 'refund', paypal_id: p.refund_id, amount: -amount, fee: null, settled: true, status: 'Refunded' });
    if (kind === 'charge' && a.status === 'done') rows.push({ ...base, entry: `Add-on: ${a.summary}`, category: addonCat, api: p.tool === 'vault_charge' ? 'Orders v2 + Vault' : 'Agent Toolkit pay_order', kind: 'capture', paypal_id: p.capture_id, amount, fee: p.fee ?? null, settled: true, status: 'Captured' });
    if (kind === 'charge' && a.status === 'awaiting_member') rows.push({ ...base, entry: `Add-on: ${a.summary}`, category: addonCat, api: 'Agent Toolkit create_order', kind: 'order', paypal_id: p.order_id, amount, fee: null, settled: false, status: 'Pay link sent' });
  }
  // Pay links and invoices the farm is waiting on (or that got paid), including earlier weeks.
  for (const r of db.receivables || []) {
    const tonightLink = r.action_id && r.kind === 'link'; // already listed from its action above
    if (tonightLink) continue;
    const base = { id: r.id, at: r.status === 'paid' ? r.paid_at : r.sent_at, member: r.member_name, message_id: r.message_id, receivable_id: r.id, category: r.category };
    if (r.kind === 'invoice') {
      rows.push({ ...base, entry: `Invoice: ${r.what}`, api: r.status === 'paid' ? 'Agent Toolkit get_invoice (paid)' : 'Agent Toolkit create_invoice', kind: r.status === 'paid' ? 'invoice_paid' : 'invoice', paypal_id: r.paypal.invoice_id, amount: r.amount, fee: null, settled: r.status === 'paid', status: r.status === 'paid' ? 'Paid' : r.status === 'handed_off' ? 'Over to you' : 'Invoice sent' });
    } else {
      rows.push({ ...base, entry: `Pay link: ${r.what}`, api: r.status === 'paid' ? 'Agent Toolkit pay_order' : 'Agent Toolkit create_order', kind: r.status === 'paid' ? 'capture' : 'order', paypal_id: r.status === 'paid' ? r.capture_id : r.paypal.order_id, amount: r.amount, fee: r.fee ?? null, settled: r.status === 'paid', status: r.status === 'paid' ? 'Captured' : r.status === 'handed_off' ? 'Over to you' : 'Pay link sent' });
    }
  }
  rows.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.id < y.id ? -1 : 1));
  let balance = 0;
  for (const r of rows) {
    if (r.settled) balance = r2(balance + r.amount);
    r.balance = balance;
    const c = db.reconciled?.rows?.[r.id];
    r.check = c && c.kind === r.kind ? c : null;
  }
  const sum = (f) => r2(rows.filter(f).reduce((s, r) => s + r.amount, 0));
  return {
    rows,
    totals: {
      collected: sum((r) => r.settled && r.amount > 0),
      refunded: -sum((r) => r.settled && r.amount < 0),
      net: balance,
      pending: sum((r) => !r.settled),
    },
    reconciled_at: db.reconciled?.at || null,
  };
}

/** Plain-language reason when PayPal and Boxday disagree. */
function explain(r, got) {
  const paidOnPayPal = (r.kind === 'invoice' && ['PAID', 'MARKED_AS_PAID'].includes(got.status)) || (r.kind === 'order' && got.status === 'COMPLETED');
  if (!r.settled && paidOnPayPal) return 'Paid on PayPal, still open in Boxday. "Chase payments" checks PayPal first and settles it.';
  if (Math.abs(got.amount - Math.abs(r.amount)) >= 0.005) return `PayPal shows $${got.amount.toFixed(2)}, Boxday recorded $${Math.abs(r.amount).toFixed(2)}. Was it edited or partly refunded in PayPal directly?`;
  if (r.kind === 'invoice' && got.status === 'CANCELLED') return 'The invoice was cancelled in PayPal.';
  return `PayPal status is ${got.status}, which Boxday did not expect here.`;
}

/** Re-read every ledger object from PayPal (orders and invoices via the Agent Toolkit). */
export async function reconcile() {
  const { rows } = buildLedger();
  const out = {};
  const queue = [...rows];
  async function worker() {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const got = await paypal.verify(r.kind === 'invoice_paid' ? 'invoice' : r.kind, r.paypal_id);
        const amountOk = Math.abs(got.amount - Math.abs(r.amount)) < 0.005;
        const statusOk = OK_STATUS[r.kind].includes(got.status);
        out[r.id] = { kind: r.kind, ok: amountOk && statusOk, status: got.status, amount: got.amount, note: amountOk && statusOk ? '' : explain(r, got) };
      } catch (err) {
        out[r.id] = { kind: r.kind, ok: false, status: 'ERROR', note: String(err.message || err).slice(0, 160) };
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  db.reconciled = { at: new Date().toISOString(), mode: paypal.mode, rows: out };
  save();
  const checked = Object.values(out);
  return { checked: checked.length, ok: checked.filter((c) => c.ok).length, ledger: buildLedger() };
}

/** The farmer's statement: this week and season to date, by category and by member. */
export function buildStatement() {
  const { rows } = buildLedger();
  const weekStart = Date.now() - 7 * DAY;
  const periods = { week: (r) => Date.parse(r.at) >= weekStart, season: () => true };
  const totals = {};
  for (const [k, inP] of Object.entries(periods)) {
    const rs = rows.filter(inP);
    const settledIn = rs.filter((r) => r.settled && r.amount > 0);
    const collected = r2(settledIn.reduce((s, r) => s + r.amount, 0));
    const refunded = r2(-rs.filter((r) => r.settled && r.amount < 0).reduce((s, r) => s + r.amount, 0));
    const fees = r2(settledIn.reduce((s, r) => s + (r.fee || 0), 0));
    totals[k] = { collected, refunded, fees, net: r2(collected - refunded - fees), fee_unknown: settledIn.filter((r) => r.fee == null).length };
  }
  totals.owed = r2(rows.filter((r) => !r.settled).reduce((s, r) => s + r.amount, 0));
  const cats = new Map();
  for (const r of rows.filter((x) => x.settled)) {
    const c = cats.get(r.category) || { category: r.category, week: 0, season: 0 };
    c.season = r2(c.season + r.amount);
    if (periods.week(r)) c.week = r2(c.week + r.amount);
    cats.set(r.category, c);
  }
  const members = new Map();
  for (const r of rows) {
    const m = members.get(r.member) || { member: r.member, season_share: 0, add_ons: 0, other_in: 0, refunds: 0, fees: 0, net: 0, owed: 0 };
    if (!r.settled) m.owed = r2(m.owed + r.amount);
    else if (r.amount < 0) m.refunds = r2(m.refunds - r.amount);
    else if (r.category === 'Season shares') m.season_share = r2(m.season_share + r.amount);
    else if (r.category.startsWith('Add-ons')) m.add_ons = r2(m.add_ons + r.amount);
    else m.other_in = r2(m.other_in + r.amount);
    if (r.settled && r.amount > 0) m.fees = r2(m.fees + (r.fee || 0));
    m.net = r2(m.season_share + m.add_ons + m.other_in - m.refunds - m.fees);
    members.set(r.member, m);
  }
  const mismatches = rows.filter((r) => r.check && !r.check.ok).map((r) => ({ id: r.id, member: r.member, entry: r.entry, note: r.check.note }));
  return {
    totals,
    by_category: [...cats.values()].sort((a, b) => b.season - a.season),
    by_member: [...members.values()].sort((a, b) => a.member.localeCompare(b.member)),
    mismatches,
    fee_source: paypal.mode === 'sandbox' ? "PayPal's seller_receivable_breakdown on each capture" : 'offline mock: illustrative 3.49% + $0.49 per capture (the sandbox reports the real fee)',
  };
}
