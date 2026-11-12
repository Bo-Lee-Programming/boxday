// Static farm data plus the box-week calendar.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const FARM = JSON.parse(readFileSync(path.join(ROOT, 'data', 'farm.json'), 'utf8'));
export const SITES = FARM.sites;
export const SHARES = FARM.shares;
export const ADDONS = FARM.addons;
export const BOX = FARM.box;

// The demo calendar is anchored to "day zero" (midnight of the day the farm data is
// seeded), so the story works on any date: Eastside pickup is tomorrow (inside the
// 48 h notice window), Thursday-style sites are 3 days out, the co-op is 5 days out.
export function pickupTime(siteId, week, anchor) {
  const s = SITES[siteId];
  const d = new Date(anchor);
  d.setDate(d.getDate() + s.offset_days + (week - FARM.farm.current_week) * 7);
  d.setHours(s.hour, 0, 0, 0);
  return d;
}

export function dayZero(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export const weekday = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long' });
export const shortDate = (d) => new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
export const weeklyPrice = (share) => SHARES[share].weekly_price;
export const weeksLeft = (fromWeek) => FARM.farm.season_weeks - fromWeek + 1;
