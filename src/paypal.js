// PayPal adapter with two interchangeable backends:
//   sandbox — PayPal Agent Toolkit tools (create_order, get_order, pay_order, create_refund,
//             list_transactions) plus direct REST calls for Vault v3 (save the user's PayPal
//             wallet once, then charge it within the mandate without the user present).
//   mock    — the same surface, simulated in-process, for fully offline demos and tests.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import toolkitPkg from '@paypal/agent-toolkit/openai';
import Ajv from 'ajv';
import { config } from './config.js';

const { PayPalAgentToolkit } = toolkitPkg;

export const TOOLKIT_ACTIONS = {
  orders: { create: true, get: true, capture: true },
  payments: { createRefund: true },
  invoices: { create: true, send: true, get: true, sendReminder: true },
  transactions: { list: true },
};

/** Toolkit `create_invoice` arguments for a late-joining member. */
export function invoiceArgs({ farmName, email, name, lines, note, reference }) {
  const [given, ...rest] = String(name || '').split(' ');
  return {
    currency_code: 'USD',
    invoice_date: new Date().toISOString().slice(0, 10),
    reference,
    note,
    invoicer_business_name: farmName,
    primary_recipients: [{ billing_info: { email_address: email, ...(given ? { name: { given_name: given, surname: rest.join(' ') || undefined } } : {}) } }],
    items: lines.map((l) => ({ name: l.name.slice(0, 200), quantity: String(l.quantity), unit_amount: money(l.unit_price), unit_of_measure: 'QUANTITY' })),
  };
}

const id = (n = 17) => randomBytes(n).toString('hex').toUpperCase().slice(0, n);
const money = (v) => ({ currency_code: 'USD', value: Number(v).toFixed(2) });

/** Toolkit `create_order` arguments for a firewall-approved intent. */
export function toolkitOrderArgs(intent, { returnUrl, cancelUrl, note }) {
  return {
    currencyCode: 'USD',
    items: intent.items.map((i) => ({
      name: i.name.slice(0, 127),
      quantity: i.quantity,
      itemCost: i.unit_price,
      taxPercent: 0,
      itemTotal: Math.round(i.unit_price * i.quantity * 100) / 100,
      description: `${intent.merchant.name}`.slice(0, 127),
    })),
    notes: note,
    returnUrl,
    cancelUrl,
  };
}

/** Orders v2 body for a merchant-initiated charge against a vaulted PayPal wallet. */
function vaultOrderBody(intent, { vaultId, customId, invoiceId }) {
  const itemTotal = intent.items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: intent.merchant.id,
      description: `${intent.merchant.name} (Boxday)`.slice(0, 127),
      custom_id: customId,
      invoice_id: invoiceId,
      soft_descriptor: "BOXDAY FARM",
      amount: { ...money(itemTotal), breakdown: { item_total: money(itemTotal) } },
      items: intent.items.map((i) => ({ name: i.name.slice(0, 127), quantity: String(i.quantity), unit_amount: money(i.unit_price), category: 'PHYSICAL_GOODS' })),
    }],
    payment_source: { paypal: { vault_id: vaultId } },
  };
}

const linkOf = (obj, ...rels) => obj?.links?.find((l) => rels.includes(l.rel))?.href || null;
const captureOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null;
/** PayPal's fee on a capture, from its seller_receivable_breakdown (null if PayPal did not report one). */
const feeOf = (cap) => (cap?.seller_receivable_breakdown?.paypal_fee?.value != null ? Number(cap.seller_receivable_breakdown.paypal_fee.value) : null);

// ---------------------------------------------------------------- sandbox
function sandboxBackend() {
  const toolkit = new PayPalAgentToolkit({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } },
  });
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60e3) return token;
    const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
    const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`PayPal auth failed: ${j.error_description || res.status}`);
    token = j.access_token;
    tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function rest(method, url, body) {
    const res = await fetch(`${config.paypal.baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
        'paypal-request-id': randomUUID(), // idempotency key
        prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const j = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = j.details?.map((d) => d.description || d.issue).join('; ');
      throw new Error(`PayPal ${method} ${url} -> ${res.status} ${j.name || ''} ${detail || j.message || ''}`.trim());
    }
    return j;
  }

  return {
    mode: 'sandbox',
    tools: () => toolkit.getTools(),
    async callTool(name, args) {
      const msg = await toolkit.handleToolCall({ id: `call_${id(8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const out = JSON.parse(msg.content);
      if (out?.error) throw new Error(`Agent Toolkit ${name}: ${out.error.message || JSON.stringify(out.error)}`);
      return out;
    },
    async createWalletSetup({ returnUrl, cancelUrl, description }) {
      const st = await rest('POST', '/v3/vault/setup-tokens', {
        payment_source: {
          paypal: {
            description: description.slice(0, 127),
            usage_type: 'MERCHANT',
            experience_context: { brand_name: "Little Bluestem Farm", return_url: returnUrl, cancel_url: cancelUrl },
          },
        },
      });
      return { setup_token_id: st.id, approve_url: linkOf(st, 'approve', 'payer-action') };
    },
    async finalizeWallet(setupTokenId) {
      const pt = await rest('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } });
      return { payment_token_id: pt.id, customer_id: pt.customer?.id || null, payer_email: pt.payment_source?.paypal?.email_address || null };
    },
    async chargeWallet(intent, opts) {
      const order = await rest('POST', '/v2/checkout/orders', vaultOrderBody(intent, opts));
      const cap = captureOf(order);
      return { order_id: order.id, status: order.status, capture_id: cap?.id || null, capture_status: cap?.status || null, fee: feeOf(cap) };
    },
    /** Re-read one ledger object from PayPal: { status, amount }. */
    async verify(kind, objectId) {
      if (kind === 'order') {
        const o = await this.callTool('get_order', { id: objectId });
        return { status: o.status, amount: Number(o.purchase_units?.[0]?.amount?.value ?? NaN) };
      }
      if (kind === 'invoice') {
        const inv = await rest('GET', `/v2/invoicing/invoices/${objectId}`);
        return { status: inv.status, amount: Number(inv.amount?.value ?? NaN) };
      }
      const x = await rest('GET', `/v2/payments/${kind === 'refund' ? 'refunds' : 'captures'}/${objectId}`);
      return { status: x.status, amount: Number(x.amount?.value ?? NaN) };
    },
  };
}

// ---------------------------------------------------------------- mock
function mockBackend() {
  const file = path.join(config.dataDir, 'mock-paypal.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { orders: {}, setupTokens: {}, paymentTokens: {}, refunds: {} };
  const save = () => { mkdirSync(config.dataDir, { recursive: true }); writeFileSync(file, JSON.stringify(state, null, 2)); };
  const base = `${config.publicUrl}/mock-paypal`;

  const orderFromItems = (items, extra = {}) => {
    const total = items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
    return { id: id(17), intent: 'CAPTURE', create_time: new Date().toISOString(), purchase_units: [{ amount: money(total), items, ...extra.unit }], ...extra.order };
  };
  // Illustrative fee so the statement has something to add up offline. The sandbox reports PayPal's real fee.
  const MOCK_FEE = (v) => Math.round((v * 0.0349 + 0.49) * 100) / 100;
  const capture = (o) => {
    o.status = 'COMPLETED';
    const gross = Number(o.purchase_units[0].amount.value);
    const fee = MOCK_FEE(gross);
    o.purchase_units[0].payments = { captures: [{ id: id(17), status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: new Date().toISOString(),
      seller_receivable_breakdown: { gross_amount: money(gross), paypal_fee: money(fee), net_amount: money(gross - fee) } }] };
  };

  const tools = {
    create_order(a) {
      const items = a.items.map((i) => ({ name: i.name, quantity: String(i.quantity), unit_amount: money(i.itemCost) }));
      const o = orderFromItems(items, { order: { status: 'PAYER_ACTION_REQUIRED', return_url: a.returnUrl, cancel_url: a.cancelUrl } });
      o.links = [{ rel: 'self', href: `mock://v2/checkout/orders/${o.id}` }, { rel: 'payer-action', href: `${base}/checkout?token=${o.id}` }];
      state.orders[o.id] = o;
      save();
      return o;
    },
    get_order({ id: oid }) {
      const o = state.orders[oid];
      if (!o) throw new Error(`Mock PayPal: order ${oid} not found`);
      return o;
    },
    pay_order({ id: oid }) {
      const o = tools.get_order({ id: oid });
      if (o.status !== 'APPROVED') return { status: 'error', response: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
      capture(o);
      save();
      return { status: 'success', response: o };
    },
    create_refund({ capture_id, amount }) {
      const o = Object.values(state.orders).find((x) => captureOf(x)?.id === capture_id);
      if (!o) throw new Error(`Mock PayPal: capture ${capture_id} not found`);
      const cap = captureOf(o);
      const value = Number(amount?.value ?? cap.amount.value);
      const left = Number(cap.amount.value) - (cap.refunded || 0);
      if (value > left + 1e-9) throw new Error(`Mock PayPal: refund ${value} exceeds refundable ${left.toFixed(2)}`);
      cap.refunded = Math.round(((cap.refunded || 0) + value) * 100) / 100;
      cap.status = cap.refunded >= Number(cap.amount.value) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const r = { id: id(17), status: 'COMPLETED', amount: money(value) };
      state.refunds[r.id] = r;
      save();
      return r;
    },
    create_invoice(a) {
      state.invoices ||= {};
      const inv = { id: `INV2-${id(4)}-${id(4)}-${id(4)}-${id(4)}`, status: 'DRAFT', detail: { reference: a.reference, note: a.note }, primary_recipients: a.primary_recipients, items: a.items };
      const total = a.items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
      inv.amount = money(total);
      state.invoices[inv.id] = inv;
      save();
      return { id: inv.id, status: inv.status, links: [{ rel: 'self', href: `mock://v2/invoicing/invoices/${inv.id}` }] };
    },
    send_invoice({ invoice_id }) {
      const inv = state.invoices?.[invoice_id];
      if (!inv) throw new Error(`Mock PayPal: invoice ${invoice_id} not found`);
      inv.status = 'SENT';
      save();
      return { links: [{ rel: 'payer-view', href: `${base}/invoice?token=${invoice_id}` }] };
    },
    get_invoice({ invoice_id }) {
      const inv = state.invoices?.[invoice_id];
      if (!inv) throw new Error(`Mock PayPal: invoice ${invoice_id} not found`);
      return { id: inv.id, status: inv.status, amount: inv.amount, detail: inv.detail };
    },
    send_invoice_reminder({ invoice_id, subject, note }) {
      const inv = state.invoices?.[invoice_id];
      if (!inv) throw new Error(`Mock PayPal: invoice ${invoice_id} not found`);
      if (inv.status !== 'SENT') throw new Error(`Mock PayPal: cannot remind an invoice in status ${inv.status}`);
      (inv.reminders ||= []).push({ at: new Date().toISOString(), subject, note });
      save();
      return {};
    },
    list_transactions() {
      return { transaction_details: Object.values(state.orders).filter((o) => o.status === 'COMPLETED').map((o) => ({ transaction_info: { transaction_id: captureOf(o).id, transaction_amount: captureOf(o).amount } })) };
    },
  };

  // The mock enforces the real Agent Toolkit's own parameter schemas, so anything that runs
  // offline sends arguments the toolkit would accept against the sandbox.
  const toolDefs = new PayPalAgentToolkit({ clientId: 'mock', clientSecret: 'mock', configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } } }).getTools();
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = Object.fromEntries(toolDefs.map((t) => [t.function.name, ajv.compile(t.function.parameters)]));

  return {
    mode: 'mock',
    state,
    tools: () => toolDefs,
    async callTool(name, args) {
      if (!tools[name]) throw new Error(`Mock PayPal: tool ${name} not enabled`);
      const valid = validators[name];
      if (!valid(args)) throw new Error(`Agent Toolkit ${name}: arguments rejected by the toolkit schema: ${ajv.errorsText(valid.errors)}`);
      return structuredClone(tools[name](args));
    },
    async createWalletSetup({ returnUrl, cancelUrl, description }) {
      const st = { id: `MOCKST-${id(10)}`, status: 'PAYER_ACTION_REQUIRED', description, return_url: returnUrl, cancel_url: cancelUrl };
      state.setupTokens[st.id] = st;
      save();
      return { setup_token_id: st.id, approve_url: `${base}/vault?token=${st.id}` };
    },
    async finalizeWallet(setupTokenId) {
      const st = state.setupTokens[setupTokenId];
      if (!st || st.status !== 'APPROVED') throw new Error('Mock PayPal: setup token not approved');
      const pt = { id: `MOCKPT-${id(10)}`, customer_id: `MOCKCUST-${id(6)}`, payer_email: 'buyer@example.test' };
      state.paymentTokens[pt.id] = pt;
      save();
      return { payment_token_id: pt.id, customer_id: pt.customer_id, payer_email: pt.payer_email };
    },
    async chargeWallet(intent, opts) {
      if (!state.paymentTokens[opts.vaultId]) throw new Error('Mock PayPal: unknown vault_id');
      const body = vaultOrderBody(intent, opts);
      const o = orderFromItems(body.purchase_units[0].items, { unit: { custom_id: opts.customId, invoice_id: opts.invoiceId } });
      capture(o);
      state.orders[o.id] = o;
      save();
      return { order_id: o.id, status: o.status, capture_id: captureOf(o).id, capture_status: 'COMPLETED', fee: feeOf(captureOf(o)) };
    },
    // Mock-only: a member's PayPal wallet that was saved at sign-up.
    async mockWallet() {
      const pt = { id: `MOCKPT-${id(10)}`, customer_id: `MOCKCUST-${id(6)}`, payer_email: 'member@example.com' };
      state.paymentTokens[pt.id] = pt;
      return { payment_token_id: pt.id, customer_id: pt.customer_id };
    },
    async verify(kind, objectId) {
      if (kind === 'order') { const o = state.orders[objectId]; if (!o) throw new Error('not found'); return { status: o.status, amount: Number(o.purchase_units[0].amount.value) }; }
      if (kind === 'invoice') { const inv = state.invoices?.[objectId]; if (!inv) throw new Error('not found'); return { status: inv.status, amount: Number(inv.amount.value) }; }
      if (kind === 'refund') { const r = state.refunds[objectId]; if (!r) throw new Error('not found'); return { status: r.status, amount: Number(r.amount.value) }; }
      const cap = Object.values(state.orders).map(captureOf).find((c) => c?.id === objectId);
      if (!cap) throw new Error('not found');
      return { status: cap.status, amount: Number(cap.amount.value) };
    },
    invoice(tokenId) { return state.invoices?.[tokenId] || null; },
    payInvoice(tokenId) {
      const inv = state.invoices?.[tokenId];
      if (inv) { inv.status = 'PAID'; save(); }
      return inv;
    },
    // Mock-only: what the buyer's click on the approval page does.
    approve(kind, tokenId) {
      const bag = kind === 'vault' ? state.setupTokens : state.orders;
      if (!bag[tokenId]) return null;
      bag[tokenId].status = 'APPROVED';
      save();
      return bag[tokenId];
    },
    lookup(kind, tokenId) {
      return (kind === 'vault' ? state.setupTokens : state.orders)[tokenId] || null;
    },
  };
}

export const paypal = config.paypalMode === 'sandbox' ? sandboxBackend() : mockBackend();
export { linkOf, captureOf, feeOf };
