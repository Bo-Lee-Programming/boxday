import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './src/config.js';
import { db, save, seed, actionById, messageById, memberById } from './src/state.js';
import { FARM, SITES, SHARES, ADDONS, BOX, pickupTime } from './src/farm.js';
import { compilePolicy, normalizePolicy, teachRule, POLICY_LABELS } from './src/policy.js';
import { processMessage, decide, completeMemberPayment, previewPolicy, applyPolicy } from './src/agent.js';
import { refundable } from './src/rules.js';
import { paypal } from './src/paypal.js';
import { llmInfo, llmHealth } from './src/llm.js';
import { buildLedger, reconcile, buildStatement } from './src/ledger.js';
import { chase, ageDays, stageFor, settleFromPayPal } from './src/collections.js';
import { agentCard, handleAgentRequest, agentRequestStatus, agentKeyFor } from './src/a2a.js';

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/classic.html': ['public/classic.html', 'text/html'],
  '/classic.js': ['public/classic.js', 'text/javascript'],
  '/tonight.css': ['public/tonight.css', 'text/css'],
  '/vendor/ag-grid-community.min.js': ['node_modules/ag-grid-community/dist/ag-grid-community.min.js', 'text/javascript'],
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

function snapshot() {
  return {
    mode: { paypal: paypal.mode, llm: llmInfo(), seeded: Boolean(db.seeded_at), season_payments: db.members?.some((m) => m.season.capture_id) },
    farm: { ...FARM.farm, current_week: db.week },
    default_policy: FARM.default_policy,
    shares: SHARES, addons: ADDONS, box: BOX,
    sites: Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, { label: s.label, pickup: db.anchor ? pickupTime(k, db.week, db.anchor) : null, cutoff: db.anchor ? new Date(pickupTime(k, db.week, db.anchor) - (db.policy?.skip_notice_hours ?? 48) * 3600e3) : null }])),
    policy: db.policy,
    stock: db.stock,
    members: (db.members || []).map((m) => ({ ...m, refundable: refundable(m) })),
    messages: db.messages || [],
    actions: db.actions || [],
    ledger: db.members ? buildLedger() : null,
    statement: db.members ? buildStatement() : null,
    receivables: (db.receivables || []).map((r) => ({ ...r, age_days: ageDays(r), stage: r.status === 'open' ? stageFor(r, db.policy) : null })),
    chased_at: db.chased_at || null,
  };
}

function mockPage(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body class="mock"><main class="mock-card"><p class="mock-banner">OFFLINE MOCK of a PayPal buyer page: no real money, no real PayPal. Put sandbox credentials in .env to use the real PayPal sandbox.</p>${inner}</main></body></html>`;
}

const routes = {
  'GET /api/state': async () => snapshot(),
  'POST /api/ledger/reconcile': async () => reconcile(),
  'POST /api/collections/chase': async () => ({ results: await chase() }),

  // ---- agent-to-agent: members' own AI assistants talk to the farm's agent
  'GET /.well-known/agent.json': async () => agentCard(),
  'GET /.well-known/agent-card.json': async () => agentCard(),
  // Human-readable view of the same card (what a member's assistant reads).
  'GET /agent': async (req, res) => {
    const card = agentCard();
    return send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(card.name)}: agent card</title><link rel="stylesheet" href="/style.css">
<style>body{padding:28px 40px;max-width:1100px}h1{font-size:24px;margin:0 0 4px}.skills{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}.sk{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px}.sk code{display:block;margin-top:8px;background:#f2f4f7;border-radius:6px;padding:6px 8px;white-space:pre-wrap}pre{background:#1b2230;color:#e8eaf0;border-radius:12px;padding:14px 16px;font-size:12px;max-height:330px;overflow:auto}</style></head>
<body><p class="muted">What a member's own AI assistant reads at <code>/.well-known/agent.json</code></p><h1>${esc(card.name)}</h1><p>${esc(card.description)}</p>
<p><b>Send to:</b> <code>POST ${esc(card.url)}</code> · <b>Auth:</b> the member's own agent key (bearer). It only acts on that member's share.</p>
<div class="skills">${card.skills.map((s) => `<div class="sk"><b>${esc(s.name)}</b><div class="muted">${esc(s.description)}</div><code>${esc(s.examples[0])}</code></div>`).join('')}</div>
<pre>${esc(JSON.stringify(card, null, 2))}</pre></body></html>`, 'text/html');
  },
  'POST /a2a/requests': async (req, res) => {
    let parsed;
    try { parsed = await body(req); } catch { return send(res, 400, { error: 'Body must be JSON.' }); }
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const r = await handleAgentRequest(key, parsed);
    return send(res, r.status, r.body);
  },
  'GET /a2a/requests': async (req, res, url) => {
    const r = agentRequestStatus((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), url.searchParams.get('id'));
    return send(res, r.status, r.body);
  },
  // Farmer side (local app): the key a member pastes into their own assistant.
  'GET /api/members/agent-key': async (req, res, url) => {
    const m = memberById(url.searchParams.get('member'));
    if (!m) throw fail('Unknown member', 404);
    return { member: m.name, key: agentKeyFor(m.id) };
  },
  'GET /api/health': async () => ({ paypal: paypal.mode, llm: { ...llmInfo(), ...(await llmHealth()) } }),

  'POST /api/policy/compile': async (req) => {
    const { text } = await body(req);
    if (!text || text.length < 20) throw fail('Write the farm rules in a sentence or two.');
    return compilePolicy(text.slice(0, 2000));
  },
  'POST /api/policy/teach': async (req) => {
    const { sentence } = await body(req);
    if (!sentence || sentence.trim().length < 8) throw fail('Write the rule as a sentence.');
    if (!db.policy) throw fail('Set up the farm rules first.');
    const t = await teachRule(sentence.trim().slice(0, 400), db.policy);
    const next = { ...db.policy };
    for (const c of t.changes) next[c.key] = c.to;
    return { ...t, impacts: t.changes.length ? previewPolicy(next) : [] };
  },
  'POST /api/policy/apply': async (req) => {
    const { sentence, changes } = await body(req);
    if (!Array.isArray(changes) || !changes.length) throw fail('Nothing to change.');
    const next = { ...db.policy };
    for (const c of changes) {
      if (!(c.key in POLICY_LABELS)) throw fail(`Unknown setting ${c.key}`);
      next[c.key] = typeof db.policy[c.key] === 'boolean' ? Boolean(c.to) : Math.max(0, Number(c.to));
    }
    return applyPolicy(next, String(sentence || '').slice(0, 400));
  },
  'POST /api/policy/confirm': async (req) => {
    const { policy } = await body(req);
    db.policy = { ...normalizePolicy(policy, policy.source_text || ''), confirmed_at: new Date().toISOString() };
    save();
    return db.policy;
  },

  'POST /api/messages/new': async (req) => {
    const { from, text } = await body(req);
    if (!/^[^@\s]+@[^@\s]+$/.test(from || '') || !text) throw fail('Need a sender email and a message.');
    const msg = { id: `msg_${Date.now().toString(36)}`, from: from.trim(), text: String(text).slice(0, 1000), received_at: new Date().toISOString(), status: 'new' };
    db.messages.push(msg);
    save();
    return msg;
  },
  'POST /api/messages/process': async (req, res) => {
    const { id, all } = await body(req);
    const queue = all ? db.messages.filter((m) => m.status === 'new') : [messageById(id)].filter(Boolean);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    for (const msg of queue) {
      if (msg.status !== 'new') continue;
      try {
        await processMessage(msg, (s) => res.write(JSON.stringify(s) + '\n'));
      } catch (err) {
        res.write(JSON.stringify({ kind: 'error', message_id: msg.id, message: String(err.message || err) }) + '\n');
      }
    }
    res.end();
    return undefined;
  },

  'POST /api/actions/decide': async (req) => {
    const { id, approve } = await body(req);
    const a = actionById(id);
    if (!a) throw fail('Unknown action', 404);
    await decide(a, Boolean(approve));
    const msg = messageById(a.message_id);
    if (msg && !db.actions.some((x) => x.message_id === msg.id && x.status === 'awaiting_farmer')) msg.status = 'answered';
    save();
    return a;
  },

  'POST /api/sheet/edit': async (req) => {
    const { member_id, field, value } = await body(req);
    const m = memberById(member_id);
    if (!m) throw fail('Unknown member', 404);
    if (field === 'site' && SITES[value]) m.site = value;
    else if (field === 'share' && SHARES[value]) m.share = value;
    else if (field === 'status' && ['packing', 'skipped', 'donated', 'cancelled'].includes(value)) m.week.status = value;
    else if (field === 'notes') m.week.notes = String(value).slice(0, 200);
    else if (field.startsWith('addon_') && ADDONS[field.slice(6)]) {
      const k = field.slice(6);
      const v = Math.max(0, Math.round(Number(value) || 0));
      db.stock[k] -= v - m.week.addons[k];
      m.week.addons[k] = v;
    } else throw fail(`Field ${field} is not editable`);
    m.changed = [field];
    m.changed_at = new Date().toISOString();
    m.edited_by_farmer = true;
    save();
    return m;
  },

  'POST /api/reset': async () => {
    if (paypal.mode === 'sandbox') {
      const token = db.demo_wallet;
      await seed({ sandboxWallet: token || null });
      db.demo_wallet = token;
      save();
    } else await seed();
    return { ok: true };
  },

  // ---- sandbox: save the demo buyer's wallet once, then seed real season payments
  'POST /api/sandbox/wallet': async () => {
    if (paypal.mode !== 'sandbox') throw fail('Only needed in sandbox mode.');
    const r = await paypal.createWalletSetup({ description: `${FARM.farm.name} demo members: season shares and add-ons`, returnUrl: `${config.publicUrl}/paypal/vault-return`, cancelUrl: `${config.publicUrl}/?wallet=cancelled` });
    db.wallet_pending = r.setup_token_id;
    save();
    return r;
  },
  'GET /paypal/vault-return': async (req, res) => {
    try {
      const w = await paypal.finalizeWallet(db.wallet_pending);
      await seed({ sandboxWallet: w.payment_token_id });
      db.demo_wallet = w.payment_token_id;
      save();
      return redirect(res, '/?wallet=linked');
    } catch (err) {
      console.error(err);
      return redirect(res, `/?wallet=error&reason=${encodeURIComponent(String(err.message).slice(0, 200))}`);
    }
  },

  // ---- member returns from PayPal after paying an add-on link
  'GET /paypal/return': async (req, res, url) => {
    const a = actionById(url.searchParams.get('action'));
    if (a) await completeMemberPayment(a);
    if (!a) {
      // A pay link from an earlier week: PayPal appends the order id as token.
      const rc = (db.receivables || []).find((r) => r.paypal.order_id === url.searchParams.get('token'));
      if (rc) { await settleFromPayPal(rc); save(); return redirect(res, `/?paid_rc=${rc.id}`); }
    }
    return redirect(res, `/?paid=${a?.id || ''}`);
  },
  'GET /paypal/cancel': async (req, res, url) => {
    const a = actionById(url.searchParams.get('action'));
    if (a && a.status === 'awaiting_member') { a.status = 'declined'; save(); }
    return redirect(res, '/');
  },

  // ---- offline stand-ins for PayPal buyer pages
  'GET /mock-paypal/checkout': async (req, res, url) => {
    const o = paypal.lookup?.('order', url.searchParams.get('token'));
    if (!o) return send(res, 404, 'Unknown order', 'text/plain');
    const u = o.purchase_units[0];
    return send(res, 200, mockPage('Pay with PayPal (mock)', `<h1>${esc(FARM.farm.name)}</h1>
      <table class="mock-table"><tr><th>Item</th><th>Qty</th><th>Price</th></tr>${u.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>$${i.unit_amount.value}</td></tr>`).join('')}</table>
      <p class="mock-total">Total <b>$${u.amount.value}</b></p>
      <form method="post" action="/mock-paypal/decide"><input type="hidden" name="kind" value="order"><input type="hidden" name="token" value="${esc(o.id)}">
      <button name="decision" value="approve" class="btn primary">Pay now</button> <button name="decision" value="cancel" class="btn">Cancel</button></form>
      <p class="muted">Signed in as a mock buyer</p>`), 'text/html');
  },
  'GET /mock-paypal/invoice': async (req, res, url) => {
    const inv = paypal.invoice?.(url.searchParams.get('token'));
    if (!inv) return send(res, 404, 'Unknown invoice', 'text/plain');
    return send(res, 200, mockPage('Invoice (mock)', `<h1>Invoice from ${esc(FARM.farm.name)}</h1><p class="muted">${esc(inv.id)} · ${esc(inv.status)}</p>
      <table class="mock-table"><tr><th>Item</th><th>Qty</th><th>Price</th></tr>${inv.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>$${i.unit_amount.value}</td></tr>`).join('')}</table>
      <p class="mock-total">Total <b>$${inv.amount.value}</b></p><p>${esc(inv.detail.note || '')}</p>`), 'text/html');
  },
  'POST /mock-paypal/decide': async (req, res) => {
    const { kind, token, decision } = await body(req);
    const obj = paypal.lookup?.(kind, token);
    if (!obj) return send(res, 404, 'Unknown token', 'text/plain');
    if (decision === 'approve') paypal.approve(kind, token);
    const target = decision === 'approve' ? obj.return_url : obj.cancel_url;
    return redirect(res, `${target}${target.includes('?') ? '&' : '?'}token=${token}&PayerID=MOCKBUYER`);
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, config.publicUrl);
  try {
    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) return send(res, 200, await readFile(path.join(ROOT, file[0])), file[1]);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'not found' });
    const out = await handler(req, res, url);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: String(err.message || err) });
  }
});

if (!db.seeded_at) await seed();
server.listen(config.port, () => {
  console.log(`Boxday on ${config.publicUrl}  |  PayPal: ${paypal.mode}  |  LLM: ${llmInfo().provider} ${llmInfo().model}`);
});
