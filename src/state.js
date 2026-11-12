// Farm state: members and this week's packing sheet, inbox, money actions.
// Persisted as one JSON file; `seed()` rebuilds the demo week from data/farm.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { FARM, ADDONS, dayZero, weeklyPrice } from './farm.js';
import { paypal } from './paypal.js';
import { heuristicPolicy, normalizePolicy } from './policy.js';

const file = path.join(config.dataDir, 'boxday.json');
export const db = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

export function save() {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
  renameSync(`${file}.tmp`, file);
}

const emptyWeek = () => ({ status: 'packing', addons: Object.fromEntries(Object.keys(ADDONS).map((k) => [k, 0])), swaps: [], notes: '', claim_refunded: 0 });

/**
 * Rebuild the demo: members with season payments already captured in PayPal,
 * this week's sheet, add-on stock and the inbox.
 * In sandbox mode, `sandboxWallet` is a Vault payment token saved by the demo buyer
 * (see scripts/seed-sandbox.mjs); every season payment is a real sandbox capture.
 */
export async function seed({ sandboxWallet = null } = {}) {
  const week = FARM.farm.current_week;
  const members = [];
  for (const m of FARM.members) {
    const amount = weeklyPrice(m.share) * FARM.farm.season_weeks;
    let season = { amount, refunded: 0, order_id: null, capture_id: null };
    const vaultId = paypal.mode === 'mock' ? (await paypal.mockWallet()).payment_token_id : sandboxWallet;
    if (vaultId) {
      const r = await paypal.chargeWallet(
        { merchant: { id: 'season', name: FARM.farm.name }, items: [{ name: `${FARM.farm.name} season share (${m.share}, ${FARM.farm.season_weeks} weeks)`, unit_price: amount, quantity: 1 }] },
        { vaultId, customId: m.id, invoiceId: `season-${m.id}-${Date.now()}` },
      );
      season = { ...season, order_id: r.order_id, capture_id: r.capture_id, fee: r.fee ?? null };
    }
    members.push({
      ...m,
      wallet: m.wallet ? (paypal.mode === 'mock' ? await paypal.mockWallet() : sandboxWallet ? { payment_token_id: sandboxWallet } : null) : null,
      joined_week: 1,
      season,
      week: emptyWeek(),
      changed: [],
    });
  }
  Object.assign(db, {
    seeded_at: new Date().toISOString(),
    anchor: dayZero(),
    week,
    // The farmer wrote these rules when the season started; the Rules tab can teach it more.
    policy: { ...normalizePolicy(heuristicPolicy(FARM.default_policy), FARM.default_policy), confirmed_at: new Date().toISOString(), taught: [] },
    stock: Object.fromEntries(Object.entries(ADDONS).map(([k, a]) => [k, a.stock])),
    members,
    messages: FARM.inbox.map((x, i) => ({ ...x, received_at: new Date(Date.now() - (FARM.inbox.length - i) * 7 * 60e3).toISOString(), status: 'new' })),
    actions: [],
    reconciled: null,
    receivables: [],
    chased_at: null,
    agent_secret: null,
  });
  const { seedOpenItems } = await import('./collections.js');
  await seedOpenItems();
  save();
  return db;
}

export const memberByEmail = (email) => db.members.find((m) => m.email.toLowerCase() === String(email).toLowerCase().trim()) || null;
export const memberById = (id) => db.members.find((m) => m.id === id) || null;
export const actionById = (id) => db.actions.find((a) => a.id === id) || null;
export const messageById = (id) => db.messages.find((m) => m.id === id) || null;
