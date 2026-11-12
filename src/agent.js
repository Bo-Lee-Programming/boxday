// The member desk agent: for each message, understand it (local LLM, grounded),
// decide with the farm's rules (deterministic), act through PayPal, update the
// packing sheet, and draft a reply. Anything outside the policy waits for the farmer.
import { randomUUID } from 'node:crypto';
import { parseMessage, injectionSignals } from './intents.js';
import { evaluate } from './rules.js';
import { paypal, toolkitOrderArgs, invoiceArgs, linkOf } from './paypal.js';
import { db, save, memberByEmail, memberById, messageById } from './state.js';
import { FARM, SITES, ADDONS, weeklyPrice } from './farm.js';
import { config } from './config.js';
import { addReceivable } from './collections.js';

const usd = (n) => `$${Number(n).toFixed(2)}`;
const firstName = (m) => (m?.name || '').split(' ')[0] || 'there';
const nameFromEmail = (e) => e.split('@')[0].split(/[._-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Another member named in the message (full name, or a unique first name), other than the sender. */
function otherMemberMentioned(text, sender) {
  const t = text.toLowerCase();
  for (const m of db.members) {
    if (m.email === sender?.email) continue;
    const [first] = m.name.toLowerCase().split(' ');
    if (t.includes(m.name.toLowerCase())) return m.name;
    if (new RegExp(`\\b${first}'?s\\b`).test(t) && db.members.filter((x) => x.name.toLowerCase().startsWith(first + ' ')).length === 1 && !/\bi'?m\b/.test(t.split(first)[0].slice(-6))) return m.name;
  }
  return null;
}

function touch(member, ...fields) {
  member.changed = fields;
  member.changed_at = new Date().toISOString();
}

// ------------------------------------------------------------------ effects
function applyEffect(action) {
  const m = memberById(action.member_id);
  const e = action.effect;
  if (!e) return;
  if (e.skip !== undefined && m) {
    if (e.skip === db.week) { m.week.status = 'skipped'; touch(m, 'status', 'skips_used'); } else { m.next_skip = e.skip; touch(m, 'notes', 'skips_used'); }
    m.skips_used += 1;
  }
  if (e.addon && m) {
    m.week.addons[e.addon] += e.quantity;
    db.stock[e.addon] -= e.quantity;
    touch(m, `addon_${e.addon}`);
  }
  if (e.swap && m) { m.week.swaps.push(`${e.swap[0]} → ${e.swap[1]}`); touch(m, 'swaps'); }
  if (e.site && m) {
    if (e.from_week === db.week) { m.site = e.site; touch(m, 'site'); } else { m.next_site = e.site; touch(m, 'notes'); }
  }
  if (e.claim && m) { m.week.claim_refunded += action.money?.amount || 0; touch(m, 'refunded'); }
  if (e.cancel && m) { m.week.status = 'cancelled'; m.cancelled = true; touch(m, 'status'); }
  if (m && action.money?.kind === 'refund') touch(m, ...m.changed, 'refunded');
}

function addJoiner(action) {
  const { share, first_week } = action.effect.join;
  const m = {
    id: `mb_${randomUUID().slice(0, 6)}`, name: nameFromEmail(action.sender), email: action.sender, share, site: 'farmstand',
    wallet: null, skips_used: 0, joined_week: first_week,
    season: { amount: action.money.amount, refunded: 0, invoice_id: action.paypal.invoice_id, order_id: null, capture_id: null },
    week: { status: first_week === db.week ? 'awaiting_payment' : 'starts_next_week', addons: Object.fromEntries(Object.keys(ADDONS).map((k) => [k, 0])), swaps: [], notes: '', claim_refunded: 0 },
    changed: ['name', 'status'], changed_at: new Date().toISOString(),
  };
  db.members.push(m);
  action.member_id = m.id;
}

// ------------------------------------------------------------------ PayPal
const farmIntent = (lines) => ({ merchant: { id: 'farm', name: FARM.farm.name, verified: true }, items: lines.map((l) => ({ ...l, quantity: l.quantity })) });

async function moveMoney(action) {
  const m = memberById(action.member_id);
  const { kind, amount, lines } = action.money;
  if (kind === 'refund') {
    const r = await paypal.callTool('create_refund', {
      capture_id: m.season.capture_id,
      amount: { currency_code: 'USD', value: amount.toFixed(2) },
      note_to_payer: `${FARM.farm.name}: ${action.summary}`.slice(0, 255),
    });
    m.season.refunded = Math.round((m.season.refunded + amount) * 100) / 100;
    Object.assign(action.paypal, { tool: 'create_refund', via: 'PayPal Agent Toolkit', refund_id: r.id, capture_id: m.season.capture_id, status: r.status });
    return 'done';
  }
  if (kind === 'charge') {
    if (m.wallet?.payment_token_id) {
      const r = await paypal.chargeWallet(farmIntent(lines), { vaultId: m.wallet.payment_token_id, customId: m.id, invoiceId: action.id });
      Object.assign(action.paypal, { tool: 'vault_charge', via: 'Orders v2 + Vault (saved wallet)', order_id: r.order_id, capture_id: r.capture_id, status: r.status, fee: r.fee ?? null });
      return r.status === 'COMPLETED' ? 'done' : 'failed';
    }
    const args = toolkitOrderArgs(farmIntent(lines), {
      returnUrl: `${config.publicUrl}/paypal/return?action=${action.id}`,
      cancelUrl: `${config.publicUrl}/paypal/cancel?action=${action.id}`,
      note: `${FARM.farm.name} add-on for ${m.name}`,
    });
    const o = await paypal.callTool('create_order', args);
    Object.assign(action.paypal, { tool: 'create_order', via: 'PayPal Agent Toolkit', order_id: o.id, status: o.status, pay_url: linkOf(o, 'payer-action', 'approve') });
    addReceivable({ member_id: m.id, member_name: m.name, email: m.email, kind: 'link', category: `Add-ons: ${ADDONS[action.effect.addon].label}`, what: action.summary, amount, action_id: action.id, message_id: action.message_id, paypal: { order_id: o.id, pay_url: action.paypal.pay_url } });
    return 'awaiting_member';
  }
  if (kind === 'invoice') {
    const inv = await paypal.callTool('create_invoice', invoiceArgs({
      farmName: FARM.farm.name, email: action.sender, name: nameFromEmail(action.sender), lines,
      note: `Welcome to ${FARM.farm.name}! Your first box is ready the week after this invoice is paid.`, reference: action.id,
    }));
    const invoiceId = inv.id || inv.href?.split('/').pop();
    const sent = await paypal.callTool('send_invoice', { invoice_id: invoiceId, send_to_recipient: true, note: 'See you at the farm stand!' });
    Object.assign(action.paypal, { tool: 'create_invoice → send_invoice', via: 'PayPal Agent Toolkit', invoice_id: invoiceId, status: 'SENT', pay_url: linkOf(sent, 'payer-view') || sent.href || null });
    addReceivable({ member_id: null, member_name: nameFromEmail(action.sender), email: action.sender, kind: 'invoice', category: 'New member shares', what: action.summary, amount, action_id: action.id, message_id: action.message_id, paypal: { invoice_id: invoiceId, pay_url: action.paypal.pay_url } });
    return 'invoice_sent';
  }
  throw new Error(`unknown money kind ${kind}`);
}

/** Execute an allowed (or farmer-approved) action: move money first, then change the sheet. */
export async function execute(action) {
  try {
    if (action.money) {
      action.status = await moveMoney(action);
      if (action.status === 'done') applyEffect(action);
      if (action.status === 'invoice_sent') addJoiner(action);
      if (action.status === 'awaiting_member') { const m = memberById(action.member_id); m.week.notes = `${action.summary}: PayPal link sent`; touch(m, 'notes'); }
    } else {
      applyEffect(action);
      action.status = 'done';
    }
  } catch (err) {
    action.status = 'failed';
    action.error = String(err.message || err);
  }
  action.updated_at = new Date().toISOString();
  save();
  return action;
}

// ------------------------------------------------------------------ replies
function replyFor(msg, member, actions) {
  const lines = [];
  for (const a of actions) {
    const p = a.paypal || {};
    const ok = a.status === 'done';
    switch (a.type) {
      case 'skip_week':
        if (ok) lines.push(`Your box for week ${a.week} is skipped${a.money ? `, and ${usd(a.money.amount)} is on its way back to your PayPal` : ''}.`);
        else if (a.decision === 'block') lines.push(`I'm sorry, we can't skip this one: ${a.reasons[0].replace(/^Too late: /, 'it is too late, ')} If you can't make it, reply DONATE and we'll give your box to the food pantry.`);
        break;
      case 'add_on':
        if (ok && p.tool?.includes('pay_order')) lines.push(`Thanks, your PayPal payment of ${usd(a.money.amount)} went through. ${a.summary} will be in your box.`);
        else if (ok) lines.push(`Added ${a.summary} to your box; ${usd(a.money.amount)} was charged to your saved PayPal.`);
        else if (a.status === 'awaiting_member') lines.push(`${a.summary} is set aside for you. Pay ${usd(a.money.amount)} with PayPal here: ${p.pay_url}`);
        else if (a.decision === 'block') lines.push(`Sorry, we can't add ${a.summary}: ${(a.reasons[0].charAt(0).toLowerCase() + a.reasons[0].slice(1)).replace(/\btheir\b/g, 'your')}`);
        break;
      case 'swap_item':
        if (ok) lines.push(`Done: ${a.summary.replace('Swap', 'we swapped')} in your box.`);
        else if (a.decision === 'block') lines.push(`About the swap: ${a.reasons[0]}`);
        break;
      case 'change_site':
        if (ok) lines.push(`You're now picking up at ${SITES[a.effect.site].label}${a.effect.from_week === msg.week ? ' starting this week' : ' starting next week'}.`);
        break;
      case 'missing_item':
        if (ok) lines.push(`So sorry about that! ${usd(a.money.amount)} for the ${a.effect.claim.join(' and ')} is refunded to your PayPal.`);
        break;
      case 'join':
        if (a.status === 'invoice_sent') lines.push(`Welcome! I've sent a PayPal invoice for ${usd(a.money.amount)} (${a.money.lines[0].quantity} weeks of the ${a.effect.join.share} share). Your first pickup is at the farm stand.`);
        else if (a.decision === 'block') lines.push("Thanks for your interest! We're full for this season, but we'll let you know when sign-ups open.");
        break;
      case 'cancel_season':
        if (ok) lines.push(`Your season share is cancelled${a.money ? ` and ${usd(a.money.amount)} is refunded to your PayPal` : ''}. Thank you for farming with us this year.`);
        else if (a.decision === 'block' && a.checks.some((c) => c.rule === 'third_party' || c.rule === 'identity')) lines.push(`For everyone's security, season changes and refunds can only be requested by the member from their own email, and refunds go back to the PayPal account that paid.`);
        break;
      default:
        break;
    }
    const about = a.type === 'cancel_season' ? 'About the season refund' : `About ${a.summary.charAt(0).toLowerCase() + a.summary.slice(1)}`;
    if (a.status === 'declined') lines.push(`${about}: Ruth has decided not to go ahead with this one. Reply if you'd like to talk it over.`);
    if (a.status === 'blocked' && a.decision === 'farmer') lines.push(`${about}: we couldn't complete it. ${a.reasons[0].replace(/^Re-checked at approval: /, '')}`);
    if (a.status === 'failed') lines.push(`${about}: something went wrong on our side; Ruth will sort it out and get back to you.`);
    if (a.status === 'awaiting_farmer') lines.push(`${a.type === 'cancel_season' ? 'About the season refund' : `About ${a.summary.toLowerCase()}`}: Ruth will look at this personally and get back to you.`);
  }
  if (!lines.length) lines.push("Thanks for your message! Ruth will get back to you soon.");
  const hello = member ? `Hi ${firstName(member)},` : `Hi ${nameFromEmail(msg.from).split(' ')[0]},`;
  return `${hello}\n\n${lines.join('\n\n')}\n\n${FARM.farm.farmer} @ ${FARM.farm.name}`;
}

function setReply(msg, member, actions) {
  msg.reply = replyFor(msg, member, actions);
  msg.status = actions.some((a) => a.status === 'awaiting_farmer') ? 'needs_farmer' : 'answered';
}

/** Re-draft a message's reply after the farmer decides or the member pays. */
function redraft(action) {
  const msg = messageById(action.message_id);
  if (!msg?.reply) return;
  setReply(msg, memberByEmail(msg.from), db.actions.filter((a) => a.message_id === msg.id));
  msg.redrafted_at = new Date().toISOString();
  save();
}

// ------------------------------------------------------------------ main
export async function processMessage(msg, emit = () => {}) {
  const step = (kind, data) => emit({ kind, message_id: msg.id, at: new Date().toISOString(), ...data });
  const member = memberByEmail(msg.from);
  const injected = injectionSignals(msg.text);
  const mentionsOther = otherMemberMentioned(msg.text, member);
  step('received', { from: msg.from, member: member ? { id: member.id, name: member.name, share: member.share, site: member.site } : null, injected, mentions_other: mentionsOther });

  // Requests from a member's own AI agent arrive already structured (and schema-checked): no model needed.
  const parsed = msg.structured
    ? { requests: msg.structured, fixes: [], ai: { via: 'agent', ms: 0 } }
    : await parseMessage(msg.text, { isMember: Boolean(member) });
  msg.parsed = { requests: parsed.requests, fixes: parsed.fixes, ai: parsed.ai };
  msg.flags = { member_id: member?.id || null, injected, mentions_other: mentionsOther };
  step('understood', { requests: parsed.requests, fixes: parsed.fixes, ai: parsed.ai });

  const actions = [];
  for (const req of parsed.requests) {
    if (req.type === 'question') continue;
    const r = evaluate(req, { member, sender: msg.from, policy: db.policy, state: db, injected, mentionsOther });
    const action = {
      id: `ac_${randomUUID().slice(0, 8)}`, message_id: msg.id, created_at: new Date().toISOString(),
      sender: msg.from, member_id: member?.id || null, member_name: member?.name || nameFromEmail(msg.from),
      type: req.type, request: req, summary: r.summary, week: r.week,
      decision: r.decision, checks: r.checks, reasons: r.checks.filter((c) => c.outcome === (r.decision === 'allow' ? 'pass' : r.decision)).map((c) => c.detail),
      money: r.money, effect: r.effect, paypal: { mode: paypal.mode }, status: r.decision === 'block' ? 'blocked' : r.decision === 'farmer' ? 'awaiting_farmer' : 'pending',
    };
    db.actions.push(action);
    if (r.decision === 'allow') await execute(action);
    actions.push(action);
    step('action', { action });
  }
  save();

  msg.week = db.week;
  setReply(msg, member, actions);
  msg.action_ids = actions.map((a) => a.id);
  msg.processed_at = new Date().toISOString();
  save();
  step('replied', { reply: msg.reply, status: msg.status });
  return msg;
}

/** Farmer decision on an action that waited for them. */
export async function decide(action, approve) {
  const out = await decideInner(action, approve);
  redraft(out);
  return out;
}

async function decideInner(action, approve) {
  if (action.status !== 'awaiting_farmer') throw new Error('This action is not waiting for you.');
  if (!approve) {
    action.status = 'declined';
    action.updated_at = new Date().toISOString();
    save();
    return action;
  }
  // Re-check hard rules at approval time (stock, refundable balance) before moving money.
  const member = memberById(action.member_id);
  const again = evaluate(action.request, { member, sender: action.sender, policy: db.policy, state: db, injected: 0, mentionsOther: null });
  const hard = again.checks.filter((c) => c.outcome === 'block' && c.rule !== 'notice');
  if (hard.length) {
    action.status = 'blocked';
    action.reasons = ['Re-checked at approval: ' + hard.map((c) => c.detail).join(' ')];
    save();
    return action;
  }
  action.approved_by_farmer = new Date().toISOString();
  if (action.money && again.money) action.money.amount = action.money.amount ?? again.money.amount;
  return execute(action);
}

// ------------------------------------------------------------------ teaching a rule
const ctxFor = (a, policy) => {
  const msg = messageById(a.message_id);
  return { member: memberById(a.member_id), sender: a.sender, policy, state: db, injected: msg?.flags?.injected || 0, mentionsOther: msg?.flags?.mentions_other || null };
};

/**
 * What a policy change would do to tonight's requests. Both decisions are computed on the same
 * current farm state, so the only difference is the policy. Deterministic; no model involved.
 */
export function previewPolicy(next) {
  const policy = { ...next, confirmed_at: db.policy?.confirmed_at || new Date().toISOString() };
  const out = [];
  for (const a of db.actions) {
    if (a.type === 'join' && a.status === 'invoice_sent') continue;
    const before = evaluate(a.request, ctxFor(a, db.policy));
    const after = evaluate(a.request, ctxFor(a, policy));
    if (before.decision === after.decision) continue;
    const waiting = a.status === 'awaiting_farmer';
    out.push({
      action_id: a.id, message_id: a.message_id, member_name: a.member_name, summary: a.summary, money: a.money,
      from: before.decision, to: after.decision, status: a.status,
      applies: waiting && after.decision === 'allow',
      note: waiting ? (after.decision === 'allow' ? 'Waiting for you now; Boxday will handle it when you apply.' : 'Still waits for you.')
        : 'Already answered tonight; only new messages follow the new rule.',
    });
  }
  return out;
}

/** Make the new policy live, then hand anything it now allows back to the agent. */
export async function applyPolicy(next, sentence) {
  const impacts = previewPolicy(next);
  db.policy = { ...next, source_text: [db.policy?.source_text, sentence].filter(Boolean).join(' '), taught: [...(db.policy?.taught || []), { sentence, at: new Date().toISOString() }], confirmed_at: new Date().toISOString() };
  save();
  const handled = [];
  for (const i of impacts.filter((x) => x.applies)) {
    const a = db.actions.find((x) => x.id === i.action_id);
    const r = evaluate(a.request, ctxFor(a, db.policy));
    if (r.decision !== 'allow') continue;
    Object.assign(a, { decision: 'allow', checks: r.checks, reasons: r.checks.filter((c) => c.outcome === 'pass').map((c) => c.detail), allowed_by_rule: sentence });
    await execute(a);
    redraft(a);
    handled.push(a);
  }
  return { policy: db.policy, impacts, handled };
}

/** Member came back from PayPal after paying an add-on link. */
export async function completeMemberPayment(action) {
  if (action.status !== 'awaiting_member') return action;
  await capturePayLink(action);
  redraft(action);
  return action;
}

async function capturePayLink(action) {
  try {
    const out = await paypal.callTool('pay_order', { id: action.paypal.order_id });
    const order = out.response || out;
    const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
    if (out.status === 'success' && cap) {
      action.paypal.capture_id = cap.id;
      action.paypal.fee = cap.seller_receivable_breakdown?.paypal_fee?.value != null ? Number(cap.seller_receivable_breakdown.paypal_fee.value) : null;
      action.paypal.status = order.status;
      const rc = (db.receivables || []).find((x) => x.action_id === action.id);
      if (rc) Object.assign(rc, { status: 'paid', paid_at: new Date().toISOString(), paid_how: 'Paid through the PayPal link', capture_id: cap.id, fee: action.paypal.fee });
      action.paypal.tool = 'create_order → pay_order';
      action.status = 'done';
      applyEffect(action);
      const m = memberById(action.member_id);
      m.week.notes = '';
    } else {
      action.status = 'failed';
      action.error = JSON.stringify(order).slice(0, 300);
    }
  } catch (err) {
    action.status = 'failed';
    action.error = String(err.message || err);
  }
  save();
  return action;
}

export const weeklyValue = (m) => weeklyPrice(m.share);
