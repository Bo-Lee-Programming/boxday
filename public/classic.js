/* global agGrid */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d) => new Date(d).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const TYPE_LABEL = { skip_week: 'Skip a week', add_on: 'Add-on', swap_item: 'Swap', change_site: 'Change pickup', missing_item: 'Missing / spoiled', join: 'Join mid-season', cancel_season: 'Season refund', question: 'Question' };
const DECISION_LABEL = { allow: 'Within your rules', farmer: 'Needs you', block: 'Refused' };
const STATUS_LABEL = { done: 'Done', awaiting_farmer: 'Waiting for you', awaiting_member: 'Pay link sent', invoice_sent: 'Invoice sent', blocked: 'Refused', declined: 'Declined', failed: 'Failed', pending: 'Pending', new: 'New', answered: 'Answered', needs_farmer: 'Needs you' };

let S = null;
let selected = null;
let sheet = null;
let money = null;
let ledger = null;
let ledgerSeen = null;
let llmDown = false;
let lastFlash = 0;
const working = new Set();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}
function toast(msg, ms = 3500) {
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
const memberOf = (id) => S.members.find((m) => m.id === id);

// ------------------------------------------------------------------ policy
function showPolicyDraft(p, fixes) {
  $('policy-draft').classList.remove('hidden');
  $('policy-live').classList.add('hidden');
  $('policy-draft').dataset.source = p.source_text;
  $('p-skip').value = p.skip_limit;
  $('p-notice').value = p.skip_notice_hours;
  $('p-addon').value = p.addon_auto_max;
  $('p-refund').value = p.auto_refund_max;
  $('p-skiprefund').checked = p.skip_refund;
  $('p-join').checked = p.late_join;
  $('policy-fixes').innerHTML = (fixes || []).map((f) => `<li>${esc(f)}</li>`).join('');
}

function renderPolicy() {
  if (!$('policy-text').value) $('policy-text').value = S.policy?.source_text || S.default_policy;
  const p = S.policy;
  if (!p?.confirmed_at) return;
  $('policy-draft').classList.add('hidden');
  const live = $('policy-live');
  live.classList.remove('hidden');
  live.innerHTML = `<div class="signed-head"><b>Rules in force</b><button id="btn-edit-policy" class="btn small ghost">Edit</button></div>
    <ul class="rules">
      <li>Skip up to <b>${p.skip_limit}</b> weeks, <b>${p.skip_notice_hours} h</b> notice${p.skip_refund ? ', skipped week <b>refunded</b> to PayPal' : ''}</li>
      <li>Add-ons charged to saved PayPal up to <b>${usd(p.addon_auto_max)}</b>; above that, you decide</li>
      <li>Missing/spoiled refunds up to <b>${usd(p.auto_refund_max)}</b> without asking</li>
      <li>Mid-season joins: <b>${p.late_join ? 'yes, PayPal invoice for the weeks left' : 'no'}</b></li>
      <li>Whole-season refunds: <b>always you</b></li>
    </ul>`;
  $('btn-edit-policy').addEventListener('click', () => showPolicyDraft(p, []));
}

$('btn-compile').addEventListener('click', async () => {
  const btn = $('btn-compile');
  busy(btn, true, 'Reading…');
  try {
    const r = await api('/api/policy/compile', { text: $('policy-text').value });
    showPolicyDraft(r.policy, r.fixes);
    $('compile-status').textContent = r.ai.via === 'llm' ? `Read by ${S.mode.llm.model} in ${(r.ai.ms / 1000).toFixed(1)} s, then checked against your words.` : 'AI unavailable: read by the rule-based parser.';
  } catch (e) { toast(e.message); }
  busy(btn, false);
});

$('btn-confirm').addEventListener('click', async () => {
  await api('/api/policy/confirm', { policy: {
    source_text: $('policy-draft').dataset.source || $('policy-text').value,
    skip_limit: Number($('p-skip').value), skip_notice_hours: Number($('p-notice').value),
    addon_auto_max: Number($('p-addon').value), auto_refund_max: Number($('p-refund').value),
    skip_refund: $('p-skiprefund').checked, late_join: $('p-join').checked,
  } });
  toast('Rules confirmed. The agent works within them from now on.');
  await refresh();
});

// ------------------------------------------------------------------ inbox
function nameFor(msg) {
  const m = S.members.find((x) => x.email.toLowerCase() === msg.from.toLowerCase());
  return m ? m.name : msg.from;
}

function renderInbox() {
  const list = $('msg-list');
  list.innerHTML = S.messages.slice().reverse().map((m) => `<li class="msg-item ${m.id === selected ? 'sel' : ''} ${working.has(m.id) ? 'working' : ''}" data-id="${m.id}">
      <div class="who"><span>${esc(nameFor(m))}</span>${pill(working.has(m.id) ? 'pending' : m.status, working.has(m.id) ? 'Working…' : STATUS_LABEL[m.status])}</div>
      <div class="snip">${esc(m.text)}</div></li>`).join('');
  list.querySelectorAll('.msg-item').forEach((li) => li.addEventListener('click', () => { selected = li.dataset.id; renderInbox(); renderDetail(); }));
  const n = S.messages.filter((m) => m.status === 'new').length;
  $('btn-process-all').textContent = n ? `Handle ${n} new message${n === 1 ? '' : 's'}` : 'Inbox handled';
  $('btn-process-all').disabled = !n || working.size > 0;
}

const checksHtml = (checks) => `<ul class="checks">${checks.map((c) => `<li class="${c.outcome === 'farmer' ? 'escalate' : c.outcome}">${esc(c.detail)}</li>`).join('')}</ul>`;

function paypalLine(a) {
  const p = a.paypal || {};
  if (!p.tool) return a.money ? `<div class="tl-sub">No PayPal call made.</div>` : '';
  const ids = [p.order_id && `order ${p.order_id}`, p.capture_id && a.money?.kind !== 'refund' && `capture ${p.capture_id}`, p.refund_id && `refund ${p.refund_id}`, p.invoice_id && `invoice ${p.invoice_id}`].filter(Boolean).join(' · ');
  return `<div class="tl-sub">PayPal (${esc(p.mode)}): <span class="tool">${esc(p.tool)}</span> ${esc(ids)}${p.pay_url && a.status !== 'done' ? ` · <a href="${esc(p.pay_url)}" target="_blank" rel="noopener">${a.type === 'join' ? 'invoice' : 'pay link'}</a>` : ''}</div>`;
}

function actionHtml(a) {
  const buttons = a.status === 'awaiting_farmer' ? `<div class="row tight" style="margin-top:6px"><button class="btn small primary" data-approve="${a.id}">Approve${a.money ? ` ${a.money.kind} ${usd(a.money.amount)}` : ''}</button><button class="btn small" data-decline="${a.id}">Decline</button></div>` : '';
  return `<div class="act ${a.decision}"><div class="tl-head"><span>${esc(TYPE_LABEL[a.type])}: ${esc(a.summary)}${a.money ? ` · ${a.money.kind} ${usd(a.money.amount)}` : ''}</span>${pill(a.status, STATUS_LABEL[a.status])}</div>
    ${checksHtml(a.checks)}${paypalLine(a)}${a.error ? `<div class="tl-sub">Error: ${esc(a.error)}</div>` : ''}${buttons}</div>`;
}

function renderDetail() {
  const box = $('msg-detail');
  const msg = S.messages.find((m) => m.id === selected);
  if (!msg) { box.innerHTML = '<p class="muted">Select a message.</p>'; return; }
  const m = S.members.find((x) => x.email.toLowerCase() === msg.from.toLowerCase());
  const actions = S.actions.filter((a) => a.message_id === msg.id);
  const p = msg.parsed;
  box.innerHTML = `<div class="tl-head"><b>${esc(nameFor(msg))}</b> <span class="muted">${esc(msg.from)} · ${when(msg.received_at)}</span></div>
    <div>${m ? `<span class="flag info">${esc(S.shares[m.share].label)} · ${esc(S.sites[m.site].label)}</span>` : '<span class="flag">not a member</span>'}${msg.flags?.injected ? '<span class="flag">instructions aimed at the AI</span>' : ''}${msg.flags?.mentions_other ? `<span class="flag">asks about ${esc(msg.flags.mentions_other)}</span>` : ''}</div>
    <div class="quote">${esc(msg.text)}</div>
    ${msg.status === 'new' ? `<button class="btn primary" id="btn-process-one">${working.has(msg.id) ? 'Working…' : 'Handle this message'}</button>` : ''}
    ${p ? `<h4>Understood <span class="ai">${p.ai.via === 'llm' ? `AI · ${(p.ai.ms / 1000).toFixed(1)} s` : 'rule-based'}</span></h4>
      <div>${p.requests.map((r) => pill('new', `${TYPE_LABEL[r.type]}${r.addon ? `: ${r.quantity} × ${r.addon}` : ''}${r.items?.length ? `: ${r.items.join(', ')}` : ''}${r.site ? ` → ${S.sites[r.site].label}` : ''}${r.week === 'next' ? ' (next week)' : ''}`)).join(' ')}</div>
      ${(p.fixes || []).map((f) => `<div class="tl-sub">Checked: ${esc(f)}</div>`).join('')}` : ''}
    ${actions.length ? `<h4>Decisions</h4>${actions.map(actionHtml).join('')}` : ''}
    ${msg.reply ? `<h4>Reply draft${msg.redrafted_at ? ' <span class="ai">updated</span>' : ''}</h4><div class="reply">${esc(msg.reply)}</div>` : ''}`;
  $('btn-process-one')?.addEventListener('click', () => processMessages({ id: msg.id }));
  box.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decideAction(b.dataset.approve, true)));
  box.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => decideAction(b.dataset.decline, false)));
}

async function processMessages(body) {
  if (!S.policy?.confirmed_at) { toast('Confirm your farm rules first (step 1).'); return; }
  const targets = body.all ? S.messages.filter((m) => m.status === 'new').map((m) => m.id) : [body.id];
  targets.forEach((id) => working.add(id));
  renderInbox(); renderDetail();
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
        if (s.kind === 'received') { selected = s.message_id; renderInbox(); renderDetail(); }
        if (s.kind === 'replied' || s.kind === 'error') {
          working.delete(s.message_id);
          await refresh();
          if (s.kind === 'error') toast(s.message);
        }
      }
    }
  } catch (e) { toast(e.message); }
  working.clear();
  await refresh();
}

$('btn-process-all').addEventListener('click', () => processMessages({ all: true }));
$('btn-compose').addEventListener('click', () => $('compose').classList.toggle('hidden'));
$('compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const msg = await api('/api/messages/new', { from: $('c-from').value, text: $('c-text').value });
    $('c-text').value = '';
    selected = msg.id;
    await refresh();
  } catch (err) { toast(err.message); }
});

async function decideAction(id, approve) {
  try {
    const a = await api('/api/actions/decide', { id, approve });
    toast(approve ? (a.status === 'done' || a.status === 'invoice_sent' ? `Approved: ${a.summary}${a.money ? ` (${a.money.kind} ${usd(a.money.amount)} via PayPal)` : ''}.` : `Not completed: ${(a.reasons || [a.error]).join(' ')}`) : 'Declined.');
  } catch (e) { toast(e.message); }
  await refresh();
}

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
    onRowClicked: (p) => { selected = p.data.message_id; renderInbox(); renderDetail(); $('card-inbox').scrollIntoView({ behavior: 'smooth' }); },
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
    onRowClicked: (p) => { if (p.data?.message_id) { selected = p.data.message_id; renderInbox(); renderDetail(); $('card-inbox').scrollIntoView({ behavior: 'smooth' }); } },
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

// ------------------------------------------------------------------ boot
async function refresh() {
  S = await api('/api/state');
  $('farm-name').textContent = `· ${S.farm.name}`;
  $('week-line').textContent = `Week ${S.farm.current_week} of ${S.farm.season_weeks} · ${S.members.filter((m) => !m.cancelled).length} members · the member desk for small farm-share (CSA) farms`;
  $('badge-paypal').textContent = S.mode.paypal === 'sandbox' ? 'PayPal: sandbox (live API)' : 'PayPal: offline mock';
  $('badge-paypal').classList.toggle('live', S.mode.paypal === 'sandbox');
  $('badge-llm').textContent = S.mode.llm.provider === 'heuristic' ? 'AI: rule-based (no model)' : `AI: ${S.mode.llm.model} (${S.mode.llm.provider === 'ollama' ? 'local Ollama' : 'OpenAI-compatible'})`;
  $('badge-llm').classList.toggle('live', S.mode.llm.provider !== 'heuristic' && !llmDown);
  if (llmDown && S.mode.llm.provider !== 'heuristic') $('badge-llm').textContent = `AI: ${S.mode.llm.model} unreachable, rule-based fallback`;
  $('btn-wallet').classList.toggle('hidden', !(S.mode.paypal === 'sandbox' && !S.mode.season_payments));
  if (!selected && S.messages.length) selected = S.messages[0].id;
  renderPolicy();
  renderInbox();
  renderDetail();
  renderSheet();
  renderMoney();
  renderLedger();
}

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('Restore the demo week (members, inbox, PayPal season payments)?')) return;
  const btn = $('btn-reset');
  busy(btn, true, 'Resetting…');
  await api('/api/reset', {});
  selected = null; lastFlash = 0; ledgerSeen = null;
  $('policy-text').value = '';
  busy(btn, false);
  await refresh();
});
$('btn-wallet').addEventListener('click', async () => {
  try { const r = await api('/api/sandbox/wallet', {}); location.href = r.approve_url; } catch (e) { toast(e.message); }
});

(async function boot() {
  initSheet();
  initMoney();
  initLedger();
  try { const h = await api('/api/health'); llmDown = h.llm.provider !== 'heuristic' && !h.llm.ok; } catch { /* keep default */ }
  await refresh();
  const q = new URLSearchParams(location.search);
  if (q.get('paid')) { const a = S.actions.find((x) => x.id === q.get('paid')); if (a) { selected = a.message_id; renderInbox(); renderDetail(); toast(a.status === 'done' ? `${a.member_name} paid ${usd(a.money.amount)} through PayPal.` : 'Payment not completed.'); } }
  if (q.get('wallet') === 'linked') toast('Sandbox buyer wallet saved; season payments created in the PayPal sandbox.');
  if (q.get('wallet') === 'error') toast(`Wallet setup failed: ${q.get('reason') || ''}`, 8000);
  if ([...q.keys()].length) history.replaceState(null, '', '/');
})();
