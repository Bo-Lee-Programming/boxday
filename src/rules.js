// Deterministic farm rules. Given one grounded request, the member, the farmer's
// confirmed policy and the farm state, decide: allow | farmer (needs the farmer) | block,
// and what money should move. No model is consulted here.
import { FARM, SITES, ADDONS, BOX, pickupTime, weeklyPrice, weeksLeft, shortDate } from './farm.js';

const round = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${Number(n).toFixed(2)}`;

export function refundable(member) {
  return member?.season?.capture_id ? round(member.season.amount - member.season.refunded) : 0;
}

/**
 * @returns {{ decision: 'allow'|'farmer'|'block', checks: {rule,outcome,detail}[], money: null|{kind:'refund'|'charge'|'invoice', amount:number, lines?:object[]}, effect: object|null, summary: string }}
 */
export function evaluate(req, { member, sender, policy, state, now = new Date(), injected = 0, mentionsOther = null }) {
  const checks = [];
  const add = (rule, outcome, detail) => checks.push({ rule, outcome, detail });
  let money = null;
  let effect = null;
  let summary = '';

  if (!policy?.confirmed_at) add('policy', 'block', 'The farm policy has not been confirmed yet.');
  else add('policy', 'pass', 'Farm policy confirmed.');

  // Identity: money and box changes only for the member writing from their own email.
  if (req.type === 'join') {
    if (member) add('identity', 'block', `${sender} is already a member.`);
    else add('identity', 'pass', `${sender} is not a member yet.`);
  } else if (req.type !== 'question') {
    if (!member) add('identity', 'block', `${sender} is not a member. Changes and refunds are only made for the member who paid, from their own email.`);
    else add('identity', 'pass', `Writing from ${member.name}'s own email.`);
  }
  if (mentionsOther && req.type !== 'question') add('third_party', 'block', `Asks about ${mentionsOther}'s share. Only ${mentionsOther} can change it, and refunds only go to the PayPal account that paid.`);

  const week = state.week + (req.week === 'next' ? 1 : 0);
  const site = member?.site;
  const cutoffOf = (s, w) => new Date(pickupTime(s, w, state.anchor).getTime() - (policy?.skip_notice_hours ?? 48) * 3600e3);

  switch (req.type) {
    case 'skip_week': {
      if (!member) break;
      const cutoff = cutoffOf(site, week);
      if (member.week.status === 'skipped' && week === state.week) add('already', 'block', 'This week is already skipped.');
      if (now > cutoff) add('notice', 'block', `Too late: skips for ${SITES[site].label} (${shortDate(pickupTime(site, week, state.anchor))}) close ${policy?.skip_notice_hours ?? 48} h before pickup.`);
      else add('notice', 'pass', `Before the cutoff (${shortDate(cutoff)}).`);
      if (member.skips_used >= (policy?.skip_limit ?? 0)) add('skip_limit', 'block', `${member.skips_used} of ${policy?.skip_limit ?? 0} skips already used this season.`);
      else add('skip_limit', 'pass', `Skip ${member.skips_used + 1} of ${policy.skip_limit} this season.`);
      if (policy?.skip_refund) money = { kind: 'refund', amount: weeklyPrice(member.share) };
      effect = { skip: week };
      summary = `Skip week ${week}`;
      break;
    }
    case 'add_on': {
      if (!member) break;
      const a = ADDONS[req.addon];
      const amount = round(a.price * req.quantity);
      if (state.stock[req.addon] < req.quantity) add('stock', 'block', `Only ${state.stock[req.addon]} × ${a.label} left this week.`);
      else add('stock', 'pass', `${state.stock[req.addon]} × ${a.label} in stock.`);
      if (member.week.status === 'skipped' && week === state.week) add('box', 'block', 'Their box is skipped this week.');
      if (amount > (policy?.addon_auto_max ?? 0)) add('charge_limit', 'farmer', `${usd(amount)} is over your ${usd(policy?.addon_auto_max ?? 0)} limit for charging without asking.`);
      else add('charge_limit', 'pass', `${usd(amount)} is within your ${usd(policy.addon_auto_max)} limit.`);
      add('wallet', 'pass', member.wallet ? 'PayPal wallet saved at sign-up: charge it.' : 'No saved wallet: send a PayPal payment link.');
      money = { kind: 'charge', amount, lines: [{ name: `${a.label} (week ${week})`, unit_price: a.price, quantity: req.quantity }] };
      effect = { addon: req.addon, quantity: req.quantity };
      summary = `${req.quantity} × ${a.label}`;
      break;
    }
    case 'swap_item': {
      if (!member) break;
      const inBox = BOX.this_week[member.share];
      const from = req.items.find((i) => inBox.includes(i));
      if (!from) add('in_box', 'block', `None of ${req.items.join(', ')} is in this week's ${member.share} box.`);
      else add('in_box', 'pass', `${from} is in this week's box.`);
      const to = BOX.swap_ins.find((i) => i !== from && !inBox.includes(i)) || BOX.swap_ins[0];
      if (now > cutoffOf(site, state.week)) add('notice', 'block', 'Packing has started for their pickup.');
      else add('notice', 'pass', 'Before packing day.');
      effect = from ? { swap: [from, to] } : null;
      summary = from ? `Swap ${from} for ${to}` : 'Swap';
      break;
    }
    case 'change_site': {
      if (!member) break;
      if (req.site === member.site) add('site', 'block', `Already picking up at ${SITES[req.site].label}.`);
      else add('site', 'pass', `${SITES[member.site].label} → ${SITES[req.site].label}.`);
      const thisWeek = now <= cutoffOf(member.site, state.week) && now <= cutoffOf(req.site, state.week);
      add('timing', 'pass', thisWeek ? 'In time for this week.' : 'Takes effect next week (this week is already being packed).');
      effect = { site: req.site, from_week: thisWeek ? state.week : state.week + 1 };
      summary = `Pickup → ${SITES[req.site].label}`;
      break;
    }
    case 'missing_item': {
      if (!member) break;
      const lastBox = BOX.last_week[member.share];
      const items = (req.items || []).filter((i) => lastBox.includes(i) || BOX.this_week[member.share].includes(i));
      if (!items.length) add('items', 'block', 'No item from their box is named.');
      else add('items', 'pass', `${items.join(' and ')} ${items.length > 1 ? 'were' : 'was'} in their box.`);
      const amount = round(items.reduce((s, i) => s + (BOX.item_values[i] || 0), 0));
      if (member.week.claim_refunded > 0) add('once', 'farmer', 'Already got a refund for missing items this week.');
      if (amount > (policy?.auto_refund_max ?? 0)) add('refund_limit', 'farmer', `${usd(amount)} is over your ${usd(policy?.auto_refund_max ?? 0)} no-questions refund limit.`);
      else if (items.length) add('refund_limit', 'pass', `${usd(amount)} at farm prices, within your ${usd(policy.auto_refund_max)} limit.`);
      if (items.length) money = { kind: 'refund', amount };
      effect = { claim: items };
      summary = `Refund for ${items.join(', ') || 'missing items'}`;
      break;
    }
    case 'join': {
      if (!policy?.late_join) add('late_join', 'block', 'Your policy does not allow joining mid-season.');
      else add('late_join', 'pass', 'Mid-season joins allowed.');
      const share = req.share || 'standard';
      const firstWeek = now <= cutoffOf('farmstand', state.week) ? state.week : state.week + 1;
      const weeks = weeksLeft(firstWeek);
      add('price', 'pass', `${weeks} weeks left (from week ${firstWeek}) × ${usd(weeklyPrice(share))} = ${usd(weeks * weeklyPrice(share))}.`);
      money = { kind: 'invoice', amount: weeks * weeklyPrice(share), lines: [{ name: `${FARM.farm.name} ${share} share, weeks ${firstWeek}-${FARM.farm.season_weeks}`, unit_price: weeklyPrice(share), quantity: weeks }] };
      effect = { join: { share, first_week: firstWeek } };
      summary = `Join: ${share} share, ${weeks} weeks`;
      break;
    }
    case 'cancel_season': {
      const left = member ? refundable(member) : 0;
      if (member) {
        const weeksRemaining = weeksLeft(state.week + 1);
        const amount = Math.min(left, weeksRemaining * weeklyPrice(member.share));
        add('season_refund', 'farmer', `Season refunds always need you. Suggested: ${weeksRemaining} remaining weeks = ${usd(amount)}.`);
        money = { kind: 'refund', amount };
        effect = { cancel: true };
      }
      summary = 'Cancel season';
      break;
    }
    default:
      summary = 'Question';
  }

  // Money guards common to every request.
  if (money?.kind === 'refund') {
    const left = refundable(member);
    if (!member?.season?.capture_id) add('refundable', 'block', 'No season payment on file to refund against.');
    else if (money.amount > left) add('refundable', 'block', `Refund ${usd(money.amount)} exceeds the ${usd(left)} still refundable on their season payment.`);
    else add('refundable', 'pass', `Refund to the PayPal account that paid (${usd(left)} refundable).`);
  }
  if (money && injected) add('instructions_to_ai', 'farmer', 'The message contains instructions aimed at the AI assistant. Money actions from it wait for you.');

  const decision = checks.some((c) => c.outcome === 'block') ? 'block' : checks.some((c) => c.outcome === 'farmer') ? 'farmer' : 'allow';
  return { decision, checks, money: money && money.amount > 0 ? money : null, effect, summary, week };
}
