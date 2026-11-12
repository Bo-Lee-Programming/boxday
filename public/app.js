/* global agGrid */
// Boxday "Tonight": the farmer's evening on one screen. What came in, what the agent did,
// what waits for her, and what each member sees on their phone. Grids live on the other tabs.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d) => new Date(d).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const clock = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const lc = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);
const first = (name) => String(name || '').split(' ')[0];
const TYPE_LABEL = { skip_week: 'Skip a week', add_on: 'Add-on', swap_item: 'Swap', change_site: 'Change pickup', missing_item: 'Missing / spoiled', join: 'Join mid-season', cancel_season: 'Season refund', question: 'Question' };
const DECISION_LABEL = { allow: 'Within your rules', farmer: 'Needs you', block: 'Refused' };
const STATUS_LABEL = { done: 'Done', awaiting_farmer: 'Waiting for you', awaiting_member: 'Pay link sent', invoice_sent: 'Invoice sent', blocked: 'Refused', declined: 'Declined', failed: 'Failed', pending: 'Pending', new: 'New', answered: 'Answered', needs_farmer: 'Needs you' };

let S = null;
let selected = null;
let sheet = null;
let money = null;
let ledger = null;
let ledgerSeen = null;
let lastFlash = 0;
let llmDown = false;
let progress = null;
const working = new Set();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}
function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
const memberByEmail = (e) => S.members.find((m) => m.email.toLowerCase() === String(e).toLowerCase());
const nameFor = (msg) => memberByEmail(msg.from)?.name || msg.from;
const actionsOf = (msg) => S.actions.filter((a) => a.message_id === msg.id);
const COLORS = ['#3f6b2a', '#d9603b', '#1d4f91', '#a15c07', '#7a4fa0', '#2f7d7a', '#b42318', '#5b6b2a'];
function avatar(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="av" style="background:${COLORS[h % COLORS.length]}">${esc(name[0]?.toUpperCase() || '?')}</span>`;
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  for (const p of ['tonight', 'sheet', 'ledger', 'rules']) $(`pane-${p}`).classList.toggle('hidden', p !== name);
  if (name === 'ledger') setTimeout(() => { try { ledger.sizeColumnsToFit(); money.sizeColumnsToFit(); stGrid.sizeColumnsToFit(); } catch { /* grid not ready */ } }, 30);
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function selectMessage(id) {
  selected = id;
  showTab('tonight');
  renderTonight();
}

// ------------------------------------------------------------------ what the agent did, in words
function shortReason(a) {
  const c = a.checks?.find((x) => x.outcome === 'block');
  if (c?.rule === 'identity') return 'only the member who paid can ask, from their own email';
  if (c?.rule === 'third_party') return 'it is about someone else\'s share; refunds only go to the account that paid';
  return trunc((c?.detail || a.reasons?.[0] || '').replace(/^Re-checked at approval: /, ''), 120);
}
function did(a) {
  const amt = a.money ? usd(a.money.amount) : '';
  const by = a.approved_by_farmer ? ' (you approved)' : a.allowed_by_rule ? ' (your new rule)' : '';
  if (a.status === 'blocked') return `Said no to “${lc(a.summary)}”: ${shortReason(a)}`;
  if (a.status === 'awaiting_farmer') return `Asked you about ${lc(a.summary)}${a.money ? ` (${a.money.kind} ${amt})` : ''}`;
  if (a.status === 'declined') return `You declined ${lc(a.summary)}`;
  if (a.status === 'failed') return `Could not finish ${lc(a.summary)}: ${a.error || ''}`;
  switch (a.type) {
    case 'skip_week': return `Skipped week ${a.week}${a.money ? `, refunded ${amt} to their PayPal` : ''}${by}`;
    case 'add_on':
      if (a.status === 'awaiting_member') return `Set aside ${a.summary}, sent a PayPal pay link for ${amt}`;
      return a.paypal?.tool?.includes('pay_order') ? `${a.summary}: paid ${amt} through the PayPal link` : `Added ${a.summary}, charged ${amt} to their saved PayPal${by}`;
    case 'swap_item': return a.summary.replace(/^Swap/, 'Swapped');
    case 'change_site': return `Moved their pickup to ${a.summary.replace(/^Pickup → /, '')}`;
    case 'missing_item': return `Refunded ${amt} for the ${(a.effect?.claim || []).join(' and ')}${by}`;
    case 'join': return `New member: sent a PayPal invoice for ${amt} (${a.summary.replace(/^Join: /, '')})`;
    case 'cancel_season': return `Cancelled the season, refunded ${amt}${by}`;
    default: return a.summary;
  }
}
function moneyChip(a) {
  if (!a.money) return '';
  const v = usd(a.money.amount);
  if (a.status === 'done') return a.money.kind === 'refund' ? `<span class="money-chip refund">−${v}</span>` : `<span class="money-chip charge">+${v}</span>`;
  if (a.status === 'awaiting_member') return `<span class="money-chip link">${v} link</span>`;
  if (a.status === 'invoice_sent') return `<span class="money-chip invoice">${v} invoice</span>`;
  return '';
}

// ------------------------------------------------------------------ hero
function renderHero() {
  const total = S.messages.length;
  const fresh = S.messages.filter((m) => m.status === 'new').length;
  const handled = S.messages.filter((m) => m.status === 'answered').length;
  const waiting = S.actions.filter((a) => a.status === 'awaiting_farmer');
  const done = S.actions.filter((a) => a.status === 'done');
  const sum = (arr) => arr.reduce((s, a) => s + a.money.amount, 0);
  const people = (arr) => new Set(arr.map((a) => a.member_id)).size;
  const eyebrow = `${new Date().toLocaleDateString('en-US', { weekday: 'long' })} evening · week ${S.farm.current_week} of ${S.farm.season_weeks} · ${esc(S.farm.name)}`;
  let h = `<div class="eyebrow">${eyebrow}</div>`;
  if (progress) {
    const n = Math.min(progress.done + 1, progress.total);
    h += `<h2>Boxday is answering message ${n} of ${progress.total}…</h2>
      <div class="progress"><div style="width:${Math.round((progress.done / progress.total) * 100)}%"></div></div>
      <p class="lead">A local AI model reads each message. Plain code checks every request against your rules, and PayPal moves the money.</p>`;
  } else if (fresh === total) {
    h += `<h2>${total} member messages came in today.</h2>
      <p class="lead">Skips, add-ons, swaps, a missing item, a sign-up. Boxday answers each one inside your rules and settles the money through PayPal. Anything outside your rules waits for you.</p>
      <button id="btn-handle" class="btn primary big">Let Boxday handle them</button>`;
  } else {
    const refunds = done.filter((a) => a.money?.kind === 'refund');
    const charges = done.filter((a) => a.money?.kind === 'charge');
    const links = S.actions.filter((a) => a.status === 'awaiting_member');
    const invoices = S.actions.filter((a) => a.status === 'invoice_sent');
    const refused = S.actions.filter((a) => a.status === 'blocked');
    h += `<h2>Boxday handled ${handled} of ${total} messages.${waiting.length ? ` <em>${waiting.length} decision${waiting.length > 1 ? 's wait' : ' waits'} for you.</em>` : ' Nothing waits for you.'}</h2>
      <p class="lead">Every member has a reply, the packing sheet is up to date, and every dollar is in the PayPal ledger.</p>
      <div class="tiles">
        <div class="tile out"><div class="v">${usd(sum(refunds))}</div><div class="k">refunded to ${people(refunds)} member${people(refunds) === 1 ? '' : 's'} via PayPal</div></div>
        <div class="tile in"><div class="v">${usd(sum(charges))}</div><div class="k">charged for add-ons via PayPal</div></div>
        <div class="tile inv"><div class="v">${usd(sum(links) + sum(invoices))}</div><div class="k">${links.length} pay link${links.length === 1 ? '' : 's'} + ${invoices.length} invoice${invoices.length === 1 ? '' : 's'} sent</div></div>
        <div class="tile no"><div class="v">${refused.length}</div><div class="k">request${refused.length === 1 ? '' : 's'} refused, with a reason</div></div>
        <div class="tile wait"><div class="v">${waiting.length}</div><div class="k">waiting for you</div></div>
      </div>${fresh ? `<div class="row"><button id="btn-handle" class="btn primary">Handle ${fresh} new message${fresh > 1 ? 's' : ''}</button></div>` : ''}`;
  }
  $('hero').innerHTML = h;
  $('btn-handle')?.addEventListener('click', () => processMessages({ all: true }));
}

// ------------------------------------------------------------------ waiting for you
function proposal(a) {
  const m = S.members.find((x) => x.id === a.member_id);
  const v = a.money ? usd(a.money.amount) : '';
  if (a.money?.kind === 'refund') return `Refund ${v} to ${first(a.member_name)}'s PayPal · ${a.summary}`;
  if (a.money?.kind === 'charge') return m?.wallet ? `Charge ${v} to ${first(a.member_name)}'s saved PayPal · ${a.summary}` : `Send ${first(a.member_name)} a PayPal pay link for ${v} · ${a.summary}`;
  return a.summary;
}
function teachSuggestion(a) {
  if (a.checks.some((c) => c.rule === 'instructions_to_ai' || c.outcome === 'block')) return null;
  const farmerRules = a.checks.filter((c) => c.outcome === 'farmer').map((c) => c.rule);
  if (farmerRules.length !== 1 || !a.money) return null;
  const up = Math.ceil(a.money.amount / 10) * 10;
  if (farmerRules[0] === 'charge_limit') return `You can charge add-ons up to $${up} without asking me.`;
  if (farmerRules[0] === 'refund_limit') return `Refund missing or spoiled items up to $${up} without asking me.`;
  return null;
}
function renderNeeds() {
  const acts = S.actions.filter((a) => a.status === 'awaiting_farmer');
  $('needs').classList.toggle('hidden', !acts.length);
  $('needs-count').textContent = acts.length;
  // One card per message; each waiting request in it gets its own approve / decline.
  const msgIds = [...new Set(acts.map((a) => a.message_id))];
  $('needs-cards').innerHTML = msgIds.map((mid) => {
    const msg = S.messages.find((m) => m.id === mid);
    const mine = acts.filter((a) => a.message_id === mid);
    const injected = mine.some((a) => a.checks.some((c) => c.rule === 'instructions_to_ai'));
    return `<div class="ncard ${msg.id === selected ? 'selected' : ''}" data-msg="${msg.id}">
      <div class="who"><b>${esc(mine[0].member_name)}</b>${injected ? '<span class="flag">instructions aimed at the AI</span>' : ''}</div>
      <div class="q" data-open="${msg.id}">“${esc(trunc(msg.text, 150))}”</div>
      ${injected ? '<div class="whyask">The message tries to give the AI instructions, so nothing in it moves money until you decide.</div>' : ''}
      ${mine.map((a) => {
        const sugg = teachSuggestion(a);
        const why = a.checks.filter((c) => c.outcome === 'farmer' && c.rule !== 'instructions_to_ai').map((c) => c.detail).join(' ');
        return `<div class="prow"><div class="prop">${esc(proposal(a))}</div>${why ? `<div class="whyask">Why it's asking: ${esc(why)}</div>` : ''}
          <div class="acts"><button class="btn primary" data-approve="${a.id}">Approve${a.money ? ` · ${a.money.kind === 'refund' ? 'refund' : 'charge'} ${usd(a.money.amount)}` : ''}</button><button class="btn" data-decline="${a.id}">Decline</button>${sugg ? `<button class="teachlink" data-teach="${esc(sugg)}">Don't ask me next time →</button>` : ''}</div></div>`;
      }).join('')}
    </div>`;
  }).join('');
  const box = $('needs-cards');
  box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => selectMessage(b.dataset.open)));
  box.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decideAction(b.dataset.approve, true)));
  box.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => decideAction(b.dataset.decline, false)));
  box.querySelectorAll('[data-teach]').forEach((b) => b.addEventListener('click', () => { showTab('rules'); $('teach-text').value = b.dataset.teach; teach(); }));
}

// ------------------------------------------------------------------ the feed
function renderFeed() {
  const handledAny = S.messages.some((m) => m.status !== 'new');
  $('feed-title').textContent = handledAny ? 'What Boxday did with each message' : "Tonight's messages";
  const list = S.messages.slice().reverse();
  $('feed').innerHTML = list.map((m) => {
    const acts = actionsOf(m);
    const isWorking = working.has(m.id);
    const line2 = m.status === 'new' ? `<div class="line2">${esc(m.text)}</div>`
      : `<div class="line2 did">${esc(acts.length ? acts.map(did).join(' · ') : 'Replied; Ruth will follow up personally.')}</div>`;
    const status = isWorking ? pill('pending', 'Reading…') : pill(m.status, STATUS_LABEL[m.status]);
    return `<li class="${m.id === selected ? 'sel' : ''} ${isWorking ? 'working' : ''}" data-id="${m.id}">${avatar(nameFor(m))}
      <div><div class="line1">${esc(nameFor(m))}<span>${clock(m.received_at)}</span>${m.via?.kind === 'agent' ? `<em class="via">via ${esc(m.via.name)} · agent-to-agent</em>` : ''}</div>${line2}</div>
      <div class="right">${acts.map(moneyChip).join('')}${status}</div></li>`;
  }).join('');
  $('feed').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => selectMessage(li.dataset.id)));
}

// ------------------------------------------------------------------ the member's phone
function ppCard(a) {
  const p = a.paypal || {};
  const v = a.money ? usd(a.money.amount) : '';
  if (!a.money || !p.tool) return '';
  if (a.money.kind === 'refund' && a.status === 'done') return `<div class="pp ok"><div class="h">PayPal refund</div><div class="amt">${v}</div><div class="sub">Back to the PayPal account that paid · refund ${esc(p.refund_id)}</div></div>`;
  if (a.money.kind === 'charge' && a.status === 'done') return `<div class="pp ok"><div class="h">${p.tool.includes('pay_order') ? 'Paid with PayPal' : 'Paid with your saved PayPal'}</div><div class="amt">${v}</div><div class="sub">${esc(a.summary)} · order ${esc(p.order_id)}</div></div>`;
  if (a.status === 'awaiting_member') return `<div class="pp"><div class="h">PayPal payment request</div><div class="amt">${v}</div><div class="sub">${esc(a.summary)}</div><a class="paybtn" href="${esc(p.pay_url)}">Pay with PayPal</a></div>`;
  if (a.status === 'invoice_sent') return `<div class="pp"><div class="h">PayPal invoice</div><div class="amt">${v}</div><div class="sub">${esc(a.summary)} · ${esc(p.invoice_id)}</div><a class="paybtn" href="${esc(p.pay_url)}" target="_blank" rel="noopener">View and pay</a></div>`;
  return '';
}
const checksHtml = (checks) => `<ul class="checks">${checks.map((c) => `<li class="${c.outcome === 'farmer' ? 'escalate' : c.outcome}">${esc(c.detail)}</li>`).join('')}</ul>`;
function paypalLine(a) {
  const p = a.paypal || {};
  if (!p.tool) return a.money ? '<div class="tl-sub">No PayPal call made.</div>' : '';
  const ids = [p.order_id && `order ${p.order_id}`, p.capture_id && a.money?.kind !== 'refund' && `capture ${p.capture_id}`, p.refund_id && `refund ${p.refund_id}`, p.invoice_id && `invoice ${p.invoice_id}`].filter(Boolean).join(' · ');
  return `<div class="tl-sub">PayPal (${esc(p.mode)}): <span class="tool">${esc(p.tool)}</span> ${esc(ids)}</div>`;
}
function renderPhone() {
  if (String(selected).startsWith('rc_')) return renderOwedPhone();
  const msg = S.messages.find((m) => m.id === selected);
  const body = $('phone-body');
  if (!msg) { body.innerHTML = ''; return; }
  const name = nameFor(msg);
  $('phone-label').textContent = `What ${first(name)} sees`;
  let h = msg.via?.kind === 'agent'
    ? `<div class="bub me agent"><b>Sent by ${esc(msg.via.name)}</b>${esc(msg.text)}<code>${esc(JSON.stringify(msg.structured))}</code><small>${clock(msg.received_at)}</small></div>`
    : `<div class="bub me">${esc(msg.text)}<small>${clock(msg.received_at)}</small></div>`;
  if (msg.status === 'new') h += `<div class="typing">${working.has(msg.id) ? 'Boxday is writing a reply…' : 'Not answered yet'}</div>`;
  else {
    let reply = esc(msg.reply);
    for (const a of actionsOf(msg)) if (a.paypal?.pay_url) reply = reply.replaceAll(esc(a.paypal.pay_url), '(PayPal button below)');
    h += `<div class="bub farm">${reply}<small>${msg.redrafted_at ? 'updated · ' : ''}draft</small></div>`;
    h += actionsOf(msg).map(ppCard).join('');
  }
  body.innerHTML = h;
  body.scrollTop = 0;
  $('phone-note').textContent = S.mode.paypal === 'sandbox'
    ? 'Boxday drafts this reply; sending it by email or text is not built yet. The PayPal refunds, payments and invoices are real PayPal sandbox objects.'
    : "Boxday drafts this reply; sending it by email or text is not built yet. The PayPal objects come from Boxday's offline PayPal mock (no real money). With sandbox keys they are real PayPal sandbox calls.";
  const p = msg.parsed;
  const acts = actionsOf(msg);
  $('why-body').innerHTML = !p ? '<p class="muted">Not handled yet.</p>'
    : `<div class="chips">${p.requests.map((r) => pill('new', `${TYPE_LABEL[r.type]}${r.addon ? `: ${r.quantity} × ${r.addon}` : ''}${r.items?.length ? `: ${r.items.join(', ')}` : ''}${r.site ? ` → ${S.sites[r.site].label}` : ''}`)).join(' ')}</div>
      <div class="tl-sub">${p.ai.via === 'agent' ? 'Structured request from the member\'s own agent, authenticated with her member key and checked against the agent card\'s schema; no model needed' : p.ai.via === 'llm' ? `Read by ${esc(S.mode.llm.model)} in ${(p.ai.ms / 1000).toFixed(1)} s, then checked against the message` : 'Read by the rule-based parser, then checked against the message'}.</div>
      ${(p.fixes || []).map((f) => `<div class="tl-sub">Checked: ${esc(f)}</div>`).join('')}
      ${acts.map((a) => `<div class="act ${a.decision}"><div class="tl-head"><span>${esc(TYPE_LABEL[a.type])}: ${esc(a.summary)}</span>${pill(a.status, STATUS_LABEL[a.status])}</div>${checksHtml(a.checks)}${paypalLine(a)}</div>`).join('')}`;
}

// ------------------------------------------------------------------ payments still owed
const OUTCOME = {
  paid: ['done', 'Paid on PayPal ✓'], captured: ['done', 'Captured on PayPal ✓'], friendly: ['invoice_sent', 'Reminder sent'],
  firm: ['awaiting_member', 'Firmer reminder sent'], handoff: ['awaiting_farmer', 'Over to you'], wait: ['new', 'Too early to remind'], error: ['blocked', 'Could not check'],
};
const ageText = (d) => (d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`);
function owedRows() {
  return (S.receivables || []).filter((r) => r.status !== 'paid' || ['paid', 'captured'].includes(r.last?.outcome)).sort((a, b) => b.age_days - a.age_days);
}
function renderOwed() {
  const rows = owedRows();
  const open = (S.receivables || []).filter((r) => r.status !== 'paid');
  $('owed').classList.toggle('hidden', !rows.length);
  const p = S.policy || {};
  $('owed-sum').textContent = open.length ? `${usd(open.reduce((s, r) => s + r.amount, 0))} from ${new Set(open.map((r) => r.member_name)).size} members` : 'nothing';
  $('btn-chase').textContent = S.chased_at ? 'Chase again' : 'Chase payments';
  $('owed-hint').textContent = S.chased_at
    ? `Checked with PayPal at ${clock(S.chased_at)}. Reminders go out once per stage; nothing is sent twice.`
    : `Boxday asks PayPal first whether each one is already paid, then reminds on your schedule: after ${p.remind_after_days ?? 3} days, more firmly after ${p.firm_after_days ?? 7}, and after ${p.handoff_after_days ?? 14} days it hands over to you.`;
  $('owed-list').innerHTML = rows.map((r) => {
    const o = r.last ? OUTCOME[r.last.outcome === 'already' ? (r.reminders.at(-1)?.stage || 'wait') : r.last.outcome] : null;
    const chip = o ? pill(o[0], o[1]) : `<span class="muted small">${r.stage === 'wait' ? 'not due yet' : r.stage === 'handoff' ? 'overdue' : 'reminder due'}</span>`;
    const line2 = r.last?.detail || r.what;
    return `<li class="${r.id === selected ? 'sel' : ''}" data-id="${r.id}">${avatar(r.member_name)}
      <div><div class="line1">${esc(r.member_name)}<span>${r.kind === 'invoice' ? 'PayPal invoice' : 'PayPal pay link'} · sent ${ageText(r.age_days)}</span></div><div class="line2">${esc(line2)}</div></div>
      <div class="right"><span class="money-chip ${r.status === 'paid' ? 'charge' : 'invoice'}">${usd(r.amount)}</span>${chip}</div></li>`;
  }).join('');
  $('owed-list').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => selectMessage(li.dataset.id)));
}
async function chasePayments() {
  const btn = $('btn-chase');
  busy(btn, true, 'Checking with PayPal…');
  try {
    const r = await api('/api/collections/chase', {});
    const n = (k) => r.results.filter((x) => x.outcome === k).length;
    toast(`Checked ${r.results.length} with PayPal: ${n('paid') + n('captured')} already paid, ${n('friendly') + n('firm')} reminded, ${n('handoff')} over to you.`, 5000);
    const first = r.results.find((x) => x.outcome === 'paid') || r.results[0];
    if (first) selected = first.id;
  } catch (e) { toast(e.message); }
  busy(btn, false);
  await refresh();
}
$('btn-chase').addEventListener('click', chasePayments);
function renderOwedPhone() {
  const r = (S.receivables || []).find((x) => x.id === selected);
  const body = $('phone-body');
  if (!r) { body.innerHTML = ''; return; }
  $('phone-label').textContent = `What ${first(r.member_name)} sees`;
  const day = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  let h = `<div class="bub farm">Hi ${esc(first(r.member_name))}, here's the PayPal ${r.kind === 'invoice' ? 'invoice' : 'link'} for ${esc(r.what)}: ${usd(r.amount)}.<small>${day(r.sent_at)}</small></div>`;
  for (const x of r.reminders) {
    if (x.text) h += `<div class="bub farm">${esc(x.text.replaceAll(`this PayPal link: ${r.paypal.pay_url}`, 'the PayPal button below'))}<small>${day(x.at)} · ${x.stage === 'friendly' ? 'reminder' : 'firmer reminder'}${x.paypal_call ? ' + PayPal invoice reminder' : ''} · draft</small></div>`;
    else h += '<div class="typing">Boxday stopped reminding and handed this to Ruth.</div>';
  }
  if (r.status === 'paid') h += `<div class="pp ok"><div class="h">Paid with PayPal</div><div class="amt">${usd(r.amount)}</div><div class="sub">${esc(r.paid_how || '')}</div></div>`;
  else h += `<div class="pp"><div class="h">${r.kind === 'invoice' ? 'PayPal invoice' : 'PayPal payment request'}</div><div class="amt">${usd(r.amount)}</div><div class="sub">${esc(r.what)}</div><a class="paybtn" href="${esc(r.paypal.pay_url)}"${r.kind === 'invoice' ? ' target="_blank" rel="noopener"' : ''}>${r.kind === 'invoice' ? 'View and pay' : 'Pay with PayPal'}</a></div>`;
  body.innerHTML = h;
  body.scrollTop = body.scrollHeight;
  $('phone-note').textContent = `Reminder drafts follow your schedule.${r.kind === 'invoice' ? ' For invoices, PayPal also emails its own reminder (Agent Toolkit send_invoice_reminder).' : ''} ${S.mode.paypal === 'sandbox' ? 'PayPal objects are real sandbox objects.' : "PayPal objects come from Boxday's offline mock."}`;
  $('why-body').innerHTML = `<ul class="checks">
    <li class="pass">Asked PayPal for the current status (${r.kind === 'invoice' ? 'get_invoice' : 'get_order'})${r.paypal_status ? `: ${esc(r.paypal_status)}` : ''}.</li>
    <li class="pass">Open ${r.age_days} days; your schedule: remind after ${S.policy?.remind_after_days ?? 3}, firmer after ${S.policy?.firm_after_days ?? 7}, hand over after ${S.policy?.handoff_after_days ?? 14}.</li>
    ${r.last ? `<li class="${r.last.outcome === 'handoff' ? 'escalate' : 'pass'}">${esc(r.last.detail)}</li>` : ''}</ul>`;
}

function renderTonight() {
  renderHero();
  renderNeeds();
  renderOwed();
  renderFeed();
  renderPhone();
  const n = S.actions.filter((a) => a.status === 'awaiting_farmer').length;
  document.querySelector('#tabs [data-tab=tonight]').innerHTML = `Tonight${n ? `<span class="n">${n}</span>` : ''}`;
}

// ------------------------------------------------------------------ handling messages
async function processMessages(body) {
  const targets = body.all ? S.messages.filter((m) => m.status === 'new').map((m) => m.id) : [body.id];
  targets.forEach((id) => working.add(id));
  progress = { total: targets.length, done: 0 };
  renderTonight();
  try {
    const res = await fetch('/api/messages/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const s = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (s.kind === 'received') { selected = s.message_id; renderTonight(); }
        if (s.kind === 'replied' || s.kind === 'error') {
          working.delete(s.message_id);
          progress.done += 1;
          await refresh();
          if (s.kind === 'error') toast(s.message);
        }
      }
    }
  } catch (e) { toast(e.message); }
  working.clear();
  progress = null;
  selected = S.messages.find((m) => m.status === 'needs_farmer')?.id || selected;
  await refresh();
}

async function decideAction(id, approve) {
  try {
    const a = await api('/api/actions/decide', { id, approve });
    selected = a.message_id;
    toast(approve ? (a.status === 'done' || a.status === 'invoice_sent' ? `Approved: ${a.summary}${a.money ? ` (${a.money.kind} ${usd(a.money.amount)} via PayPal)` : ''}. Reply updated.` : `Not completed: ${(a.reasons || [a.error]).join(' ')}`) : `Declined. ${first(a.member_name)}'s reply is updated.`);
  } catch (e) { toast(e.message); }
  await refresh();
}

// ------------------------------------------------------------------ rules: teach it one sentence
const EXAMPLES = ['You can charge add-ons up to $50 without asking me.', "Members only need to give 24 hours' notice to skip.", 'Members can skip up to 4 weeks a season.', 'Refund missing or spoiled items up to $15 without asking me.'];
const fmtVal = (k, v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : /max/.test(k) ? usd(v) : /hours/.test(k) ? `${v} h` : String(v));
let lastTeach = null;
function renderRules() {
  const p = S.policy;
  if (!p) { $('rules-live').innerHTML = '<p class="muted">No rules yet.</p>'; return; }
  $('rules-live').innerHTML = `<ul class="rules-list">
    <li>Members can skip up to <b>${p.skip_limit}</b> weeks, with <b>${p.skip_notice_hours} h</b> notice${p.skip_refund ? '; a skipped week is <b>refunded</b> to their PayPal' : ''}.</li>
    <li>Add-ons are charged to the member's saved PayPal up to <b>${usd(p.addon_auto_max)}</b>; above that, you decide.</li>
    <li>Missing or spoiled items are refunded up to <b>${usd(p.auto_refund_max)}</b> without asking you.</li>
    <li>Mid-season joins: <b>${p.late_join ? 'yes, with a PayPal invoice for the weeks left' : 'no'}</b>.</li>
    <li>Unpaid PayPal links and invoices: a reminder after <b>${p.remind_after_days ?? 3} days</b>, a firmer one after <b>${p.firm_after_days ?? 7}</b>, and after <b>${p.handoff_after_days ?? 14} days</b> it's over to you. PayPal is always checked first.</li>
    <li>Whole-season refunds: <b>always you</b>. Money only moves for the member writing from their own email, to the PayPal account that paid. Messages with instructions aimed at the AI: <b>always you</b>.</li></ul>`;
  $('rules-taught').innerHTML = p.taught?.length ? `<div class="taught"><b>You taught it tonight:</b><ul class="rules-list">${p.taught.map((t) => `<li><q>${esc(t.sentence)}</q> <span class="muted">${clock(t.at)}</span></li>`).join('')}</ul></div>` : '';
  if (!$('teach-examples').childElementCount) {
    $('teach-examples').innerHTML = EXAMPLES.map((e) => `<button class="chip">${esc(e)}</button>`).join('');
    $('teach-examples').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('teach-text').value = c.textContent; teach(); }));
  }
}
async function teach() {
  const sentence = $('teach-text').value.trim();
  const btn = $('btn-teach');
  busy(btn, true, 'Reading…');
  $('teach-status').textContent = '';
  try {
    const r = await api('/api/policy/teach', { sentence });
    lastTeach = { sentence, ...r };
    const via = r.ai.via === 'llm' ? `read by ${S.mode.llm.model} in ${(r.ai.ms / 1000).toFixed(1)} s, every number checked against your words` : 'read by the rule-based parser';
    if (!r.changes.length) {
      $('teach-result').innerHTML = `<h4>Boxday understood</h4><p>Nothing it can change. That sentence doesn't name a setting Boxday controls, or it matches the rules already in force. It can change: skips per season, skip notice, refunding skipped weeks, the add-on limit, the missing-item refund limit, and mid-season joins.</p>`;
    } else {
      const applies = r.impacts.filter((i) => i.applies);
      $('teach-result').innerHTML = `<h4>Boxday understood <span class="muted" style="text-transform:none;letter-spacing:0">(${esc(via)})</span></h4>
        <div class="changes">${r.changes.map((c) => `<div class="change">${esc(c.label)}: <span class="from">${esc(fmtVal(c.key, c.from))}</span> → <span class="to">${esc(fmtVal(c.key, c.to))}</span></div>`).join('')}</div>
        ${r.fixes.length ? `<ul class="adjustments">${r.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        <h4>What it would change tonight</h4>
        ${r.impacts.length ? `<ul class="impacts">${r.impacts.map((i) => `<li class="${i.applies ? 'applies' : ''}"><b>${esc(i.member_name)}</b> · ${esc(i.summary)}${i.money ? ` (${i.money.kind} ${usd(i.money.amount)})` : ''}: <span class="arrow">${esc(DECISION_LABEL[i.from])} → ${esc(DECISION_LABEL[i.to])}</span><div class="muted">${esc(i.note)}</div></li>`).join('')}</ul>` : '<p class="muted">No request from tonight changes. New messages will follow the new rule.</p>'}
        <div class="row"><button id="btn-apply" class="btn primary">Apply rule${applies.length ? ` and handle ${applies.length} waiting request${applies.length > 1 ? 's' : ''}` : ''}</button><button id="btn-teach-cancel" class="btn">Cancel</button></div>`;
      $('btn-apply').addEventListener('click', applyTaught);
      $('btn-teach-cancel').addEventListener('click', () => { $('teach-result').innerHTML = ''; lastTeach = null; });
    }
  } catch (e) { toast(e.message); }
  busy(btn, false);
}
async function applyTaught() {
  if (!lastTeach) return;
  try {
    const r = await api('/api/policy/apply', { sentence: lastTeach.sentence, changes: lastTeach.changes });
    $('teach-result').innerHTML = '';
    $('teach-text').value = '';
    lastTeach = null;
    if (r.handled.length) {
      selected = r.handled[0].message_id;
      toast(`Rule applied. Boxday handled ${r.handled.map((a) => `${first(a.member_name)}'s ${lc(a.summary)}`).join(', ')} and updated the reply.`, 5000);
      await refresh();
      showTab('tonight');
      return;
    }
    toast('Rule applied. New messages follow it from now on.');
  } catch (e) { toast(e.message); }
  await refresh();
}
$('btn-teach').addEventListener('click', teach);

// ------------------------------------------------------------------ packing sheet
const ADDON_KEYS = () => Object.keys(S.addons);
const boxes = (rows) => rows.filter((m) => m.week.status === 'packing');

function sheetColumns() {
  const siteIds = Object.keys(S.sites);
  return [
    { field: 'name', headerName: 'Member', pinned: 'left', width: 150, cellRenderer: (p) => (p.node.rowPinned ? `<b>${esc(p.value)}</b>` : `${esc(p.value)}${p.data.edited_by_farmer ? ' <span class="muted" title="edited by you">✎</span>' : ''}`) },
    { field: 'share', headerName: 'Share', width: 105, editable: (p) => !p.node.rowPinned, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: Object.keys(S.shares) } },
    { field: 'site', headerName: 'Pickup', width: 165, editable: (p) => !p.node.rowPinned, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: siteIds }, valueFormatter: (p) => S.sites[p.value]?.label ?? p.value },
    { colId: 'status', headerName: 'This week', width: 135, valueGetter: (p) => p.data.week?.status, editable: (p) => !p.node.rowPinned, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['packing', 'skipped', 'donated', 'cancelled'] },
      cellRenderer: (p) => (p.node.rowPinned ? `<b>${esc(p.value)}</b>` : pill({ packing: 'done', skipped: 'declined', donated: 'declined', cancelled: 'blocked', awaiting_payment: 'awaiting_member', starts_next_week: 'awaiting_member' }[p.value] || 'new', { packing: 'Pack', skipped: 'Skipped', donated: 'Donate', cancelled: 'Cancelled', awaiting_payment: 'Invoice sent', starts_next_week: 'Starts next week' }[p.value] || p.value)) },
    ...ADDON_KEYS().map((k) => ({ colId: `addon_${k}`, headerName: S.addons[k].label.split(' ')[0].replace('Sourdough', 'Bread').replace('Flower', 'Flowers').replace('Honey', 'Honey'), width: 88, type: 'rightAligned', editable: (p) => !p.node.rowPinned,
      valueGetter: (p) => p.data.week?.addons?.[k] ?? 0, cellClassRules: { 'cell-hot': (p) => p.value > 0 }, valueFormatter: (p) => (p.node.rowPinned ? String(p.value) : p.value || '') })),
    { colId: 'swaps', headerName: 'Swaps', width: 170, valueGetter: (p) => (p.data.week?.swaps || []).join('; ') },
    { colId: 'notes', headerName: 'Notes', flex: 1, minWidth: 180, editable: (p) => !p.node.rowPinned, valueGetter: (p) => [p.data.week?.notes, p.data.next_site && `Moves to ${S.sites[p.data.next_site].label} next week`, p.data.next_skip && `Skips week ${p.data.next_skip}`].filter(Boolean).join(' · ') },
    { colId: 'skips_used', headerName: 'Skips', width: 80, type: 'rightAligned', valueGetter: (p) => (p.node.rowPinned ? '' : `${p.data.skips_used}/${S.policy?.skip_limit ?? '–'}`) },
    { colId: 'refunded', headerName: 'Refunded', width: 100, type: 'rightAligned', valueGetter: (p) => p.data.season?.refunded ?? 0, valueFormatter: (p) => (p.value ? usd(p.value) : '') },
    { colId: 'wallet', headerName: 'PayPal', width: 115, valueGetter: (p) => (p.node.rowPinned ? '' : p.data.wallet ? 'wallet saved' : p.data.season?.invoice_id ? 'invoice sent' : 'pays by link') },
  ];
}

function totalsRow(rows) {
  const packing = boxes(rows);
  const addons = Object.fromEntries(ADDON_KEYS().map((k) => [k, packing.reduce((s, m) => s + (m.week.addons[k] || 0), 0)]));
  const small = packing.filter((m) => m.share === 'small').length;
  return [{ id: 'totals', name: 'To pack', share: `${small} S / ${packing.length - small} Std`, site: '', week: { status: `${packing.length} boxes`, addons, swaps: [] }, season: {} }];
}

function initSheet() {
  sheet = agGrid.createGrid($('sheet-grid'), {
    theme: agGrid.themeQuartz.withParams({ accentColor: '#3f6b2a', fontSize: 13, headerFontWeight: 600, wrapperBorderRadius: 10, headerBackgroundColor: '#f7f6f1', rowHeight: 34 }),
    rowData: [],
    getRowId: (p) => p.data.id,
    columnDefs: [],
    defaultColDef: { sortable: true, resizable: true, filter: true },
    rowClassRules: { 'row-skipped': (p) => ['skipped', 'donated'].includes(p.data?.week?.status), 'row-cancelled': (p) => p.data?.week?.status === 'cancelled', 'row-pending': (p) => ['awaiting_payment', 'starts_next_week'].includes(p.data?.week?.status) },
    singleClickEdit: false,
    stopEditingWhenCellsLoseFocus: true,
    onCellValueChanged: async (e) => {
      const field = e.colDef.field || e.colDef.colId;
      try { await api('/api/sheet/edit', { member_id: e.data.id, field, value: e.newValue }); } catch (err) { toast(err.message); }
      await refresh();
    },
  });
  $('sheet-filter').addEventListener('input', (e) => sheet.setGridOption('quickFilterText', e.target.value));
  $('btn-csv').addEventListener('click', () => sheet.exportDataAsCsv({ fileName: `boxday-week${S.farm.current_week}-packing.csv`, skipPinnedBottom: false }));
}

// Editable valueGetter columns need setters so AG Grid passes newValue through.
function withSetters(cols) {
  for (const c of cols) if (c.editable && c.valueGetter) c.valueSetter = (p) => { p.data.__edit = p.newValue; return true; };
  return cols;
}

function renderSheet() {
  if (!sheet.getColumnDefs()?.length) sheet.setGridOption('columnDefs', withSetters(sheetColumns()));
  sheet.setGridOption('rowData', S.members);
  sheet.setGridOption('pinnedBottomRowData', totalsRow(S.members));
  $('sheet-week').textContent = `week ${S.farm.current_week} of ${S.farm.season_weeks}`;
  // Site summary: pickups, cutoffs, boxes per site, add-on stock.
  const sites = Object.entries(S.sites).map(([k, s]) => {
    const rows = boxes(S.members.filter((m) => m.site === k));
    const past = s.cutoff && new Date(s.cutoff) < new Date();
    return `<div class="site"><b>${esc(s.label)} · ${rows.length} boxes</b>${s.pickup ? `${when(s.pickup)} · changes ${past ? 'closed' : `until ${when(s.cutoff)}`}` : ''}</div>`;
  }).join('');
  const stock = `<div class="site stock"><b>Add-ons left</b>${ADDON_KEYS().map((k) => `${esc(S.addons[k].label.split(' (')[0])} ${S.stock[k]}`).join(' · ')}</div>`;
  $('site-summary').innerHTML = sites + stock;
  // Flash the cells the agent (or you) just changed.
  const fresh = S.members.filter((m) => m.changed_at && Date.parse(m.changed_at) > lastFlash);
  if (lastFlash && fresh.length) {
    const map = { status: 'status', skips_used: 'skips_used', site: 'site', swaps: 'swaps', notes: 'notes', refunded: 'refunded', name: 'name', share: 'share' };
    for (const m of fresh) {
      const node = sheet.getRowNode(m.id);
      const columns = (m.changed || []).map((f) => (f.startsWith('addon_') ? f : map[f])).filter(Boolean);
      if (node) sheet.flashCells({ rowNodes: [node], columns: columns.length ? columns : undefined, flashDuration: 1600, fadeDuration: 1200 });
    }
  }
  lastFlash = Math.max(lastFlash || Date.now(), ...S.members.map((m) => Date.parse(m.changed_at || 0)));
}

// ------------------------------------------------------------------ money & decisions
function initMoney() {
  money = agGrid.createGrid($('money-grid'), {
    theme: agGrid.themeQuartz.withParams({ accentColor: '#3f6b2a', fontSize: 13, headerFontWeight: 600, wrapperBorderRadius: 10, headerBackgroundColor: '#f7f6f1' }),
    rowData: [],
    getRowId: (p) => p.data.id,
    defaultColDef: { sortable: true, resizable: true, filter: true },
    autoSizeStrategy: { type: 'fitGridWidth', defaultMinWidth: 80 },
    columnDefs: [
      { field: 'created_at', headerName: 'Time', sort: 'desc', width: 95, minWidth: 95, valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
      { field: 'member_name', headerName: 'Member', width: 140 },
      { field: 'type', headerName: 'Request', width: 140, valueFormatter: (p) => TYPE_LABEL[p.value] },
      { field: 'summary', headerName: 'Detail', width: 190 },
      { field: 'decision', headerName: 'Rules', width: 150, minWidth: 150, cellRenderer: (p) => pill(p.value, DECISION_LABEL[p.value]) },
      { field: 'status', headerName: 'Status', width: 140, minWidth: 140, cellRenderer: (p) => pill(p.value, STATUS_LABEL[p.value]) },
      { colId: 'amount', headerName: 'PayPal amount', width: 125, type: 'rightAligned', valueGetter: (p) => (p.data.money ? (p.data.money.kind === 'refund' ? -1 : 1) * p.data.money.amount : null),
        valueFormatter: (p) => (p.value == null ? '' : `${p.data.money.kind === 'refund' ? '−' : p.data.money.kind === 'invoice' ? 'inv ' : '+'}${usd(Math.abs(p.value))}`) },
      { colId: 'paypal', headerName: 'PayPal call', width: 200, valueGetter: (p) => (p.data.paypal?.tool ? `${p.data.paypal.tool} ${p.data.paypal.refund_id || p.data.paypal.invoice_id || p.data.paypal.order_id || ''}` : '') },
      { colId: 'why', headerName: 'Why', flex: 1, minWidth: 220, valueGetter: (p) => (p.data.decision === 'allow' ? 'All rules passed' : p.data.reasons.join(' ')), tooltipValueGetter: (p) => p.value },
      { colId: 'act', headerName: '', width: 190, minWidth: 190, sortable: false, filter: false, cellRenderer: (p) => {
        const a = p.data;
        if (a.status !== 'awaiting_farmer') return '';
        const span = document.createElement('span');
        span.innerHTML = '<button class="grid-btn">Approve</button> <button class="grid-btn warn">Decline</button>';
        span.children[0].addEventListener('click', () => decideAction(a.id, true));
        span.children[1].addEventListener('click', () => decideAction(a.id, false));
        return span;
      } },
    ],
    onRowClicked: (p) => selectMessage(p.data.message_id),
  });
}

function renderMoney() {
  money.setGridOption('rowData', S.actions);
  const done = S.actions.filter((a) => a.status === 'done' || a.status === 'invoice_sent');
  const sum = (kind) => done.filter((a) => a.money?.kind === kind).reduce((s, a) => s + a.money.amount, 0);
  const waiting = S.actions.filter((a) => a.status === 'awaiting_farmer').length;
  const auto = S.actions.filter((a) => a.decision === 'allow' && a.status !== 'failed').length;
  $('money-kpis').innerHTML = `<span class="kpi">Handled automatically <b>${auto}</b></span><span class="kpi">Charged <b>${usd(sum('charge'))}</b></span><span class="kpi">Refunded <b>${usd(sum('refund'))}</b></span><span class="kpi">Invoiced <b>${usd(sum('invoice'))}</b></span><span class="kpi">Waiting for you <b>${waiting}</b></span>`;
}


// ------------------------------------------------------------------ PayPal ledger
function initLedger() {
  ledger = agGrid.createGrid($('ledger-grid'), {
    theme: agGrid.themeQuartz.withParams({ accentColor: '#3f6b2a', fontSize: 13, headerFontWeight: 600, wrapperBorderRadius: 10, headerBackgroundColor: '#f7f6f1' }),
    rowData: [],
    getRowId: (p) => p.data.id,
    defaultColDef: { sortable: true, resizable: true, filter: true },
    rowClassRules: { 'row-pending': (p) => p.data && p.data.settled === false && !p.node.rowPinned },
    autoSizeStrategy: { type: 'fitGridWidth', defaultMinWidth: 80 },
    tooltipShowDelay: 300,
    columnDefs: [
      { field: 'at', headerName: 'When', filter: false, sort: 'desc', width: 92, minWidth: 92, valueFormatter: (p) => (p.node.rowPinned ? '' : String(p.data.id).startsWith('season-') ? 'Sign-up' : new Date(p.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
        comparator: (a, b, na, nb) => Date.parse(a) - Date.parse(b) || (na.data.id < nb.data.id ? -1 : 1) },
      { field: 'member', headerName: 'Member', width: 120, cellRenderer: (p) => (p.node.rowPinned ? `<b>${esc(p.value)}</b>` : esc(p.value)) },
      { field: 'entry', headerName: 'Entry', width: 260, minWidth: 180, tooltipField: 'entry', cellRenderer: (p) => (p.node.rowPinned ? '' : `${esc(p.value)}${p.data.farmer_approved ? ' <span class="pill escalate">approved by you</span>' : ''}`) },
      { colId: 'in', headerName: 'In', filter: false, width: 100, type: 'rightAligned', valueGetter: (p) => (p.node.rowPinned ? p.data.in : p.data.settled && p.data.amount > 0 ? p.data.amount : null), valueFormatter: (p) => (p.value ? usd(p.value) : ''), cellClass: 'num-in' },
      { colId: 'out', headerName: 'Out', filter: false, width: 90, type: 'rightAligned', valueGetter: (p) => (p.node.rowPinned ? p.data.out : p.data.amount < 0 ? -p.data.amount : null), valueFormatter: (p) => (p.value ? `−${usd(p.value)}` : ''), cellClass: 'num-out' },
      { colId: 'pending', headerName: 'Pending', filter: false, width: 95, type: 'rightAligned', valueGetter: (p) => (p.node.rowPinned ? p.data.pending : p.data.settled ? null : p.data.amount), valueFormatter: (p) => (p.value ? usd(p.value) : '') },
      { field: 'balance', headerName: 'Net balance', filter: false, width: 115, type: 'rightAligned', valueFormatter: (p) => usd(p.value), cellRenderer: (p) => (p.node.rowPinned ? `<b>${usd(p.value)}</b>` : usd(p.value)) },
      { field: 'api', headerName: 'PayPal API', width: 170, tooltipField: 'api' },
      { field: 'paypal_id', headerName: 'PayPal ID', width: 150, cellClass: 'mono', tooltipField: 'paypal_id' },
      { colId: 'check', headerName: 'PayPal says', width: 135, valueGetter: (p) => (p.node.rowPinned ? p.data.check : p.data.check ? `${p.data.check.ok ? '✓' : '✗'} ${p.data.check.status.replace(/_/g, ' ').toLowerCase()}${p.data.check.note ? ` · ${p.data.check.note}` : ''}` : ''),
        cellClassRules: { 'check-ok': (p) => p.data?.check?.ok === true, 'check-bad': (p) => p.data?.check?.ok === false }, tooltipValueGetter: (p) => p.value },
    ],
    onRowClicked: (p) => { if (p.data?.message_id) selectMessage(p.data.message_id); },
  });
  $('btn-ledger-csv').addEventListener('click', () => ledger.exportDataAsCsv({ fileName: `boxday-paypal-ledger-week${S.farm.current_week}.csv`, skipPinnedBottom: false }));
  $('btn-reconcile').addEventListener('click', async () => {
    const btn = $('btn-reconcile');
    busy(btn, true, 'Checking with PayPal…');
    try {
      const r = await api('/api/ledger/reconcile', {});
      toast(`${r.ok} of ${r.checked} PayPal transactions match the ledger${r.ok === r.checked ? '.' : '; see the rows marked ✗.'}`, 5000);
    } catch (e) { toast(e.message); }
    busy(btn, false);
    await refresh();
  });
}

function renderLedger() {
  const L = S.ledger;
  if (!L) return;
  ledger.setGridOption('rowData', L.rows);
  const checked = L.rows.filter((r) => r.check);
  const okN = checked.filter((r) => r.check.ok).length;
  ledger.setGridOption('pinnedBottomRowData', [{ id: 'totals', member: 'Totals', in: L.totals.collected, out: L.totals.refunded, pending: L.totals.pending, balance: L.totals.net, check: checked.length ? `${okN}/${L.rows.length} match` : '' }]);
  $('ledger-kpis').innerHTML = `<span class="kpi">Collected <b>${usd(L.totals.collected)}</b></span><span class="kpi">Refunded <b>${usd(L.totals.refunded)}</b></span><span class="kpi">Net <b>${usd(L.totals.net)}</b></span><span class="kpi">Pending <b>${usd(L.totals.pending)}</b></span>`;
  $('ledger-note').textContent = L.reconciled_at
    ? `Last reconciled with PayPal (${S.mode.paypal === 'sandbox' ? 'sandbox API' : 'offline mock'}) at ${new Date(L.reconciled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}: ${okN} of ${checked.length} transactions match. Orders are re-read with the Agent Toolkit's get_order, captures, refunds and invoices with the PayPal REST API.`
    : 'Season payments were captured at sign-up; refunds go back against them. Pending = pay links and invoices not yet paid. Click "Reconcile with PayPal" to re-read every transaction from PayPal.';
  // Flash rows that appeared since the last render.
  if (ledgerSeen) {
    const fresh = L.rows.filter((r) => !ledgerSeen.has(r.id)).map((r) => ledger.getRowNode(r.id)).filter(Boolean);
    if (fresh.length) ledger.flashCells({ rowNodes: fresh, flashDuration: 1600, fadeDuration: 1200 });
  }
  ledgerSeen = new Set(L.rows.map((r) => r.id));
}


// ------------------------------------------------------------------ statement
let stPeriod = 'week';
let stGrid = null;
const money0 = (p) => (p.value ? usd(p.value) : '');
function initStatement() {
  stGrid = agGrid.createGrid($('st-members'), {
    theme: agGrid.themeQuartz.withParams({ accentColor: '#3f6b2a', fontSize: 13, headerFontWeight: 600, wrapperBorderRadius: 10, headerBackgroundColor: '#f7f6f1' }),
    rowData: [],
    defaultColDef: { sortable: true, resizable: true, filter: false },
    autoSizeStrategy: { type: 'fitGridWidth', defaultMinWidth: 80 },
    columnDefs: [
      { field: 'member', headerName: 'Member', width: 150, minWidth: 140, filter: true, cellRenderer: (p) => (p.node.rowPinned ? `<b>${esc(p.value)}</b>` : esc(p.value)) },
      { field: 'season_share', headerName: 'Season share', type: 'rightAligned', valueFormatter: money0 },
      { field: 'add_ons', headerName: 'Add-ons', type: 'rightAligned', valueFormatter: money0 },
      { field: 'other_in', headerName: 'Other', type: 'rightAligned', valueFormatter: money0 },
      { field: 'refunds', headerName: 'Refunds', type: 'rightAligned', valueFormatter: (p) => (p.value ? `−${usd(p.value)}` : ''), cellClass: 'num-out' },
      { field: 'fees', headerName: 'PayPal fees', type: 'rightAligned', valueFormatter: (p) => (p.value ? `−${usd(p.value)}` : ''), cellClass: 'num-out' },
      { field: 'net', headerName: 'Net', type: 'rightAligned', valueFormatter: money0 },
      { field: 'owed', headerName: 'Still owed', type: 'rightAligned', valueFormatter: money0, cellClass: (p) => (p.value ? 'cell-hot' : '') },
    ],
    onRowClicked: (p) => { const r = (S.receivables || []).find((x) => x.member_name === p.data?.member && x.status !== 'paid'); if (r) selectMessage(r.id); },
  });
  document.querySelectorAll('#st-period button').forEach((b) => b.addEventListener('click', () => { stPeriod = b.dataset.p; renderStatement(); }));
  $('btn-st-csv').addEventListener('click', exportStatement);
}
function renderStatement() {
  const st = S.statement;
  if (!st) return;
  document.querySelectorAll('#st-period button').forEach((b) => b.classList.toggle('on', b.dataset.p === stPeriod));
  const t = st.totals[stPeriod];
  $('st-kpis').innerHTML = `
    <div class="tile in"><div class="v">${usd(t.collected)}</div><div class="k">collected through PayPal</div></div>
    <div class="tile out"><div class="v">−${usd(t.refunded)}</div><div class="k">refunded</div></div>
    <div class="tile out"><div class="v">−${usd(t.fees)}</div><div class="k">PayPal fees</div></div>
    <div class="tile"><div class="v">${usd(t.net)}</div><div class="k">net to the farm</div></div>
    <div class="tile wait"><div class="v">${usd(st.totals.owed)}</div><div class="k">still owed</div></div>`;
  const cats = st.by_category.filter((c) => c[stPeriod]);
  $('st-cats').innerHTML = `<tr><th>Category</th><th class="n">${stPeriod === 'week' ? 'This week' : 'Season'}</th></tr>
    ${cats.map((c) => `<tr><td>${esc(c.category)}</td><td class="n ${c[stPeriod] < 0 ? 'neg' : ''}">${c[stPeriod] < 0 ? '−' : ''}${usd(Math.abs(c[stPeriod]))}</td></tr>`).join('')}
    <tr><td>PayPal fees</td><td class="n neg">−${usd(t.fees)}</td></tr>
    <tr class="total"><td>Net</td><td class="n">${usd(t.net)}</td></tr>`;
  const members = st.by_member;
  stGrid.setGridOption('rowData', members);
  const sum = (k) => Math.round(members.reduce((s, m) => s + m[k], 0) * 100) / 100;
  stGrid.setGridOption('pinnedBottomRowData', [{ member: 'All members', season_share: sum('season_share'), add_ons: sum('add_ons'), other_in: sum('other_in'), refunds: sum('refunds'), fees: sum('fees'), net: sum('net'), owed: sum('owed') }]);
  $('st-mismatch').innerHTML = st.mismatches.length ? `<div class="mismatch"><b>Needs a look (${st.mismatches.length}), from the last reconciliation:</b><ul class="rules-list">${st.mismatches.map((m) => `<li><b>${esc(m.member)}</b> · ${esc(m.entry)}: ${esc(m.note)}</li>`).join('')}</ul></div>` : '';
  $('st-note').textContent = `By member is season to date. PayPal fees: ${st.fee_source}.${t.fee_unknown ? ` ${t.fee_unknown === 1 ? '1 paid PayPal invoice has' : `${t.fee_unknown} paid PayPal invoices have`} no fee in Boxday's records yet; PayPal shows it in your activity report.` : ''}`;
}
function exportStatement() {
  const st = S.statement;
  const q = (v) => `"${String(v).replaceAll('"', '""')}"`;
  const lines = [[`${S.farm.name} statement`, new Date().toLocaleString('en-US')], [], ['Period', 'Collected', 'Refunded', 'PayPal fees', 'Net'],
    ...['week', 'season'].map((k) => [k === 'week' ? 'This week' : 'Season to date', st.totals[k].collected, st.totals[k].refunded, st.totals[k].fees, st.totals[k].net]),
    ['Still owed', st.totals.owed], [], ['Category', 'This week', 'Season to date'], ...st.by_category.map((c) => [c.category, c.week, c.season]),
    [], ['Member', 'Season share', 'Add-ons', 'Other', 'Refunds', 'PayPal fees', 'Net', 'Still owed'], ...st.by_member.map((m) => [m.member, m.season_share, m.add_ons, m.other_in, m.refunds, m.fees, m.net, m.owed]),
    [], ['PayPal fees source', st.fee_source]];
  const blob = new Blob([lines.map((l) => l.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `boxday-statement-week${S.farm.current_week}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ boot
async function refresh() {
  S = await api('/api/state');
  $('farm-name').textContent = `· ${S.farm.name}`;
  $('week-line').textContent = `Week ${S.farm.current_week} of ${S.farm.season_weeks} · ${S.members.filter((m) => !m.cancelled).length} members · Ruth's member desk`;
  $('badge-paypal').textContent = S.mode.paypal === 'sandbox' ? 'PayPal: sandbox (live API)' : 'PayPal: offline mock';
  $('badge-paypal').classList.toggle('live', S.mode.paypal === 'sandbox');
  $('badge-llm').textContent = S.mode.llm.provider === 'heuristic' ? 'AI: rule-based (no model)' : `AI: ${S.mode.llm.model} (${S.mode.llm.provider === 'ollama' ? 'local Ollama' : 'OpenAI-compatible'})`;
  $('badge-llm').classList.toggle('live', S.mode.llm.provider !== 'heuristic' && !llmDown);
  if (llmDown && S.mode.llm.provider !== 'heuristic') $('badge-llm').textContent = `AI: ${S.mode.llm.model} unreachable, rule-based fallback`;
  $('btn-wallet').classList.toggle('hidden', !(S.mode.paypal === 'sandbox' && !S.mode.season_payments));
  if (!selected || !S.messages.some((m) => m.id === selected)) selected = S.messages.find((m) => m.status === 'needs_farmer')?.id || S.messages.at(-1)?.id || null;
  renderTonight();
  renderSheet();
  renderMoney();
  renderLedger();
  renderStatement();
  renderRules();
}

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('Restore the demo evening (members, messages, PayPal season payments, rules)?')) return;
  const btn = $('btn-reset');
  busy(btn, true, 'Resetting…');
  await api('/api/reset', {});
  selected = null; lastFlash = 0; ledgerSeen = null;
  $('teach-result').innerHTML = '';
  busy(btn, false);
  await refresh();
  showTab('tonight');
});
$('btn-wallet').addEventListener('click', async () => {
  try { const r = await api('/api/sandbox/wallet', {}); location.href = r.approve_url; } catch (e) { toast(e.message); }
});

(async function boot() {
  initSheet();
  initMoney();
  initLedger();
  initStatement();
  try { const h = await api('/api/health'); llmDown = h.llm.provider !== 'heuristic' && !h.llm.ok; } catch { /* keep default */ }
  await refresh();
  const q = new URLSearchParams(location.search);
  if (q.get('paid')) { const a = S.actions.find((x) => x.id === q.get('paid')); if (a) { selectMessage(a.message_id); toast(a.status === 'done' ? `${a.member_name} paid ${usd(a.money.amount)} through PayPal.` : 'Payment not completed.'); } }
  if (q.get('paid_rc')) { const r = (S.receivables || []).find((x) => x.id === q.get('paid_rc')); if (r) { selectMessage(r.id); toast(r.status === 'paid' ? `${r.member_name} paid ${usd(r.amount)} through PayPal.` : 'Payment not completed.'); } }
  if (q.get('wallet') === 'linked') toast('Sandbox buyer wallet saved; season payments created in the PayPal sandbox.');
  if (q.get('wallet') === 'error') toast(`Wallet setup failed: ${q.get('reason') || ''}`, 8000);
  if ([...q.keys()].length) history.replaceState(null, '', '/');
})();
