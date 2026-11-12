// Turn a member's message into structured requests. The local model reads the
// message; ground() then keeps only what the member actually wrote: add-on names,
// quantities, produce items and pickup sites must all appear in the text.
import { chatJSON } from './llm.js';
import { SITES, ADDONS, BOX } from './farm.js';

export const TYPES = ['skip_week', 'add_on', 'swap_item', 'change_site', 'missing_item', 'join', 'cancel_season', 'question'];

const SCHEMA = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES },
          week: { type: 'string', enum: ['this', 'next', 'unspecified'] },
          addon: { type: 'string', enum: [...Object.keys(ADDONS), 'none'] },
          quantity: { type: 'integer' },
          items: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'produce items named in the message' },
          site: { type: 'string', enum: [...Object.keys(SITES), 'none'] },
          share: { type: 'string', enum: ['small', 'standard', 'none'] },
        },
        required: ['type', 'week', 'addon', 'quantity', 'items', 'site', 'share'],
      },
    },
  },
  required: ['requests'],
};

const SYSTEM = `You read messages that members of a small farm's vegetable-box program (CSA) send to the farm.
List each distinct request. Types:
- skip_week: they will not collect a box (away, sick, on vacation, skip, pause)
- add_on: they want extra products this week: ${Object.entries(ADDONS).map(([k, a]) => `${k} (${a.label})`).join(', ')}
- swap_item: they want a produce item in their box replaced
- change_site: they want a different pickup location: ${Object.entries(SITES).map(([k, s]) => `${k} (${s.label})`).join(', ')}
- missing_item: something in a box was missing, spoiled or damaged
- join: someone new wants to sign up
- cancel_season: they want to cancel or get the whole season refunded
- question: anything else
quantity is the number of units of the add-on (1 if not stated). Do not invent requests.`;

const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const has = (t, words) => words.some((w) => t.includes(w));
const ALL_ITEMS = [...new Set([...BOX.this_week.standard, ...BOX.last_week.standard, ...BOX.swap_ins])];
const itemMentions = (t) => ALL_ITEMS.filter((i) => t.includes(i) || t.includes(i.split(' ').pop().replace(/s$/, '')));

function quantityFor(t, keywords) {
  for (const k of keywords) {
    const m = t.match(new RegExp(String.raw`\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:dozen\s+|jars? of\s+|loa(?:f|ves) of\s+|bunch(?:es)? of\s+)?(?:\w+\s+){0,2}${k}`));
    if (m) return WORD_NUM[m[1]] ?? Number(m[1]);
  }
  return 1;
}

const DETECT = {
  skip_week: (t) => /\b(skip|vacation|holiday|pause|sick|traveling|travelling|won't be able to pick|can't pick)\b|\b(we're|we are|i'm|i am|will be|be) away\b/.test(t),
  add_on: (t) => Object.values(ADDONS).some((a) => has(t, a.keywords)) && /\b(add|extra|get|want|like|order|could i have|can i have|buy)\b/.test(t),
  swap_item: (t) => /\b(swap|instead of|replace|substitut|don't like|do not like|no more)\b/.test(t) && itemMentions(t).length > 0,
  change_site: (t) => Object.values(SITES).some((s) => has(t, s.keywords)) && /\b(move|switch|change|transfer)\b/.test(t),
  missing_item: (t) => /\b(missing|forgot|didn't get|did not get|spoiled|rotten|mushy|moldy|damaged|crushed|bad)\b/.test(t),
  join: (t) => /\b(join|sign up|signup|become a member|subscribe)\b/.test(t),
  cancel_season: (t) => /\b(whole|entire|full|rest of the)\s+season\b/.test(t) && /\b(refund|cancel|money back)\b/.test(t),
};

const weekOf = (t) => (/\bnext week\b/.test(t) ? 'next' : 'this');

/** Keep only requests the message supports; fill fields deterministically from the text. */
export function ground(raw, message, { isMember, fill = true }) {
  const t = message.toLowerCase();
  const fixes = [];
  const out = [];
  for (const r of raw) {
    const type = TYPES.includes(r.type) ? r.type : 'question';
    if (type !== 'question' && !DETECT[type](t)) { fixes.push(`AI saw a "${type.replace('_', ' ')}" request the message does not support; dropped it.`); continue; }
    const req = { type, week: weekOf(t) };
    if (type === 'add_on') {
      const addon = Object.entries(ADDONS).find(([k, a]) => (r.addon === k && has(t, a.keywords))) || Object.entries(ADDONS).find(([, a]) => has(t, a.keywords));
      if (!addon) { fixes.push('AI named an add-on the message does not mention; dropped it.'); continue; }
      req.addon = addon[0];
      req.quantity = quantityFor(t, addon[1].keywords);
      if (Number(r.quantity) && Number(r.quantity) !== req.quantity) fixes.push(`AI read ${r.quantity} × ${addon[0]}; the message says ${req.quantity}.`);
      if (out.some((x) => x.type === 'add_on' && x.addon === req.addon)) continue;
    }
    if (type === 'swap_item' || type === 'missing_item') {
      req.items = itemMentions(t);
      if (!req.items.length && type === 'swap_item') { fixes.push('Swap request names no item from the box; dropped it.'); continue; }
    }
    if (type === 'change_site') {
      const site = Object.entries(SITES).find(([, s]) => has(t, s.keywords));
      req.site = site[0];
      if (r.site && r.site !== 'none' && r.site !== req.site) fixes.push(`AI picked site "${r.site}"; the message names ${site[1].label}.`);
    }
    if (type === 'join') {
      if (isMember) { fixes.push('Sender is already a member; ignored "join".'); continue; }
      req.share = /\bsmall\b/.test(t) ? 'small' : /\b(standard|regular|large|full)\b/.test(t) ? 'standard' : null;
    }
    if (out.some((x) => x.type === type && type !== 'add_on')) continue;
    out.push(req);
  }
  if (!fill) return { requests: out, fixes };
  // High-precision detectors catch requests the model missed.
  const missed = ['skip_week', 'change_site', 'cancel_season', 'swap_item']
    .filter((type) => !out.some((x) => x.type === type) && DETECT[type](t))
    .map((type) => ({ type }));
  if (DETECT.add_on(t)) {
    for (const [k, a] of Object.entries(ADDONS)) if (has(t, a.keywords) && !out.some((x) => x.addon === k)) missed.push({ type: 'add_on', addon: k });
  }
  for (const m of missed) {
    const [req] = ground([{ addon: 'none', quantity: 0, site: 'none', ...m }], message, { isMember, fill: false }).requests;
    if (req) { out.push(req); fixes.push(`AI missed a "${(req.addon || req.type).replace('_', ' ')}" request; added it from the message.`); }
  }
  return { requests: out, fixes };
}

export function heuristicRequests(message, { isMember }) {
  const t = message.toLowerCase();
  const raw = Object.keys(DETECT).filter((k) => DETECT[k](t) && (k !== 'join' || !isMember)).map((type) => ({ type, addon: 'none', quantity: 0, site: 'none' }));
  return { requests: raw.length ? raw : [{ type: 'question' }] };
}

export async function parseMessage(message, { isMember }) {
  const res = await chatJSON({
    system: SYSTEM,
    user: `Message:\n"""${message}"""`,
    schema: SCHEMA,
    fallback: () => heuristicRequests(message, { isMember }),
  });
  const { requests, fixes } = ground(res.data.requests || [], message, { isMember });
  return { requests: requests.length ? requests : [{ type: 'question', week: 'this' }], fixes: res.via === 'llm' ? fixes : [], ai: { via: res.via, ms: res.ms, error: res.error } };
}

// Signals that a message is trying to instruct the AI rather than the farm.
const INJECTION = [
  /\b(system|admin|developer)\s+(note|message|prompt|instruction)/i,
  /\b(ignore|disregard|override)\b.{0,40}\b(instruction|rule|policy|previous)/i,
  /\bnote to (the )?(ai|assistant|agent|bot)/i,
  /\bto (the )?ai (assistant|agent)\b/i,
  /do not (notify|tell|inform).{0,20}\b(farmer|owner|ruth)\b/i,
  /policy (was|has been|is) (updated|changed)/i,
];
export const injectionSignals = (text) => INJECTION.filter((re) => re.test(text)).length;
