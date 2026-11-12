// Payments still owed: unpaid PayPal pay links and invoices. "Chase payments" first asks PayPal
// whether each one is already paid (Agent Toolkit get_order / get_invoice), and only then
// reminds, on the farmer's schedule: a friendly reminder, a firmer one, then it hands over to her.
import { randomUUID } from 'node:crypto';
import { db, save, memberById } from './state.js';
import { paypal, toolkitOrderArgs, invoiceArgs, linkOf, captureOf, feeOf } from './paypal.js';
import { FARM } from './farm.js';
import { config } from './config.js';

const DAY = 86400e3;
const usd = (n) => `$${Number(n).toFixed(2)}`;
const firstName = (name) => String(name || '').split(' ')[0];
export const COLLECTIONS = { remind_after_days: 3, firm_after_days: 7, handoff_after_days: 14, ...(FARM.default_collections || {}) };
const total = (lines) => Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;

/** Record a pay link or invoice the farm is waiting on. */
export function addReceivable({ member_id, member_name, email, kind, category, what, amount, paypal: pp, sent_at, action_id = null, message_id = null }) {
  const r = { id: `rc_${randomUUID().slice(0, 8)}`, member_id, member_name, email, kind, category, what, amount, paypal: { mode: paypal.mode, ...pp }, sent_at: sent_at || new Date().toISOString(), action_id, message_id, reminders: [], status: 'open', last: null };
  (db.receivables ||= []).push(r);
  return r;
}

/** Seed the payments still owed from earlier weeks (created through PayPal, backdated). */
export async function seedOpenItems() {
  db.receivables = [];
  for (const it of FARM.open_items || []) {
    const m = memberById(it.member);
    const amount = total(it.lines);
    const sent_at = new Date(Date.now() - it.days_ago * DAY).toISOString();
    if (it.kind === 'link') {
      const o = await paypal.callTool('create_order', toolkitOrderArgs({ merchant: { name: FARM.farm.name }, items: it.lines }, {
        returnUrl: `${config.publicUrl}/paypal/return?receivable=pending`, cancelUrl: `${config.publicUrl}/paypal/cancel`, note: `${FARM.farm.name}: ${it.what}`,
      }));
      const r = addReceivable({ member_id: m.id, member_name: m.name, email: m.email, kind: 'link', category: it.category, what: it.what, amount, sent_at, paypal: { order_id: o.id, pay_url: linkOf(o, 'payer-action', 'approve') } });
      r.lines = it.lines;
    } else {
      const inv = await paypal.callTool('create_invoice', invoiceArgs({ farmName: FARM.farm.name, email: m.email, name: m.name, lines: it.lines, note: `${it.what}. Thank you!`, reference: `seed-${it.member}` }));
      const invoiceId = inv.id || inv.href?.split('/').pop();
      const sent = await paypal.callTool('send_invoice', { invoice_id: invoiceId, send_to_recipient: true });
      // Demo: one member already paid on PayPal, and Boxday has not noticed yet.
      if (it.paid_in_paypal && paypal.mode === 'mock') paypal.payInvoice(invoiceId);
      addReceivable({ member_id: m.id, member_name: m.name, email: m.email, kind: 'invoice', category: it.category, what: it.what, amount, sent_at, paypal: { invoice_id: invoiceId, pay_url: linkOf(sent, 'payer-view') || sent.href || null } });
    }
  }
  save();
}

export function markPaid(r, how, extra = {}) {
  Object.assign(r, { status: 'paid', paid_at: new Date().toISOString(), paid_how: how }, extra);
}

export const ageDays = (r, now = Date.now()) => Math.floor((now - Date.parse(r.sent_at)) / DAY);
export function stageFor(r, policy, now = Date.now()) {
  const p = { ...COLLECTIONS, ...policy };
  const d = ageDays(r, now);
  if (d >= p.handoff_after_days) return 'handoff';
  if (d >= p.firm_after_days) return 'firm';
  if (d >= p.remind_after_days) return 'friendly';
  return 'wait';
}

function reminderText(r, stage) {
  const hi = `Hi ${firstName(r.member_name)},`;
  const link = r.kind === 'invoice' ? 'the PayPal invoice we sent' : `this PayPal link: ${r.paypal.pay_url}`;
  const body = stage === 'friendly'
    ? `Just a friendly nudge: ${usd(r.amount)} for ${r.what} is still open. You can pay with ${link}. Thanks so much!`
    : `${usd(r.amount)} for ${r.what} has been open for ${ageDays(r)} days now. Could you pay it this week with ${link}? If something's wrong, just reply and tell me.`;
  return `${hi}\n\n${body}\n\n${FARM.farm.farmer} @ ${FARM.farm.name}`;
}

/** Check one receivable with PayPal. Returns 'paid' | 'captured' | 'open'. */
export const settleFromPayPal = (r) => checkWithPayPal(r);
async function checkWithPayPal(r) {
  if (r.kind === 'invoice') {
    const inv = await paypal.callTool('get_invoice', { invoice_id: r.paypal.invoice_id });
    r.paypal_status = inv.status;
    if (['PAID', 'MARKED_AS_PAID'].includes(inv.status)) { markPaid(r, 'Paid on PayPal (invoice)'); return 'paid'; }
    return 'open';
  }
  const o = await paypal.callTool('get_order', { id: r.paypal.order_id });
  r.paypal_status = o.status;
  if (o.status === 'COMPLETED') { markPaid(r, 'Paid on PayPal', { capture_id: captureOf(o)?.id, fee: feeOf(captureOf(o)) }); return 'paid'; }
  if (o.status === 'APPROVED') {
    // The member approved on PayPal but the payment was never captured: capture it now.
    const out = await paypal.callTool('pay_order', { id: r.paypal.order_id });
    const cap = captureOf(out.response || out);
    if (cap) { markPaid(r, 'Approved on PayPal; Boxday captured it', { capture_id: cap.id, fee: feeOf(cap) }); return 'captured'; }
  }
  return 'open';
}

/** One pass over everything still owed. */
export async function chase({ now = Date.now() } = {}) {
  const results = [];
  for (const r of (db.receivables || []).filter((x) => x.status === 'open' || x.status === 'handed_off')) {
    const res = { id: r.id, member_name: r.member_name, amount: r.amount, what: r.what };
    try {
      const paid = await checkWithPayPal(r);
      if (paid !== 'open') {
        res.outcome = paid;
        res.detail = paid === 'paid' ? 'Already paid on PayPal. Marked paid; no reminder sent.' : 'Approved on PayPal but never captured. Captured now.';
        if (r.action_id) settleAction(r);
      } else {
        const stage = stageFor(r, db.policy, now);
        const already = r.reminders.some((x) => x.stage === stage);
        if (stage === 'wait') { res.outcome = 'wait'; res.detail = `Sent ${ageDays(r, now) === 0 ? 'today' : `${ageDays(r, now)} days ago`}; too early to remind (your rule: after ${db.policy?.remind_after_days ?? COLLECTIONS.remind_after_days} days).`; }
        else if (already) { res.outcome = 'already'; res.detail = `Already sent a ${stage} reminder.`; }
        else if (stage === 'handoff') {
          r.status = 'handed_off';
          r.reminders.push({ at: new Date().toISOString(), stage, text: null, paypal_call: null });
          res.outcome = 'handoff';
          const n = r.reminders.filter((x) => x.text).length;
          res.detail = `Unpaid for ${ageDays(r, now)} days${n ? ` after ${n} reminder${n > 1 ? 's' : ''}` : ''}. Over to you: a call may work better than another message.`;
        } else {
          const text = reminderText(r, stage);
          let call = null;
          if (r.kind === 'invoice') {
            await paypal.callTool('send_invoice_reminder', { invoice_id: r.paypal.invoice_id, subject: `${FARM.farm.name}: reminder`, note: text.split('\n\n')[1] });
            call = 'send_invoice_reminder';
          }
          r.reminders.push({ at: new Date().toISOString(), stage, text, paypal_call: call });
          res.outcome = stage;
          res.detail = `${stage === 'friendly' ? 'Friendly' : 'Firmer'} reminder drafted${call ? ' and PayPal invoice reminder sent' : ' with the same PayPal link'}.`;
        }
      }
    } catch (err) {
      res.outcome = 'error';
      res.detail = String(err.message || err).slice(0, 200);
    }
    r.last = { at: new Date().toISOString(), outcome: res.outcome, detail: res.detail };
    results.push(res);
  }
  db.chased_at = new Date().toISOString();
  save();
  return results;
}

/** A receivable tied to tonight's action got paid: mirror it on the action. */
function settleAction(r) {
  const a = db.actions.find((x) => x.id === r.action_id);
  if (!a || a.status === 'done') return;
  if (a.status === 'invoice_sent') { a.invoice_paid_at = r.paid_at; return; }
  a.status = 'done';
  Object.assign(a.paypal, { capture_id: r.capture_id, fee: r.fee, tool: 'create_order → pay_order' });
}
