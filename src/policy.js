// The farmer writes the farm's rules in plain English. The local model drafts a
// structured policy; every number it produces is checked against the farmer's own
// words before the farmer confirms it. Enforcement (rules.js) never asks the model.
import { chatJSON } from './llm.js';

export const POLICY_SCHEMA = {
  type: 'object',
  properties: {
    skip_limit: { type: 'integer', description: 'how many weeks a member may skip per season' },
    skip_notice_hours: { type: 'number', description: 'how many hours before pickup a skip must be requested' },
    skip_refund: { type: 'boolean', description: 'whether a skipped week is refunded to the member' },
    addon_auto_max: { type: 'number', description: 'USD; add-on charges above this need the farmer' },
    auto_refund_max: { type: 'number', description: 'USD; refunds for missing or spoiled items up to this need no farmer' },
    late_join: { type: 'boolean', description: 'whether new members may join mid-season' },
  },
  required: ['skip_limit', 'skip_notice_hours', 'skip_refund', 'addon_auto_max', 'auto_refund_max', 'late_join'],
};

const SYSTEM = `You turn a small farm's plain-English rules for its farm-share (CSA) members into a JSON policy.
Use only what the farmer wrote. Amounts are US dollars. If the farmer did not give a number, use 0 for money limits (meaning: always ask the farmer).`;

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = (s) => (s in WORD_NUM ? WORD_NUM[s] : Number(String(s).replace(/[$,]/g, '')));
const AMT = String.raw`\$\s?([\d,]+(?:\.\d+)?)`;
const NEG = /\b(no|not|never|don't|can't|cannot)\b/;

/** Rule-based reading of the farmer's text; `_explicit` marks values the text actually states. */
export function heuristicPolicy(text) {
  const t = text.toLowerCase();
  const skip = t.match(/skip (?:up to |at most )?(\d+|one|two|three|four|five|six) (?:weeks?|times)/) || t.match(/(\d+|one|two|three|four|five|six) skips\b/);
  const notice = t.match(/(\d+)\s*(?:hours?|hrs?)\b/);
  const addon = t.match(new RegExp(String.raw`(?:ask|check with) me[^.]*?(?:more than|over|above)\s*${AMT}`)) || t.match(new RegExp(String.raw`charg[^.]*?(?:more than|over|above)\s*${AMT}`))
    || t.match(new RegExp(String.raw`(?:charg|add-?ons?)[^.]*?(?:up to|under|below)\s*${AMT}`));
  const refund = t.match(new RegExp(String.raw`refund up to\s*${AMT}`)) || t.match(new RegExp(String.raw`(?:missing|spoiled|damaged)[^.]*?up to\s*${AMT}`));
  const joinClause = t.split(/[.;]/).find((c) => /join/.test(c)) || '';
  return {
    skip_limit: skip ? num(skip[1]) : 0,
    skip_notice_hours: notice ? Number(notice[1]) : 48,
    skip_refund: /refund[^.]*skip|skip[^.]*refund/.test(t),
    addon_auto_max: addon ? num(addon[1]) : 0,
    auto_refund_max: refund ? num(refund[1]) : 0,
    late_join: Boolean(joinClause) && !NEG.test(joinClause),
    _explicit: { skip_limit: Boolean(skip), skip_notice_hours: Boolean(notice), addon_auto_max: Boolean(addon), auto_refund_max: Boolean(refund) },
  };
}

/** Numbers the farmer actually wrote win; numbers the model invented fall back to the safe default. */
export function crossCheck(draft, text) {
  const h = heuristicPolicy(text);
  const out = { ...draft };
  const fixes = [];
  const fixKeys = [];
  const fix = (k, text) => { fixes.push(text); fixKeys.push(k); };
  const stated = new Set([...(text.match(/\$\s?[\d,]+(?:\.\d+)?|\b\d+\b/g) || []).map(num), ...Object.entries(WORD_NUM).filter(([w]) => new RegExp(`\\b${w}\\b`, 'i').test(text)).map(([, n]) => n)]);
  const label = { skip_limit: 'skip limit', skip_notice_hours: 'notice period (hours)', addon_auto_max: 'add-on limit before asking you ($)', auto_refund_max: 'refund you allow without asking ($)' };
  for (const k of Object.keys(label)) {
    const v = Number(draft[k]);
    if (h._explicit[k] && v !== h[k]) { fix(k, `AI read the ${label[k]} as ${v}; corrected to ${h[k]} from your words.`); out[k] = h[k]; }
    else if (!h._explicit[k] && !stated.has(v)) { if (v !== h[k]) fix(k, `You did not state a ${label[k]}; using the safe default ${h[k]} instead of the AI's ${v}.`); out[k] = h[k]; }
  }
  for (const k of ['skip_refund', 'late_join']) {
    if (Boolean(draft[k]) !== h[k]) { fix(k, `AI set ${k.replace('_', ' ')} to ${Boolean(draft[k])}; your text says ${h[k]}.`); out[k] = h[k]; }
  }
  return { draft: out, fixes, fixKeys };
}

export function normalizePolicy(p, sourceText) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : d);
  return {
    source_text: sourceText,
    skip_limit: Math.min(20, Math.round(n(p.skip_limit, 0))),
    skip_notice_hours: n(p.skip_notice_hours, 48),
    skip_refund: Boolean(p.skip_refund),
    addon_auto_max: n(p.addon_auto_max, 0),
    auto_refund_max: n(p.auto_refund_max, 0),
    late_join: Boolean(p.late_join),
    season_refund_requires_farmer: true, // not configurable: whole-season refunds always need the farmer
    // Chasing unpaid PayPal links and invoices: remind, remind more firmly, then hand over.
    remind_after_days: n(p.remind_after_days, 3),
    firm_after_days: n(p.firm_after_days, 7),
    handoff_after_days: n(p.handoff_after_days, 14),
    confirmed_at: null,
  };
}

export const POLICY_LABELS = {
  skip_limit: 'Skips per season',
  skip_notice_hours: 'Skip notice (hours)',
  skip_refund: 'Refund skipped weeks',
  addon_auto_max: 'Charge add-ons without asking, up to ($)',
  auto_refund_max: 'Refund missing/spoiled without asking, up to ($)',
  late_join: 'Allow mid-season joins',
};
// Which setting a sentence is about, by its words. A setting only changes if the sentence is about it.
const TOPIC = {
  skip_limit: /\bskip|\bpause/,
  skip_notice_hours: /notice|hours?\b|\bhrs?\b/,
  skip_refund: /(?=.*\bskip)(?=.*refund)/,
  addon_auto_max: /add-?on|charg|extra/,
  auto_refund_max: /refund|missing|spoil|damag|rotten/,
  late_join: /\bjoin/,
};

/**
 * "Teach it one sentence": the model reads the sentence, the cross-check pins every number to
 * the farmer's words, and only settings the sentence is about change. Returns the changes.
 */
export async function teachRule(sentence, current) {
  const res = await chatJSON({ system: SYSTEM, user: `One new farm rule:\n"""${sentence}"""`, schema: POLICY_SCHEMA, fallback: () => heuristicPolicy(sentence) });
  const t = sentence.toLowerCase();
  const h = heuristicPolicy(sentence);
  const { draft, fixes, fixKeys } = res.via === 'llm' ? crossCheck(res.data, sentence) : { draft: res.data, fixes: [], fixKeys: [] };
  const stated = new Set((sentence.match(/\$\s?[\d,]+(?:\.\d+)?|\b\d+\b/g) || []).map(num));
  const changes = [];
  for (const k of Object.keys(POLICY_LABELS)) {
    if (!TOPIC[k].test(t)) continue;
    let to;
    if (typeof current[k] === 'boolean') to = h[k];
    else if (h._explicit[k]) to = h[k];
    else if (stated.has(Number(draft[k])) && Number(draft[k]) > 0) to = Number(draft[k]);
    else continue;
    if (to !== current[k]) changes.push({ key: k, label: POLICY_LABELS[k], from: current[k], to });
  }
  // Only corrections about the settings this sentence changes are worth showing.
  const relevant = fixes.filter((_, i) => changes.some((c) => c.key === fixKeys[i]));
  return { changes, fixes: relevant, ai: { via: res.via, ms: res.ms, error: res.error } };
}

export async function compilePolicy(text) {
  const res = await chatJSON({ system: SYSTEM, user: `Farm rules:\n"""${text}"""`, schema: POLICY_SCHEMA, fallback: () => heuristicPolicy(text) });
  const { draft, fixes } = res.via === 'llm' ? crossCheck(res.data, text) : { draft: res.data, fixes: [] };
  return { policy: normalizePolicy(draft, text), fixes, ai: { via: res.via, ms: res.ms, error: res.error, raw: res.data } };
}
