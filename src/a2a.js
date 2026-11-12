// Agent-to-agent entry point. A member's own AI assistant can send the farm's agent
// structured requests (skip a week, add-ons, pickup change) with that member's agent key.
// They go through exactly the same rules and PayPal flow as a typed message; there is no
// free text for a model to misread, and the key decides whose share it is.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Ajv from 'ajv';
import { db, save } from './state.js';
import { processMessage } from './agent.js';
import { FARM, ADDONS, SITES } from './farm.js';
import { config } from './config.js';

const REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requests'],
  properties: {
    agent: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 60 } } },
    requests: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'skip_week' }, week: { enum: ['this', 'next'] } } },
          { type: 'object', additionalProperties: false, required: ['type', 'addon', 'quantity'], properties: { type: { const: 'add_on' }, addon: { enum: Object.keys(ADDONS) }, quantity: { type: 'integer', minimum: 1, maximum: 10 }, week: { enum: ['this', 'next'] } } },
          { type: 'object', additionalProperties: false, required: ['type', 'site'], properties: { type: { const: 'change_site' }, site: { enum: Object.keys(SITES) } } },
        ],
      },
    },
  },
};
const validate = new Ajv({ strict: false, allErrors: true }).compile(REQUEST_SCHEMA);

function secret() {
  if (!db.agent_secret) { db.agent_secret = randomBytes(24).toString('hex'); save(); }
  return db.agent_secret;
}
/** The key a member gives their own assistant (shown to the member on the farm's member page). */
export const agentKeyFor = (memberId) => `bxd_${memberId}_${createHmac('sha256', secret()).update(memberId).digest('hex').slice(0, 24)}`;

export function memberForKey(key) {
  const m = /^bxd_([a-z0-9_]+)_[0-9a-f]{24}$/.exec(String(key || ''));
  if (!m) return null;
  const member = db.members.find((x) => x.id === m[1]);
  if (!member) return null;
  const want = Buffer.from(agentKeyFor(member.id));
  const got = Buffer.from(String(key));
  return want.length === got.length && timingSafeEqual(want, got) ? member : null;
}

export function agentCard() {
  return {
    name: `${FARM.farm.name} member desk (Boxday)`,
    description: `Ask ${FARM.farm.name}'s agent to skip a week, add extras to a box, or change pickup site. Money moves through PayPal under the farmer's rules; anything outside them waits for the farmer.`,
    url: `${config.publicUrl}/a2a/requests`,
    version: '0.1.0',
    provider: { organization: FARM.farm.name },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { memberKey: { type: 'http', scheme: 'bearer', description: "The member's own agent key from the farm's member page. It only acts on that member's share." } },
    security: [{ memberKey: [] }],
    skills: [
      { id: 'skip_week', name: 'Skip a week', description: 'Skip this or next week\'s box. Refunded to PayPal if the farm\'s rules allow.', examples: ['{"type":"skip_week","week":"next"}'] },
      { id: 'add_on', name: 'Add to my box', description: `Add extras: ${Object.entries(ADDONS).map(([k, a]) => `${k} (${a.label}, $${a.price})`).join(', ')}. Charged to the saved PayPal wallet, or a PayPal pay link.`, examples: ['{"type":"add_on","addon":"eggs","quantity":2}'] },
      { id: 'change_site', name: 'Change pickup site', description: `Sites: ${Object.entries(SITES).map(([k, s]) => `${k} (${s.label})`).join(', ')}.`, examples: ['{"type":"change_site","site":"coop"}'] },
    ],
    request_schema: REQUEST_SCHEMA,
  };
}

const LINE = {
  skip_week: (r) => `Skip ${r.week === 'next' ? 'next' : 'this'} week's box.`,
  add_on: (r) => `Add ${r.quantity} × ${ADDONS[r.addon].label}${r.week === 'next' ? ' next week' : ''}.`,
  change_site: (r) => `Move my pickup to ${SITES[r.site].label}.`,
};

/** Handle one request from a member's agent; returns the outcome for that agent. */
export async function handleAgentRequest(key, body) {
  const member = memberForKey(key);
  if (!member) return { status: 401, body: { error: 'Unknown or missing member agent key.' } };
  if (!validate(body)) return { status: 400, body: { error: 'Request does not match the schema in the agent card.', details: validate.errors.map((e) => `${e.instancePath} ${e.message}`) } };
  const agentName = body.agent?.name || 'AI assistant';
  const requests = body.requests.map((r) => ({ ...r, week: r.week || 'this' }));
  const msg = {
    id: `msg_a2a_${Date.now().toString(36)}`,
    from: member.email,
    text: requests.map((r) => LINE[r.type](r)).join(' '),
    via: { kind: 'agent', name: agentName },
    structured: requests,
    received_at: new Date().toISOString(),
    status: 'new',
  };
  db.messages.push(msg);
  save();
  await processMessage(msg);
  const actions = db.actions.filter((a) => a.message_id === msg.id);
  return { status: 200, body: outcome(msg, actions) };
}

function outcome(msg, actions) {
  return {
    request_id: msg.id,
    status: msg.status === 'needs_farmer' ? 'waiting_for_farmer' : 'answered',
    results: actions.map((a) => ({
      type: a.type, summary: a.summary, decision: a.decision, status: a.status,
      reasons: a.decision === 'allow' ? [] : a.reasons,
      money: a.money ? { kind: a.money.kind, amount: a.money.amount, currency: 'USD' } : null,
      paypal: a.paypal?.tool ? { call: a.paypal.tool, order_id: a.paypal.order_id || null, capture_id: a.paypal.capture_id || null, refund_id: a.paypal.refund_id || null, pay_url: a.status === 'awaiting_member' ? a.paypal.pay_url : null, mode: a.paypal.mode } : null,
    })),
    reply: msg.reply,
  };
}

/** The member's agent can check back on a request that waited for the farmer. */
export function agentRequestStatus(key, id) {
  const member = memberForKey(key);
  if (!member) return { status: 401, body: { error: 'Unknown or missing member agent key.' } };
  const msg = db.messages.find((m) => m.id === id && m.from === member.email);
  if (!msg) return { status: 404, body: { error: 'No such request for this member.' } };
  return { status: 200, body: outcome(msg, db.actions.filter((a) => a.message_id === msg.id)) };
}
