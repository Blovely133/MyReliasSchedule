/* MyReliasSchedule — Scheduler console.
   Shares the employee prototype's localStorage overlay, so staff submissions
   (trades, preference requests, messages) land here live, and scheduler
   actions ring staff notification bells. Builder/Coverage edits stage in
   overlay.adminDraft and only reach staff views on Publish. */

const LS_KEY = 'shiftboard-overlay-v1';
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const EMPTY_OVERLAY = () => ({
  edits: {}, added: [], removed: [],
  requests: [], contacts: {}, messages: [], trades: [], prefs: {}, notifs: [], reqSubmissions: [],
  adminDraft: { edits: {}, added: [], removed: [] },
  audit: [],
  tiers: {},       // who -> 'ft' | 'pt' | 'prn' employment tier (shift-preference hierarchy)
  genAdjust: [],   // structured ops from the "talk to the schedule" box
  genChat: [],     // its conversation log
  analyze: null,   // mined-rule set from the Analyze pass (window, rules per provider, modes)
});

let base = [];          // [{id,date,pos,start,end,who,site,note}]
let overlay = EMPTY_OVERLAY();
let state = {
  view: 'approvals',
  month: null,          // 'YYYY-MM' — every periodized view runs on months

  site: '',
  pos: '',
  search: '',
  focusDay: null,       // set by a coverage-cell click; highlighted in the Builder grid
  selDay: null,         // phone month grid: tapped day showing its detail card
  expandedDays: new Set(),
  repSort: { key: 'n', dir: -1 },
  gen: { site: 'TUP', month: '2026-09', result: null, running: false, applied: false, showEmails: false, expanded: new Set(), roleFilter: null, claudeTargets: null, claudeKey: null, claudePlan: null, backtest: null, analyzeOpen: false, analyzeWho: null },
};

/* Site codes → full facility names, from WhenToWork's category list */
const SITE_NAMES = {
  'Psych': 'Arise Psychiatry', 'OCH': 'Baptist - Oktibbeha', 'BSF': 'Big South Fork',
  'BMC': 'Bolivar Medical Center', 'CaldHM': 'Caldwell HM', 'CMC': 'Caldwell Medical Center',
  'REG': 'DCH Regional', 'FAY': 'DCH-Fayette', 'NOR': 'DCH-Northport', 'EDU': 'Education',
  '(FG)': 'Forrest General', 'FGOBS': 'Forrest General ED OBS', 'GRMC': 'Great River Medical Center',
  'HKH': 'Helen Keller', 'HCH': 'Highland Community Hospital', 'JDCH': 'Jefferson Davis Community Hospital',
  'MGH': 'Marion General Hospital', 'AMY': 'NMMC-Amory', 'Amy Ho': 'NMMC-Amory Hosp',
  'EUP': 'NMMC-Eupora', 'HAM': 'NMMC-Hamilton', 'Ham HM': 'NMMC-Hamilton HM',
  'Pon HM': 'NMMC-Pont HM', 'PON': 'NMMC-Pontotoc', 'TUP': 'NMMC-Tupelo',
  'TUPED': 'NMMC-Tupelo ED Admit Delays', 'WP': 'NMMC-West Point', 'NRMC': 'Natchitoches',
  'NRMCHM': 'Natchitoches HM', 'NGH HM': 'Neshoba HM', 'OUCHAM': 'Ouch - Hamilton',
  'OUCTUP': 'Ouch - Tupelo', 'PRCH': 'Pearl River County Hospital', 'PCGH': 'Perry County General Hospital',
  'SMC': 'South Mississippi County', 'McC': 'Southwest McComb', 'St D': "St Dominic's",
  'SDHM': "St. Dominic's HM", 'TeleH': 'TeleHealth', 'WGH': 'Walthall General Hospital',
};
const siteName = code => SITE_NAMES[code] || code;

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* phone layout: Builder + Generate month grids render compact w/ tap-a-day detail */
const phoneMq = window.matchMedia('(max-width: 640px)');
const isPhone = () => phoneMq.matches;
phoneMq.addEventListener('change', () => { if (!document.body.classList.contains('access-locked')) render(); });

/* ---------- notifications + audit ---------- */
/* to === '' means the scheduler (this console's) inbox */
let notifSeq = 0;
function pushNotif(to, text, view, sub) {
  overlay.notifs.push({ id: 'n' + Date.now() + '-' + (notifSeq++), to, text, view, sub: sub || null, created: TODAY, read: false });
  if (overlay.notifs.length > 200) overlay.notifs = overlay.notifs.slice(-200);
}
function managerNotifs() {
  return overlay.notifs.filter(n => n.to === '').slice().reverse();
}

let auditSeq = 0;
function audit(text, kind) {
  overlay.audit.push({ id: 'g' + Date.now() + '-' + (auditSeq++), text, kind: kind || 'edit', actor: 'Scheduler', created: TODAY });
  if (overlay.audit.length > 500) overlay.audit = overlay.audit.slice(-500);
}

/* ---------- data ---------- */

const decodeBase64 = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));

async function decryptSchedule(pin) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable. Open this site over HTTPS or localhost.');
  const res = await fetch('data/schedule-data.admin.enc.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the protected schedule (${res.status}).`);
  const payload = await res.json();
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: decodeBase64(payload.salt), iterations: payload.iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(payload.iv) }, key, decodeBase64(payload.ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}

function readOverlayFromStorage() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
  overlay = { ...EMPTY_OVERLAY(), ...stored };
  if (!overlay.adminDraft || typeof overlay.adminDraft !== 'object') overlay.adminDraft = { edits: {}, added: [], removed: [] };
  for (const k of ['edits']) if (!overlay.adminDraft[k]) overlay.adminDraft[k] = {};
  for (const k of ['added', 'removed']) if (!overlay.adminDraft[k]) overlay.adminDraft[k] = [];
  if (!overlay.audit) overlay.audit = [];
  if (!overlay.genAdjust) overlay.genAdjust = [];
  if (!overlay.genChat) overlay.genChat = [];
  if (!overlay.tiers) overlay.tiers = {};
}

async function loadData(pin) {
  const raw = await decryptSchedule(pin);
  base = raw.shifts.map((s, i) => ({
    id: s[7] || 'x' + i,
    date: s[0], pos: s[1], start: s[2], end: s[3],
    who: s[4] || '', site: s[5] || '', note: s[6] || '',
  }));
  /* W2W leaves open (unassigned) shifts without a site code — infer it from
     the position, using the site that position's assigned shifts belong to */
  const posSite = {};
  for (const s of base) {
    if (!s.site) continue;
    (posSite[s.pos] = posSite[s.pos] || {})[s.site] = (posSite[s.pos][s.site] || 0) + 1;
  }
  for (const s of base) {
    if (s.site || !posSite[s.pos]) continue;
    s.site = Object.entries(posSite[s.pos]).sort((a, b) => b[1] - a[1])[0][0];
  }
  /* Tupelo's zone positions are almost entirely unassigned in W2W, so the
     assignment-based inference misses them — tag them by position name */
  for (const s of base) if (!s.site && /tupelo|\btup\b/i.test(s.pos)) s.site = 'TUP';

  /* forecast scaffold: Sep–Dec mirror August's per-site slot pattern as
     UNFILLED slots (admin console only — staff see future months once the
     scheduler publishes assignments) */
  const FORECAST_MONTHS = ['2026-09', '2026-10', '2026-11', '2026-12'];
  const template = base.filter(s => s.site && s.date.startsWith('2026-08'));
  const aSrc = sundayOf('2026-08-01');
  let fseq = 0;
  for (const mo of FORECAST_MONTHS) {
    const aDst = sundayOf(mo + '-01');
    for (const t of template) {
      const date = addDays(aDst, Math.round((Date.parse(t.date) - Date.parse(aSrc)) / 86400000));
      if (!date.startsWith(mo)) continue;
      base.push({ id: 'f' + (fseq++), date, pos: t.pos, start: t.start, end: t.end, who: '', site: t.site, note: '', forecast: true });
    }
  }
  $('#dataNote').textContent = `Imported from WhenToWork · ${fmtDate(raw.range[0])} – ${fmtDate(raw.range[1])} · unfilled forecast to Dec`;
  readOverlayFromStorage();
}

function waitForPinAttempt() {
  return new Promise(resolve => {
    $('#accessForm').onsubmit = event => {
      event.preventDefault();
      resolve($('#accessPin').value);
    };
  });
}

async function unlockData() {
  const input = $('#accessPin');
  const submit = $('#accessSubmit');
  const error = $('#accessError');
  while (true) {
    const pin = await waitForPinAttempt();
    submit.disabled = true;
    submit.textContent = 'Unlocking…';
    error.textContent = '';
    try {
      await loadData(pin);
      /* fresh chat each login — the conversation log shouldn't persist between
         sessions (adjustment chips DO persist; they're real schedule changes) */
      if (overlay.genChat.length) { overlay.genChat = []; saveOverlay(); }
      $('#accessGate').remove();
      document.body.classList.remove('access-locked');
      return;
    } catch (err) {
      error.textContent = err.message.startsWith('Could not load') || err.message.startsWith('Web Crypto')
        ? err.message
        : 'That PIN did not unlock the console. Try again.';
      input.value = '';
      submit.disabled = false;
      submit.textContent = 'Open console';
      input.focus();
    }
  }
}

function saveOverlay() {
  localStorage.setItem(LS_KEY, JSON.stringify(overlay));
}

/* ---------- shift layering: base → published overlay → admin draft ---------- */

function publishedShifts() {
  const removed = new Set(overlay.removed);
  const out = [];
  for (const s of base) {
    if (removed.has(s.id)) continue;
    out.push(overlay.edits[s.id] ? { ...s, ...overlay.edits[s.id], edited: true } : s);
  }
  for (const a of overlay.added) if (!removed.has(a.id)) out.push({ ...a, edited: true });
  return out;
}

function adminShifts() {
  const d = overlay.adminDraft;
  const dRemoved = new Set(d.removed);
  const out = [];
  for (const s of publishedShifts()) {
    if (dRemoved.has(s.id)) continue;
    out.push(d.edits[s.id] ? { ...s, ...d.edits[s.id], draft: true } : s);
  }
  for (const a of d.added) if (!dRemoved.has(a.id)) out.push({ ...a, draft: true });
  return out;
}

function draftCount() {
  const d = overlay.adminDraft;
  return Object.keys(d.edits).length + d.added.length + d.removed.length;
}

let addSeq = 0;
const nextAddId = () => 'a' + Date.now() + '-' + (addSeq++);   // 'a' prefix so the employee app treats published adds correctly

/* stage a change on a shift (draft layer) */
function draftEdit(s, fields) {
  const d = overlay.adminDraft;
  const added = d.added.find(x => x.id === s.id);
  if (added) Object.assign(added, fields);
  else d.edits[s.id] = { ...(d.edits[s.id] || {}), ...fields };
  saveOverlay();
}

function draftAdd(fields) {
  overlay.adminDraft.added.push({ id: nextAddId(), ...fields });
  saveOverlay();
}

function draftRemove(s) {
  const d = overlay.adminDraft;
  const i = d.added.findIndex(x => x.id === s.id);
  if (i >= 0) d.added.splice(i, 1);
  else if (!d.removed.includes(s.id)) d.removed.push(s.id);
  delete d.edits[s.id];
  saveOverlay();
}

/* apply immediately to the published overlay (approvals do this) */
function applyEditPublished(s, fields) {
  const a = overlay.added.find(x => x.id === s.id);
  if (a) Object.assign(a, fields);
  else overlay.edits[s.id] = { ...(overlay.edits[s.id] || {}), ...fields };
  saveOverlay();
}

function shiftById(id) {
  return adminShifts().find(s => s.id === id) || null;
}

function filtered(list) {
  return list.filter(s =>
    (!state.site || s.site === state.site) &&
    (!state.pos || s.pos === state.pos));
}

/* ---------- date/time helpers ---------- */

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDateLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDayCol(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function sundayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return addDays(iso, -new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}
function hours(s) {
  const [sh, sm] = s.start.split(':').map(Number);
  const [eh, em] = s.end.split(':').map(Number);
  let h = (eh + em / 60) - (sh + sm / 60);
  if (h <= 0) h += 24;
  return h;
}
function isOvernight(s) { return s.end <= s.start; }
/* a night shift STARTS at night (18:00+, or a pre-dawn start). Merely running
   past midnight doesn't qualify — 17:00–03:00 is a swing/evening shift, and
   must never be handed to a nights-only doc. */
function isNight(s) { return s.start >= '18:00' || s.start < '04:00'; }
/* absolute minutes for rest math (overnight shifts end on the next calendar day) */
function absMin(iso, hhmm) {
  const [y, m, d] = iso.split('-').map(Number);
  const [h, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mm) / 60000;
}
function shiftEndMin(s) { return absMin(isOvernight(s) ? addDays(s.date, 1) : s.date, s.end); }
const MIN_REST_MIN = 10 * 60;   // ≥10h between a shift's end and the next start — blocks mid→early-day and night→day
function isWeekendDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}
function fmtMonth(mo) {
  const [y, m] = mo.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/* ---------- site colors + roles ---------- */

const siteHue = {};
function siteColor(site) {
  if (!site) return '#8899aa';
  if (!(site in siteHue)) {
    let h = 0;
    for (const c of site) h = (h * 31 + c.charCodeAt(0)) % 360;
    siteHue[site] = h;
  }
  return `hsl(${siteHue[site]} 62% 46%)`;
}
function providerRole(s) {
  const position = s.pos || '';
  const person = s.who || '';
  if (/\b(APC|nurse practitioner|physician assistant|PA-C|CRNP)\b/i.test(position) || /(?:,|\s)\s*(NP|PA|PA-C|CRNP)\b/i.test(person)) return 'APC';
  if (/\b(physician|doctor|doc|hospitalist|nocturnist|rounder)\b/i.test(position) || /(?:,|\s)\s*(MD|DO)\b/i.test(person)) return 'PHY';
  return '';
}
function matchesSearch(s, q) {
  return s.who.toLowerCase().includes(q) || s.pos.toLowerCase().includes(q) ||
    s.site.toLowerCase().includes(q) || siteName(s.site).toLowerCase().includes(q);
}

function describeShift(s) {
  return `${fmtDate(s.date)} ${s.start}–${s.end} ${s.pos}${s.site ? ` @ ${s.site}` : ''}`;
}

/* ---------- conflict + suggestion engines ---------- */

/* what would go wrong if `name` worked `shift` */
function conflictsFor(name, shift) {
  if (!name) return [];
  const out = [];
  const all = publishedShifts();
  for (const s of all) {
    if (s.who !== name || s.id === shift.id) continue;
    if (s.date === shift.date) out.push(`Also works ${s.start}–${s.end} ${s.pos} @ ${s.site || '—'} that day`);
    if (s.date === addDays(shift.date, -1) && isOvernight(s) && shift.start < '12:00') out.push(`Coming off an overnight ending ${s.end} that morning`);
  }
  if ((overlay.prefs[name] || {})[shift.date] === 'no') out.push('Marked UNAVAILABLE that day');
  return out;
}

/* candidates to fill a shift: work this site, free that day, fewest shifts
   that month first, "prefer to work" marks float to the top */
function suggestFor(shift, topN = 8) {
  if (!shift.site || !shift.date) return [];
  const monthKey = shift.date.slice(0, 7);
  const all = publishedShifts();
  const worksSite = new Set();
  const busy = new Set();
  const monthCount = {};
  for (const s of all) {
    if (!s.who) continue;
    if (s.site === shift.site) worksSite.add(s.who);
    if (s.date === shift.date && s.id !== shift.id) busy.add(s.who);
    if (s.date.startsWith(monthKey)) monthCount[s.who] = (monthCount[s.who] || 0) + 1;
  }
  const pref = name => (overlay.prefs[name] || {})[shift.date] || null;
  return [...worksSite]
    .filter(n => !busy.has(n) && pref(n) !== 'no')
    .sort((a, b) =>
      (pref(b) === 'like' ? 1 : 0) - (pref(a) === 'like' ? 1 : 0) ||
      (monthCount[a] || 0) - (monthCount[b] || 0) ||
      a.localeCompare(b))
    .slice(0, topN)
    .map(n => ({ name: n, count: monthCount[n] || 0, likes: pref(n) === 'like' }));
}

/* ---------- filter bar ---------- */

function monthList() {
  return [...new Set(adminShifts().map(s => s.date.slice(0, 7)))].sort();
}
function addMonths(mo, n) {
  const [y, m] = mo.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function monthDays(mo) {
  const [y, m] = mo.split('-').map(Number);
  const daysIn = new Date(y, m, 0).getDate();
  return Array.from({ length: daysIn }, (_, i) => `${mo}-${String(i + 1).padStart(2, '0')}`);
}

function renderFilterBar() {
  const months = monthList();
  if (!state.month) state.month = months.includes(TODAY.slice(0, 7)) ? TODAY.slice(0, 7) : months[0];

  const ws = $('#weekSelect');
  ws.innerHTML = '';
  for (const mo of months) {
    const o = el('option', '', fmtMonth(mo));
    o.value = mo;
    if (mo === state.month) o.selected = true;
    ws.append(o);
  }

  const sf = $('#siteFilter');
  const sites = [...new Set(base.map(s => s.site).filter(Boolean))]
    .sort((a, b) => siteName(a).localeCompare(siteName(b)));
  sf.innerHTML = '<option value="">All sites</option>';
  for (const s of sites) {
    const o = el('option', '', `${siteName(s)} (${s})`);
    o.value = s;
    if (s === state.site) o.selected = true;
    sf.append(o);
  }

  const pf = $('#posFilter');
  const list = state.site ? base.filter(s => s.site === state.site) : base;
  const poss = [...new Set(list.map(s => s.pos))].sort();
  if (state.pos && !poss.includes(state.pos)) state.pos = '';
  pf.innerHTML = '<option value="">All positions</option>';
  for (const p of poss) {
    const o = el('option', '', p);
    o.value = p;
    if (p === state.pos) o.selected = true;
    pf.append(o);
  }
}

function renderDatalists() {
  const people = [...new Set(base.map(s => s.who).filter(Boolean))].sort();
  $('#peopleList').innerHTML = people.map(p => `<option value="${p.replace(/"/g, '&quot;')}">`).join('');
  const poss = [...new Set(base.map(s => s.pos))].sort();
  $('#posList').innerHTML = poss.map(p => `<option value="${p.replace(/"/g, '&quot;')}">`).join('');
  const sites = [...new Set(base.map(s => s.site).filter(Boolean))].sort();
  $('#siteList').innerHTML = sites.map(p => `<option value="${p}">`).join('');
}

/* ---------- approvals ---------- */

function pendingCounts() {
  const swaps = overlay.trades.filter(t => t.status === 'claimed').length;
  const subs = overlay.reqSubmissions.filter(s => !s.ack).length;
  const msgs = overlay.messages.filter(m => !m.to && (!m.replies.length || m.replies[m.replies.length - 1].from !== 'Scheduler')).length;
  return { swaps, subs, msgs };
}

function kpi(num, label, cls, onclick) {
  const k = el(onclick ? 'button' : 'div', 'kpi' + (cls ? ' ' + cls : ''));
  k.append(el('span', 'num', String(num)), el('span', 'lbl', label));
  if (onclick) k.onclick = onclick;
  return k;
}

function conflictChips(td, name, shift) {
  const probs = conflictsFor(name, shift);
  if (!probs.length) { td.append(el('span', 'okhint', '✓ no conflicts')); return; }
  for (const p of probs) td.append(el('span', 'conflict', '⚠ ' + p));
}

function renderApprovals(main) {
  const { swaps, subs, msgs } = pendingCounts();
  const opensMonth = publishedShifts().filter(s => !s.who && s.date >= TODAY && s.date.startsWith(TODAY.slice(0, 7))).length;
  $('#weekStats').textContent = `${swaps} swap${swaps === 1 ? '' : 's'} to approve · ${subs} submission${subs === 1 ? '' : 's'} to review · ${msgs} message${msgs === 1 ? '' : 's'} awaiting reply`;

  const wrap = el('div', 'reqwrap');
  const kpis = el('div', 'kpirow');
  kpis.append(kpi(swaps, 'Swaps & pickups to approve', swaps ? 'warn' : 'ok'));
  kpis.append(kpi(subs, 'Time-off submissions to review', subs ? 'warn' : 'ok'));
  kpis.append(kpi(msgs, 'Messages awaiting reply', msgs ? 'warn' : 'ok'));
  kpis.append(kpi(opensMonth, 'Open shifts left this month', opensMonth ? 'warn' : 'ok', () => { state.month = TODAY.slice(0, 7); setView('coverage'); }));
  wrap.append(kpis);

  const q = state.search.toLowerCase();

  /* --- swaps & pickups awaiting approval --- */
  const claimed = overlay.trades.filter(t => t.status === 'claimed')
    .filter(t => !q || [t.who, t.claimedBy, t.targetWho].some(n => (n || '').toLowerCase().includes(q)))
    .sort((a, b) => b.id.localeCompare(a.id));
  const box1 = el('div', 'reqform');
  const h1 = el('h2', '', 'Swaps & pickups awaiting approval');
  if (claimed.length) h1.append(el('span', 'req-badge req-pending secheadcount', String(claimed.length)));
  box1.append(h1);
  if (!claimed.length) {
    box1.append(el('div', 'approval-empty', 'Nothing waiting. Claims from the employee app land here the moment they happen.'));
  } else {
    const table = el('table', 'flat');
    table.innerHTML = '<thead><tr><th>Shift</th><th>From → To</th><th>In return</th><th>Impact check</th><th>Note</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const t of claimed) {
      const s = shiftById(t.shiftId);
      const requested = t.requestedShiftId ? shiftById(t.requestedShiftId) : null;
      const gains = t.targetWho || t.claimedBy;
      const tr = el('tr');
      tr.append(el('td', '', s ? `${fmtDateLong(s.date)} · ${s.start}–${s.end} · ${s.pos} (${s.site || '—'})` : '(shift no longer exists)'));
      tr.append(el('td', '', `${t.who.replace(/,.*$/, '')} → ${(gains || '?').replace(/,.*$/, '')}`));
      tr.append(el('td', '', requested ? `${fmtDateLong(requested.date)} · ${requested.start}–${requested.end} → ${t.who.replace(/,.*$/, '')}` : '—'));
      const tdC = el('td');
      if (s && gains) conflictChips(tdC, gains, s);
      if (requested && t.targetWho) conflictChips(tdC, t.who, requested);
      tr.append(tdC);
      tr.append(el('td', '', t.note || '—'));
      const tdA = el('td');
      if (s) {
        const ok = el('button', 'primary', 'Approve');
        ok.onclick = () => {
          applyEditPublished(s, { who: gains });
          if (requested && t.targetWho) applyEditPublished(requested, { who: t.who });
          t.status = 'approved';
          pushNotif(t.who, `Trade approved: your ${fmtDate(s.date)} swap is complete`, 'requests', 'swap');
          pushNotif(gains, `Trade approved: you now work ${fmtDate(s.date)} ${s.start}–${s.end} at ${s.site}`, 'requests', 'swap');
          audit(`Approved swap — ${describeShift(s)}: ${t.who} → ${gains}${requested && t.targetWho ? ` (in return: ${describeShift(requested)} → ${t.who})` : ''}`, 'approval');
          saveOverlay(); render();
        };
        tdA.append(ok);
      }
      const no = el('button', 'danger', 'Deny');
      no.onclick = () => {
        if (gains) pushNotif(gains, `Trade denied for ${t.who}'s ${s ? fmtDate(s.date) : ''} shift`, 'requests', 'swap');
        t.status = t.targetWho ? 'denied' : 'open';
        t.claimedBy = null;
        audit(`Denied swap — ${s ? describeShift(s) : t.shiftId}: ${t.who} → ${gains || '?'}`, 'denial');
        saveOverlay(); render();
      };
      tdA.append(no);
      tr.append(tdA);
      tb.append(tr);
    }
    table.append(tb);
    box1.append(table);
  }
  wrap.append(box1);

  /* --- time-off / preference submissions --- */
  const submissions = overlay.reqSubmissions
    .filter(sub => !q || sub.who.toLowerCase().includes(q))
    .slice().sort((a, b) => (a.ack ? 1 : 0) - (b.ack ? 1 : 0) || b.id.localeCompare(a.id));
  const box2 = el('div', 'reqform');
  const h2 = el('h2', '', 'Time-off & preference submissions');
  if (subs) h2.append(el('span', 'req-badge req-pending secheadcount', String(subs)));
  box2.append(h2);
  if (!submissions.length) {
    box2.append(el('div', 'approval-empty', 'No submissions yet. Staff submit month preferences from Requests → "Request days off / preferences".'));
  } else {
    const table = el('table', 'flat');
    table.innerHTML = '<thead><tr><th>Employee</th><th>Month</th><th>Days marked</th><th>Conflicts with current schedule</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const sub of submissions.slice(0, 25)) {
      const tr = el('tr');
      tr.append(el('td', '', sub.who));
      tr.append(el('td', '', fmtMonth(sub.month)));
      const marks = Object.entries(overlay.prefs[sub.who] || {})
        .filter(([iso, v]) => iso.startsWith(sub.month) && v)
        .sort((a, b) => a[0].localeCompare(b[0]));
      const tdM = el('td');
      if (!marks.length) tdM.append(el('span', '', sub.summary || '—'));
      const sym = { like: '✓', dislike: '~', no: '✕' };
      for (const [iso, v] of marks) {
        const chip = el('span', 'subprefday pref-' + v, `${sym[v]} ${Number(iso.slice(8))}`);
        chip.title = `${fmtDateLong(iso)} — ${v === 'no' ? 'unavailable' : v === 'like' ? 'prefers to work' : 'rather not'}`;
        tdM.append(chip);
      }
      tr.append(tdM);
      const tdC = el('td');
      let anyConflict = false;
      for (const [iso, v] of marks) {
        if (v !== 'no') continue;
        for (const s of publishedShifts()) {
          if (s.who !== sub.who || s.date !== iso) continue;
          anyConflict = true;
          const c = el('span', 'conflict', `⚠ scheduled ${fmtDate(iso)} ${s.start}–${s.end} (${s.site || '—'})`);
          tdC.append(c);
          const fix = el('button', 'linklike', 'unassign → draft');
          fix.title = 'Stage a draft change that opens this shift; publish from Builder when ready';
          fix.onclick = () => {
            draftEdit(s, { who: '' });
            audit(`Draft: opened ${describeShift(s)} (was ${sub.who}) per time-off request`, 'edit');
            render();
          };
          tdC.append(fix);
        }
      }
      if (!anyConflict) tdC.append(el('span', 'okhint', marks.some(([, v]) => v === 'no') ? '✓ nothing scheduled on unavailable days' : '— preferences only'));
      tr.append(tdC);
      const tdA = el('td');
      if (sub.ack) {
        tdA.append(el('span', 'req-badge req-approved', 'reviewed'));
      } else {
        const ack = el('button', 'primary', 'Mark reviewed');
        ack.onclick = () => {
          sub.ack = TODAY;
          pushNotif(sub.who, `The scheduler reviewed your ${fmtMonth(sub.month)} requests`, 'requests', 'prefs');
          audit(`Reviewed ${sub.who}'s ${fmtMonth(sub.month)} preference submission (${sub.summary})`, 'approval');
          saveOverlay(); render();
        };
        tdA.append(ack);
      }
      tr.append(tdA);
      tb.append(tr);
    }
    table.append(tb);
    box2.append(table);
  }
  wrap.append(box2);

  /* --- open offers still waiting on coworkers --- */
  const waiting = overlay.trades.filter(t => ['open', 'proposed'].includes(t.status))
    .filter(t => !q || [t.who, t.targetWho].some(n => (n || '').toLowerCase().includes(q)))
    .sort((a, b) => b.id.localeCompare(a.id));
  const box3 = el('div', 'reqform');
  box3.append(el('h2', '', `On the trade board, waiting on coworkers (${waiting.length})`));
  if (!waiting.length) {
    box3.append(el('div', 'approval-empty', 'No open offers right now.'));
  } else {
    const table = el('table', 'flat');
    table.innerHTML = '<thead><tr><th>Shift</th><th>Offered by</th><th>Directed to</th><th>Note</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const t of waiting.slice(0, 15)) {
      const s = shiftById(t.shiftId);
      const tr = el('tr');
      tr.append(el('td', '', s ? `${fmtDateLong(s.date)} · ${s.start}–${s.end} · ${s.pos} (${s.site || '—'})` : '(shift no longer exists)'));
      tr.append(el('td', '', t.who));
      tr.append(el('td', '', t.targetWho || 'anyone at the site'));
      tr.append(el('td', '', t.note || '—'));
      const tdA = el('td');
      const pull = el('button', 'danger', 'Withdraw');
      pull.title = 'Remove this offer from the board on the employee’s behalf';
      pull.onclick = () => {
        if (!confirm(`Withdraw ${t.who}'s offer from the board?`)) return;
        t.status = 'cancelled';
        pushNotif(t.who, `The scheduler withdrew your ${s ? fmtDate(s.date) + ' ' : ''}swap offer`, 'requests', 'swap');
        audit(`Withdrew ${t.who}'s swap offer${s ? ` — ${describeShift(s)}` : ''}`, 'denial');
        saveOverlay(); render();
      };
      tdA.append(pull);
      tr.append(tdA);
      tb.append(tr);
    }
    table.append(tb);
    box3.append(table);
  }
  wrap.append(box3);

  /* --- scheduler inbox --- */
  const inbox = overlay.messages.filter(m => !m.to)
    .filter(m => !q || m.who.toLowerCase().includes(q))
    .slice().sort((a, b) => b.id.localeCompare(a.id));
  const box4 = el('div', 'reqform');
  const h4 = el('h2', '', 'Scheduler inbox');
  if (msgs) h4.append(el('span', 'req-badge req-pending secheadcount', String(msgs)));
  box4.append(h4);
  if (!inbox.length) {
    box4.append(el('div', 'approval-empty', 'No messages from staff yet.'));
  } else {
    const list = el('div', 'msglist');
    for (const m of inbox.slice(0, 20)) {
      const item = el('div', 'msg');
      const head = el('div', 'msghead');
      head.append(el('b', '', m.who));
      head.append(el('span', '', fmtDateLong(m.created)));
      const last = m.replies.length ? m.replies[m.replies.length - 1].from : null;
      if (last !== 'Scheduler') head.append(el('span', 'req-badge req-pending', 'awaiting reply'));
      item.append(head, el('div', 'msgtext', m.text));
      for (const r of m.replies) {
        const rep = el('div', 'msgreply');
        rep.append(el('b', '', r.from + ': '));
        rep.append(document.createTextNode(r.text));
        item.append(rep);
      }
      const rform = el('form', 'replyform');
      const rin = el('input');
      rin.placeholder = 'Reply…';
      rin.required = true;
      const rbtn = el('button', 'primary', 'Reply');
      rbtn.type = 'submit';
      rform.append(rin, rbtn);
      rform.onsubmit = e => {
        e.preventDefault();
        m.replies.push({ from: 'Scheduler', text: rin.value.trim(), created: TODAY });
        pushNotif(m.who, 'The scheduler replied to your message', 'contact');
        audit(`Replied to ${m.who}'s message`, 'message');
        saveOverlay(); render();
      };
      item.append(rform);
      list.append(item);
    }
    box4.append(list);
  }
  wrap.append(box4);

  main.append(wrap);
}

/* ---------- coverage board ---------- */

/* ---------- phone month calendar: whole month in one grid + tap-a-day detail ----------
   Mirrors the employee app's phoneMonthCal. opts: cellMarks(iso, items) → small nodes
   per day cell; detailChip(item) → full chip for the tapped day; expandSet, isOpen,
   sort, searchable, collapse, onAdd. */
function phoneMonthCal(main, mo, byDay, opts) {
  const collapse = opts.collapse || 8;
  const expandSet = opts.expandSet || state.expandedDays;
  const isOpen = opts.isOpen || (s => !s.who);
  if (state.selDay && !state.selDay.startsWith(mo)) state.selDay = null;
  const sel = state.selDay || (TODAY.startsWith(mo) ? TODAY : null);

  const [y, m] = mo.split('-').map(Number);
  const table = el('table', 'bigcal phonecal');
  const hr = el('tr');
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) hr.append(el('th', '', d));
  table.append(hr);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(y, m, 0).getDate();
  let tr = el('tr');
  for (let i = 0; i < first.getUTCDay(); i++) tr.append(el('td', 'off'));
  for (let day = 1; day <= daysIn; day++) {
    const iso = `${mo}-${String(day).padStart(2, '0')}`;
    const td = el('td', (iso === TODAY ? 'today' : '') + (iso === sel ? ' sel' : '') + (iso === state.focusDay ? ' focusday' : ''));
    td.append(el('div', 'dn', String(day)));
    for (const node of opts.cellMarks(iso, byDay.get(iso) || [])) td.append(node);
    td.onclick = () => { state.selDay = iso; render(); };
    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  main.append(table);

  if (!sel) {
    main.append(el('div', 'daydetail-hint', 'Tap a day to see and edit its shifts.'));
    return;
  }
  const cell = (byDay.get(sel) || []).slice()
    .sort(opts.sort || ((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos)));
  const card = el('div', 'aday daydetail' + (sel === TODAY ? ' today' : ''));
  const head = el('div', 'adayhead');
  head.append(el('span', 'adayname', fmtDateLong(sel)));
  if (sel === TODAY) head.append(el('span', 'todaytag', 'Today'));
  const openCount = cell.filter(isOpen).length;
  if (openCount) head.append(el('span', 'opendot', `${openCount} open`));
  card.append(head);
  // with a search active, surface matching shifts instead of the first N
  const q = state.search.toLowerCase();
  const ordered = q && opts.searchable !== false
    ? [...cell].sort((a, b) => (matchesSearch(b, q) ? 1 : 0) - (matchesSearch(a, q) ? 1 : 0))
    : cell;
  const expanded = expandSet.has(sel);
  const show = expanded ? ordered : ordered.slice(0, collapse);
  for (const item of show) card.append(opts.detailChip(item));
  if (ordered.length > collapse) {
    const more = el('button', 'morebtn', expanded ? 'show less' : `+${ordered.length - collapse} more`);
    more.onclick = () => {
      if (expanded) expandSet.delete(sel); else expandSet.add(sel);
      render();
    };
    card.append(more);
  }
  if (!cell.length) card.append(el('div', 'anone', 'No shifts'));
  if (opts.onAdd) {
    const add = el('button', 'addbtn agenda-add', '+ add shift');
    add.onclick = () => opts.onAdd(sel);
    card.append(add);
  }
  main.append(card);
}

function renderCoverage(main) {
  const days = monthDays(state.month);
  const inWindow = filtered(adminShifts()).filter(s => s.date.startsWith(state.month));
  const q = state.search.toLowerCase();

  const bySiteDay = new Map();   // site -> date -> shifts
  for (const s of inWindow) {
    const site = s.site || '—';
    if (q && !site.toLowerCase().includes(q) && !siteName(site).toLowerCase().includes(q)) continue;
    if (!bySiteDay.has(site)) bySiteDay.set(site, new Map());
    const m = bySiteDay.get(site);
    if (!m.has(s.date)) m.set(s.date, []);
    m.get(s.date).push(s);
  }

  const openTotal = inWindow.filter(s => !s.who && s.date >= TODAY).length;
  const gapSites = [...bySiteDay.entries()].filter(([, m]) => [...m.values()].some(list => list.some(s => !s.who && s.date >= TODAY))).length;
  const draftPending = draftCount();
  $('#weekStats').textContent = `${fmtMonth(state.month)} · ${openTotal} unfilled upcoming shift${openTotal === 1 ? '' : 's'} across ${gapSites} site${gapSites === 1 ? '' : 's'}`;

  const kpis = el('div', 'kpirow');
  kpis.append(kpi(openTotal, 'Unfilled this month (upcoming)', openTotal ? 'warn' : 'ok'));
  kpis.append(kpi(gapSites, 'Sites with gaps', gapSites ? 'warn' : 'ok'));
  kpis.append(kpi(draftPending, 'Draft changes awaiting publish', draftPending ? 'draftk' : '', draftPending ? () => setView('builder') : null));
  main.append(kpis);

  const legend = el('div', 'covlegend');
  const sw = (color, label) => {
    const spanWrap = el('span');
    const s1 = el('span', 'swatch');
    s1.style.background = color;
    spanWrap.append(s1, document.createTextNode(label));
    return spanWrap;
  };
  legend.append(sw('var(--open-bg)', 'needs coverage (number = unfilled)'));
  legend.append(sw('color-mix(in srgb, #00d084 25%, var(--panel))', 'fully covered'));
  legend.append(sw('var(--rh-yellow)', 'has unpublished draft changes'));
  legend.append(el('span', '', "Click any cell to open that site's full month in the Builder."));
  main.append(legend);

  const covName = site => site === '—' ? '(no site listed)' : siteName(site);
  const sites = [...bySiteDay.keys()].sort((a, b) => {
    if ((a === '—') !== (b === '—')) return a === '—' ? 1 : -1;   // the no-site bucket sinks to the bottom
    const opensA = [...bySiteDay.get(a).values()].flat().filter(s => !s.who && s.date >= TODAY).length;
    const opensB = [...bySiteDay.get(b).values()].flat().filter(s => !s.who && s.date >= TODAY).length;
    return opensB - opensA || siteName(a).localeCompare(siteName(b));
  });

  const wrap = el('div', 'covwrap');
  const table = el('table', 'cov');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'sitecol', 'Site'));
  for (const d of days) hr.append(el('th', (d === TODAY ? 'today ' : '') + (isWeekendDate(d) ? 'wknd' : ''), fmtDayCol(d)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  for (const site of sites) {
    const tr = el('tr');
    const th = el('th', 'sitecol');
    th.append(document.createTextNode(covName(site)));
    const winOpens = [...bySiteDay.get(site).values()].flat().filter(s => !s.who && s.date >= TODAY).length;
    th.append(el('span', 'sitesub', `${site} · ${winOpens ? winOpens + ' unfilled' : 'covered'}`));
    tr.append(th);
    for (const d of days) {
      const td = el('td', isWeekendDate(d) ? 'wknd' : '');
      const cell = (bySiteDay.get(site).get(d) || []);
      const open = cell.filter(s => !s.who).length;
      const hasDraft = cell.some(s => s.draft);
      const b = el('button', 'covcell' + (open ? ' gap' : cell.length ? ' ok' : '') + (hasDraft ? ' hasdraft' : ''));
      if (cell.length) {
        b.append(el('span', 'gapnum', open ? `${open} open` : '✓'));
        b.append(el('span', 'totnum', `${cell.length} shift${cell.length === 1 ? '' : 's'}`));
      } else b.append(el('span', 'totnum', '—'));
      b.title = `${covName(site)} · ${fmtDateLong(d)} — ${cell.length} shifts, ${open} unfilled · opens the month schedule`;
      b.onclick = () => {
        state.site = site === '—' ? '' : site;
        state.focusDay = d;
        state.selDay = d;
        setView('builder');
        document.querySelector('.bigcal td.focusday')?.scrollIntoView({ block: 'center' });
      };
      td.append(b);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  main.append(wrap);

}

/* ---------- builder ---------- */

const COLLAPSED_CHIPS = 6;

function builderChip(s) {
  const b = el('button', 'chip mini2' + (s.who ? '' : ' open') + (s.edited ? ' edited' : '') + (s.draft ? ' draftchip' : ''));
  b.style.setProperty('--site', siteColor(s.site));
  const role = providerRole(s);
  if (role) b.classList.add('role-' + role.toLowerCase());
  b.append(el('span', 't', `${s.start}–${s.end}`));
  const meta = [s.site, role].filter(Boolean).join(' · ');
  b.append(el('span', 'who', (s.who ? s.who.replace(/,.*$/, '') : 'OPEN') + (meta ? ` · ${meta}` : '')));
  if (isPhone()) b.append(el('span', 'site', s.pos));
  if (s.draft) b.append(el('span', 'draftflag', 'draft'));
  b.title = `${s.start}–${s.end} · ${s.pos} · ${s.who || 'OPEN'}${s.site ? ` · ${siteName(s.site)}` : ''}${s.note ? ` — ${s.note}` : ''}${s.draft ? ' · DRAFT (unpublished)' : ''}`;
  if (state.search && !matchesSearch(s, state.search.toLowerCase())) b.classList.add('dim');
  b.onclick = () => openDialog(s);
  return b;
}

function renderBuilder(main) {
  const mo = state.month;
  const list = filtered(adminShifts()).filter(s => s.date.startsWith(mo));
  const open = list.filter(s => !s.who).length;
  const drafts = list.filter(s => s.draft).length;
  $('#weekStats').textContent = `${fmtMonth(mo)} · ${list.length.toLocaleString()} shifts · ${open} open · ${drafts} draft`;

  /* copy-month tool */
  const tool = el('div', 'reqform copytool');
  tool.append(el('h2', '', 'Copy a month forward'));
  const row = el('div', 'reqrow');
  const months = monthList();
  /* target list also offers blank future months past the data range — that's
     how the next schedule period gets scaffolded */
  const dstMonths = [...months];
  for (let i = 1; i <= 3; i++) dstMonths.push(addMonths(months[months.length - 1], i));
  const mkSel = list => {
    const sel = document.createElement('select');
    for (const m2 of list) {
      const o = el('option', '', `${fmtMonth(m2)}${months.includes(m2) ? '' : ' (new month)'}`);
      o.value = m2;
      sel.append(o);
    }
    return sel;
  };
  const srcSel = mkSel(months);
  const dstSel = mkSel(dstMonths);
  srcSel.value = state.month;
  const nextMo = addMonths(state.month, 1);
  dstSel.value = dstMonths.includes(nextMo) ? nextMo : dstMonths[dstMonths.length - 1];
  const lb = (txt, inp) => { const l = el('label', '', txt + ' '); l.append(inp); return l; };
  row.append(lb('Copy shifts from', srcSel), lb('into', dstSel));
  const go = el('button', 'primary', 'Copy → draft');
  go.type = 'button';
  go.onclick = () => {
    const src = srcSel.value, dst = dstSel.value;
    if (src === dst) { alert('Pick two different months.'); return; }
    const srcShifts = filtered(adminShifts()).filter(s => s.date.startsWith(src));
    if (!srcShifts.length) { alert('No shifts in the source month (with these filters).'); return; }
    const scope = state.site ? `${siteName(state.site)}` : 'ALL sites';
    if (!confirm(`Copy ${srcShifts.length} shifts (${scope}${state.pos ? ` · ${state.pos}` : ''}) from ${fmtMonth(src)} into ${fmtMonth(dst)} as drafts?\n\nWeekdays stay aligned (first week maps to first week); days that fall outside ${fmtMonth(dst)} are skipped.`)) return;
    const existing = new Set(adminShifts().map(s => [s.date, s.pos, s.start, s.end, s.who, s.site].join('|')));
    /* weekday-aligned mapping: offset both months from the Sunday on/before the 1st */
    const anchorSrc = sundayOf(src + '-01');
    const anchorDst = sundayOf(dst + '-01');
    let n = 0, outside = 0;
    for (const s of srcShifts) {
      const offset = Math.round((Date.parse(s.date) - Date.parse(anchorSrc)) / 86400000);
      const date = addDays(anchorDst, offset);
      if (!date.startsWith(dst)) { outside++; continue; }
      if (existing.has([date, s.pos, s.start, s.end, s.who, s.site].join('|'))) continue;
      overlay.adminDraft.added.push({ id: nextAddId(), date, pos: s.pos, start: s.start, end: s.end, who: s.who, site: s.site, note: s.note });
      n++;
    }
    saveOverlay();
    audit(`Draft: copied ${n} shifts from ${fmtMonth(src)} to ${fmtMonth(dst)} (${scope}${outside ? `; ${outside} fell outside the month` : ''})`, 'edit');
    render();
  };
  row.append(go);
  tool.append(row);
  tool.append(el('div', 'reqhint', 'Copies every shift (assignments included) with your current site/position filters applied, weekday-aligned, skipping duplicates. Review edge days in the calendar, then publish.'));
  main.append(tool);

  /* month grid */
  const byDay = new Map();
  for (const s of list) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }

  if (isPhone()) {
    phoneMonthCal(main, mo, byDay, {
      detailChip: builderChip,
      onAdd: iso => openDialog(null, { date: iso, pos: state.pos || '', site: state.site || '' }),
      cellMarks: (iso, cell) => {
        const out = [];
        if (cell.length) out.push(el('span', 'cellcount', cell.length.toLocaleString()));
        const openCount = cell.filter(s => !s.who).length;
        if (openCount) out.push(el('span', 'cellcount open', `${openCount} open`));
        const draftsN = cell.filter(s => s.draft).length;
        if (draftsN) out.push(el('span', 'cellcount draft', `${draftsN} draft`));
        return out;
      },
    });
    return;
  }

  const [y, m] = mo.split('-').map(Number);
  const table = el('table', 'bigcal');
  const hr = el('tr');
  for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) hr.append(el('th', '', d));
  table.append(hr);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(y, m, 0).getDate();
  let tr = el('tr');
  for (let i = 0; i < first.getUTCDay(); i++) tr.append(el('td', 'off'));
  for (let day = 1; day <= daysIn; day++) {
    const iso = `${mo}-${String(day).padStart(2, '0')}`;
    const td = el('td', (iso === TODAY ? 'today ' : '') + (iso === state.focusDay ? 'focusday' : ''));
    const cell = (byDay.get(iso) || []).sort((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    const dn = el('div', 'dn');
    dn.append(el('span', '', String(day)));
    const openCount = cell.filter(s => !s.who).length;
    if (openCount) dn.append(el('span', 'opendot', `${openCount} open`));
    td.append(dn);
    const expanded = state.expandedDays.has(iso);
    const qq = state.search.toLowerCase();
    const ordered = qq
      ? [...cell].sort((a, b) => (matchesSearch(b, qq) ? 1 : 0) - (matchesSearch(a, qq) ? 1 : 0))
      : cell;
    const show = expanded ? ordered : ordered.slice(0, COLLAPSED_CHIPS);
    for (const s of show) td.append(builderChip(s));
    if (ordered.length > COLLAPSED_CHIPS) {
      const more = el('button', 'morebtn', expanded ? 'show less' : `+${ordered.length - COLLAPSED_CHIPS} more`);
      more.onclick = () => {
        if (expanded) state.expandedDays.delete(iso); else state.expandedDays.add(iso);
        render();
      };
      td.append(more);
    }
    const add = el('button', 'addbtn', '+ add');
    add.onclick = () => openDialog(null, { date: iso, pos: state.pos || '', site: state.site || '' });
    td.append(add);
    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  main.append(table);
}

/* ---------- reports ---------- */

function fairnessRows(mo) {
  const list = filtered(publishedShifts()).filter(s => s.date.startsWith(mo));
  const q = state.search.toLowerCase();
  const map = new Map();
  for (const s of list) {
    if (!s.who) continue;
    if (q && !s.who.toLowerCase().includes(q)) continue;
    if (!map.has(s.who)) map.set(s.who, { name: s.who, n: 0, h: 0, nights: 0, wknd: 0, sites: new Set() });
    const p = map.get(s.who);
    p.n++;
    p.h += hours(s);
    if (isNight(s)) p.nights++;
    if (isWeekendDate(s.date)) p.wknd++;
    if (s.site) p.sites.add(s.site);
  }
  return [...map.values()];
}

function wellnessFlags(mo) {
  const list = filtered(publishedShifts()).filter(s => s.date.startsWith(mo) && s.who);
  const byPerson = new Map();
  for (const s of list) {
    if (!byPerson.has(s.who)) byPerson.set(s.who, []);
    byPerson.get(s.who).push(s);
  }
  const flags = [];
  for (const [name, ss] of byPerson) {
    /* overnight → morning shift the next day */
    for (const s of ss) {
      if (!isOvernight(s)) continue;
      const next = ss.find(x => x.date === addDays(s.date, 1) && x.start < '12:00' && !isOvernight(x));
      if (next) flags.push({ name, flag: 'Overnight into a day shift', detail: `${fmtDate(s.date)} ${s.start}–${s.end} then ${fmtDate(next.date)} ${next.start}–${next.end}` });
    }
    /* 8+ days in a row (7-on/7-off is a normal hospitalist block — don't flag it) */
    const dates = [...new Set(ss.map(s => s.date))].sort();
    let run = [dates[0]];
    for (let i = 1; i <= dates.length; i++) {
      if (i < dates.length && dates[i] === addDays(dates[i - 1], 1)) { run.push(dates[i]); continue; }
      if (run.length >= 8) flags.push({ name, flag: `${run.length} days in a row`, detail: `${fmtDate(run[0])} – ${fmtDate(run[run.length - 1])}` });
      run = [dates[i]];
    }
  }
  const q = state.search.toLowerCase();
  return flags.filter(f => !q || f.name.toLowerCase().includes(q));
}

function renderReports(main) {
  const mo = state.month;
  const rows = fairnessRows(mo);
  const list = filtered(publishedShifts()).filter(s => s.date.startsWith(mo));
  const opens = list.filter(s => !s.who).length;
  $('#weekStats').textContent = `${fmtMonth(mo)} · ${rows.length} people · ${list.length.toLocaleString()} shifts · ${opens} open${draftCount() ? ` · draft changes not included (${draftCount()} unpublished)` : ''}`;

  const wrap = el('div', 'reqwrap');

  const kpis = el('div', 'kpirow');
  kpis.append(kpi(rows.length, 'People scheduled'));
  kpis.append(kpi(list.length.toLocaleString(), 'Shifts this month'));
  kpis.append(kpi(Math.round(rows.reduce((a, p) => a + p.h, 0)).toLocaleString(), 'Total hours'));
  kpis.append(kpi(opens, 'Still open', opens ? 'warn' : 'ok'));
  wrap.append(kpis);

  /* fairness table */
  const box = el('div', 'reqform');
  box.append(el('h2', '', 'Load & fairness — who carries what'));
  const table = el('table', 'flat');
  const cols = [['name', 'Name'], ['n', 'Shifts'], ['h', 'Hours'], ['nights', 'Nights'], ['wknd', 'Weekend days'], ['sites', 'Sites']];
  const thead = el('thead');
  const trh = el('tr');
  for (const [key, label] of cols) {
    const th = el('th', 'sortable' + (state.repSort.key === key ? ' sorted' : ''), label + (state.repSort.key === key ? (state.repSort.dir < 0 ? ' ↓' : ' ↑') : ''));
    th.onclick = () => {
      state.repSort = { key, dir: state.repSort.key === key ? -state.repSort.dir : (key === 'name' ? 1 : -1) };
      render();
    };
    trh.append(th);
  }
  thead.append(trh);
  table.append(thead);
  const { key, dir } = state.repSort;
  rows.sort((a, b) => {
    const va = key === 'sites' ? a.sites.size : a[key];
    const vb = key === 'sites' ? b.sites.size : b[key];
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  const tb = el('tbody');
  const avgN = rows.length ? rows.reduce((a, p) => a + p.n, 0) / rows.length : 0;
  for (const p of rows.slice(0, 80)) {
    const tr = el('tr');
    tr.append(el('td', '', p.name));
    tr.append(el('td', '', String(p.n)));
    tr.append(el('td', '', String(Math.round(p.h))));
    tr.append(el('td', '', String(p.nights)));
    tr.append(el('td', '', String(p.wknd)));
    tr.append(el('td', '', [...p.sites].sort().join(', ')));
    tb.append(tr);
  }
  table.append(tb);
  box.append(table);
  if (rows.length > 80) box.append(el('div', 'reqhint', `Showing 80 of ${rows.length} — use search or the site filter to narrow, or export the full CSV.`));
  else box.append(el('div', 'reqhint', `Average ${avgN.toFixed(1)} shifts/person with these filters. Sort any column; export with the CSV button up top.`));
  wrap.append(box);

  /* wellness flags */
  const flags = wellnessFlags(mo);
  const box2 = el('div', 'reqform');
  box2.append(el('h2', '', `Schedule wellness flags (${flags.length})`));
  if (!flags.length) {
    box2.append(el('div', 'approval-empty', 'No overnight-into-day turnarounds or 8+ day stretches this month with these filters. 🎉'));
  } else {
    const t2 = el('table', 'flat');
    t2.innerHTML = '<thead><tr><th>Person</th><th>Flag</th><th>Detail</th></tr></thead>';
    const tb2 = el('tbody');
    for (const f of flags.slice(0, 60)) {
      const tr = el('tr');
      tr.append(el('td', '', f.name));
      const tdF = el('td');
      tdF.append(el('span', 'flagchip', f.flag));
      tr.append(tdF);
      tr.append(el('td', '', f.detail));
      tb2.append(tr);
    }
    t2.append(tb2);
    box2.append(t2);
  }
  wrap.append(box2);

  /* per-site coverage summary */
  const box3 = el('div', 'reqform');
  box3.append(el('h2', '', 'Coverage by site'));
  const bySite = new Map();
  for (const s of list) {
    const site = s.site || '—';
    if (!bySite.has(site)) bySite.set(site, { total: 0, open: 0, future: 0 });
    const v = bySite.get(site);
    v.total++;
    if (!s.who) { v.open++; if (s.date >= TODAY) v.future++; }
  }
  const t3 = el('table', 'flat');
  t3.innerHTML = '<thead><tr><th>Site</th><th>Shifts</th><th>Unfilled</th><th>Unfilled (upcoming)</th><th>Filled</th></tr></thead>';
  const tb3 = el('tbody');
  for (const [site, v] of [...bySite.entries()].sort((a, b) => b[1].future - a[1].future || siteName(a[0]).localeCompare(siteName(b[0])))) {
    const tr = el('tr');
    const tdS = el('td');
    const tag = el('span', 'sitetag', site);
    tag.style.setProperty('--site', siteColor(site));
    tdS.append(tag, document.createTextNode(' ' + siteName(site)));
    tr.append(tdS);
    tr.append(el('td', '', String(v.total)));
    tr.append(el('td', '', String(v.open)));
    const tdF = el('td');
    tdF.append(v.future ? el('span', 'req-badge req-pending', String(v.future)) : el('span', 'okhint', '✓'));
    tr.append(tdF);
    tr.append(el('td', '', `${Math.round((1 - v.open / v.total) * 100)}%`));
    tb3.append(tr);
  }
  t3.append(tb3);
  box3.append(t3);
  wrap.append(box3);

  main.append(wrap);
}

/* ---------- audit trail ---------- */

function renderAudit(main) {
  const entries = overlay.audit.slice().reverse();
  const q = state.search.toLowerCase();
  const visible = entries.filter(a => !q || a.text.toLowerCase().includes(q));
  $('#weekStats').textContent = `${visible.length} logged action${visible.length === 1 ? '' : 's'}`;

  const box = el('div', 'reqform');
  box.append(el('h2', '', 'Audit trail — every scheduler action, newest first'));
  if (!visible.length) {
    box.append(el('div', 'approval-empty', 'Nothing logged yet. Approvals, denials, draft edits, publishes, and replies all land here.'));
  } else {
    const listEl = el('div', 'auditlist');
    for (const a of visible.slice(0, 200)) {
      const item = el('div', 'audititem');
      item.append(el('span', 'auditkind ' + (a.kind || 'edit'), a.kind || 'edit'));
      item.append(el('span', 'audittext', a.text));
      item.append(el('span', 'auditdate', fmtDateLong(a.created)));
      listEl.append(item);
    }
    box.append(listEl);
  }
  main.append(box);
}

/* ---------- Claude backend (optional) ----------
   When a backend URL is configured, the chat box and Generate button route
   through the Cloudflare Worker → Opus 4.8. Everything falls back to the
   in-browser logic if it's not connected or a call fails. */

const BACKEND_KEY = 'mrs-claude-backend';
/* always-on default: the deployed Worker (URL is not a secret — the API key is
   a Worker secret). A user-saved config overrides it. There is deliberately no
   disconnect path (owner request) — stale {disabled:true} entries from the old
   UI are ignored, so every browser stays connected. */
const DEFAULT_BACKEND_URL = 'https://shiftboard-claude.meadow-family-a291a2ba.workers.dev';
function backendCfg() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(BACKEND_KEY) || 'null'); } catch {}
  if (stored && stored.url) return stored;          // user-saved config wins
  return { url: DEFAULT_BACKEND_URL, token: '', isDefault: true };
}
function backendSet(cfg) {
  if (cfg && cfg.url) localStorage.setItem(BACKEND_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(BACKEND_KEY);        // empty save = back to the default Worker
}
function backendOn() { return Boolean(backendCfg()?.url); }

async function backendCall(path, payload) {
  const cfg = backendCfg();
  if (!cfg?.url) throw new Error('No Claude backend connected.');
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers['x-console-token'] = cfg.token;
  const res = await fetch(cfg.url.replace(/\/+$/, '') + path, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- AI schedule generation ----------
   Placement runs live in the browser: the HiGHS MILP optimizer (further down)
   is the real engine, with the deterministic greedy engine as instant preview
   and fallback. Example request lists are seeded for NMMC-Tupelo
   and DCH-Northport; anything staff submit in the employee app merges in. */

const EXAMPLE_SCHEDULING = {
  TUP: {
    month: '2026-09',
    /* [who, role, monthly target, float pool?] — regulars are Tupelo's own
       providers from the W2W import; floats are real NMMC-network providers */
    pool: [
      ['Cole Young, MD', 'PHY', 14, 0], ['Misty Rea, MD', 'PHY', 13, 0], ['Kirti Patel, MD', 'PHY', 13, 0],
      ['Kristin Mitchell, MD', 'PHY', 12, 0], ['Shayna Thompson, MD', 'PHY', 12, 0], ['Joe Johnsey, MD', 'PHY', 12, 0],
      ['Scotty Reed, MD', 'PHY', 12, 0], ['Lindsie Story, PA-C', 'APC', 13, 0], ['Renee Mitchell, NP', 'APC', 12, 0],
      ['Travis Anderson, MD', 'PHY', 5, 1], ['Yusef Hamid, MD', 'PHY', 5, 1], ['Seth Cappleman, DO', 'PHY', 5, 1],
      ['Adeniyi Koiki, MD', 'PHY', 4, 1], ['Brad Bowlin, MD', 'PHY', 4, 1], ['Mai Huu Ho, MD', 'PHY', 4, 1],
      ['Janice Mitchell, DO', 'PHY', 4, 1], ['Ridge Dabbs, DO', 'PHY', 4, 1], ['Brian McCoy, MD', 'PHY', 4, 1],
      ['Marcus Crittenden, MD', 'PHY', 4, 1],
      ['Josh Strickland, PA-C', 'APC', 5, 1], ['Wesley Estock, PA-C', 'APC', 5, 1], ['Katie McClain, NP', 'APC', 4, 1],
      ['Taylor Brezinka, PA-C', 'APC', 4, 1], ['Rachel Rolison, NP', 'APC', 4, 1], ['Lane Hunt, NP', 'APC', 4, 1],
    ],
    requests: [
      { who: 'Cole Young, MD', off: [1, 2, 3, 4, 5], prefer: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], note: 'Family vacation first week' },
      { who: 'Misty Rea, MD', off: [19, 20], cap: 12, note: 'Wedding weekend' },
      { who: 'Kirti Patel, MD', off: [25, 26, 27, 28, 29, 30], prefer: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], note: 'Conference end of month' },
      { who: 'Kristin Mitchell, MD', off: [6, 13, 20, 27], note: 'No Sundays (childcare)' },
      { who: 'Shayna Thompson, MD', prefer: [5, 6, 12, 13, 19, 20, 26, 27], note: 'Prefers weekends' },
      { who: 'Joe Johnsey, MD', off: [8, 9, 10, 11, 12, 13, 14], note: 'Out of town' },
      { who: 'Lindsie Story, PA-C', prefer: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], cap: 12 },
      { who: 'Renee Mitchell, NP', off: [1, 2, 29, 30] },
      { who: 'Scotty Reed, MD', note: 'Prefers Zone B assignments when possible' },
    ],
  },
  NOR: {
    month: '2026-09',
    pool: [
      ['Alisa Johnson, MD', 'PHY', 12, 0], ['Abigail Halleron, MD', 'PHY', 11, 0], ['Blake Lovely, MD', 'PHY', 10, 0],
      ['Kenneth Akalonu, MD', 'PHY', 9, 0], ['Jimmy Tu, MD', 'PHY', 7, 0], ['Temar Elsayed, MD', 'PHY', 7, 0],
      ['Ifeoma Kamalu, MD', 'PHY', 5, 0], ['Nathan Hadley, MD', 'PHY', 4, 0], ['George Petty, MD', 'PHY', 3, 0],
      ['Kimberly Buck, NP', 'APC', 11, 0], ['Yancy Beard, CRNP', 'APC', 10, 0], ['Brooke Palmer, NP', 'APC', 10, 0],
      ['Kayela Norris, PA', 'APC', 10, 0], ['Amanda Smith, NP', 'APC', 10, 0], ['Emily Stuart, NP', 'APC', 10, 0],
      ['Kelsey Galloway, NP', 'APC', 9, 0], ['Beth Dunn, NP', 'APC', 6, 0], ['Sarah Spencer, NP', 'APC', 4, 0],
      ['Joshua Hood, NP', 'APC', 3, 0], ['Lauren Kyzar, NP', 'APC', 3, 0],
    ],
    requests: [
      { who: 'Blake Lovely, MD', prefer: [1, 2, 3, 4, 14, 15, 16, 17, 26, 27, 28, 29], note: 'Night blocks, as usual' },
      { who: 'Abigail Halleron, MD', off: [10, 11, 12, 13, 14, 15, 16], note: 'Vacation' },
      { who: 'Jimmy Tu, MD', off: [5, 6], cap: 8 },
      { who: 'Alisa Johnson, MD', prefer: [7, 8, 9, 10, 11, 12, 13] },
      { who: 'Kimberly Buck, NP', off: [22, 23, 24, 25] },
      { who: 'Ifeoma Kamalu, MD', cap: 6, note: 'Per diem — light month requested' },
      { who: 'Temar Elsayed, MD', off: [1, 2, 3], prefer: [18, 19, 20, 21, 22, 23, 24] },
      { who: 'Emily Stuart, NP', off: [2, 9, 16, 23, 30], note: 'Clinic day Wednesdays' },
    ],
  },
};

function slotRole(pos) {
  if (/resident|student/i.test(pos)) return 'SKIP';
  if (/apc|\bapp\b|midlevel|\bnp\b|\bpa\b|crnp/i.test(pos)) return 'APC';
  if (/\bdr\b|doctor|physician|\bmd\b|hospitalist|nocturnist/i.test(pos)) return 'PHY';
  return 'ANY';
}

/* time-of-day bucket for a shift: days start before noon, evenings 12:00–17:59,
   nights start 18:00+ or run overnight */
function shiftBucket(s) {
  if (isNight(s)) return 'night';
  return s.start >= '12:00' ? 'eve' : 'day';
}

/* each provider's historical shift-time mix, from every assigned shift in the
   import — a night doc's profile is {night: ~100%} */
function timeProfiles() {
  const map = new Map();
  for (const s of base) {
    if (s.forecast || !s.who) continue;
    if (!map.has(s.who)) map.set(s.who, { total: 0, day: 0, eve: 0, night: 0 });
    const t = map.get(s.who);
    t.total++;
    t[shiftBucket(s)]++;
  }
  return map;
}

function usualShift(prof) {
  if (!prof || prof.total < 4) return '—';
  const fr = b => prof[b] / prof.total;
  const best = ['night', 'eve', 'day'].sort((a, b) => fr(b) - fr(a))[0];
  if (fr(best) < 0.65) return 'mixed';
  return `${{ night: 'nights', eve: 'evenings', day: 'days' }[best]} (${Math.round(fr(best) * 100)}%)`;
}

const expandDays = (mo, nums) => (nums || []).map(n => `${mo}-${String(n).padStart(2, '0')}`);
const moShort = mo => {
  const [y, m] = mo.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
};

function fmtDayRanges(mo, set) {
  const days = [...set].filter(d => d.startsWith(mo)).map(d => Number(d.slice(8))).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    parts.push(i === j ? String(days[i]) : days[i] + '–' + days[j]);
    i = j + 1;
  }
  return parts.join(', ');
}

/* ops recorded by the "talk to the schedule" assistant, scoped to a site */
function genAdjustFor(site) {
  return (overlay.genAdjust || []).filter(a => a.site === site || a.site === '*');
}

function applyPoolAdjust(pool, site) {
  let out = pool.map(p => ({ ...p }));
  for (const a of genAdjustFor(site)) {
    if (a.kind === 'addProvider') {
      if (!out.some(p => p.who === a.who)) out.push({ who: a.who, role: a.role, target: a.target, avg: 0, fromAvg: false, float: false, tod: a.tod || null });
    } else if (a.kind === 'removeProvider') {
      out = out.filter(p => p.who !== a.who);
    } else if (a.kind === 'setTarget') {
      const p = out.find(x => x.who === a.who);
      if (p) { p.target = a.value; p.fromAvg = false; }
    } else if (a.kind === 'setTimeOfDay') {
      const p = out.find(x => x.who === a.who);
      if (p) p.tod = a.tod;
    }
  }
  return out;
}

/* example requests + anything staff submitted in-app + assistant ops, merged per provider */
function requestsFor(site, mo) {
  const map = new Map();
  const ensure = who => {
    if (!map.has(who)) map.set(who, { who, off: new Set(), prefer: new Set(), cap: null, note: '', source: 'submitted' });
    return map.get(who);
  };
  const ex = EXAMPLE_SCHEDULING[site];
  if (ex && ex.month === mo) {
    for (const r of ex.requests) {
      const e = ensure(r.who);
      e.source = 'example';
      for (const d of expandDays(mo, r.off)) e.off.add(d);
      for (const d of expandDays(mo, r.prefer)) e.prefer.add(d);
      if (r.cap) e.cap = r.cap;
      if (r.note) e.note = r.note;
    }
  }
  for (const [name, days] of Object.entries(overlay.prefs || {})) {
    const off = Object.keys(days).filter(iso => iso.startsWith(mo) && days[iso] === 'no');
    const like = Object.keys(days).filter(iso => iso.startsWith(mo) && days[iso] === 'like');
    if (!off.length && !like.length) continue;
    const e = ensure(name);
    for (const iso of off) e.off.add(iso);
    for (const iso of like) e.prefer.add(iso);
  }
  for (const a of genAdjustFor(site)) {
    if (a.kind === 'addOff') {
      const e = ensure(a.who);
      for (const d of a.dates) e.off.add(d);
      if (e.source === 'submitted') e.source = 'assistant';
    } else if (a.kind === 'addPrefer') {
      const e = ensure(a.who);
      for (const d of a.dates) e.prefer.add(d);
      if (e.source === 'submitted') e.source = 'assistant';
    } else if (a.kind === 'setCap') {
      const e = ensure(a.who);
      e.cap = a.value;
      if (e.source === 'submitted') e.source = 'assistant';
    } else if (a.kind === 'setRequest' && a.mo === mo) {
      /* authoritative record from the requests editor — replaces this person's
         off/prefer/cap for the month */
      const e = ensure(a.who);
      e.off = new Set(a.off || []);
      e.prefer = new Set(a.prefer || []);
      e.cap = a.cap || null;
      if (a.note !== undefined) e.note = a.note;
      e.source = 'edited';
    }
  }
  return map;
}

/* drop prior request ops for a person+month so the editor's save is a clean replace */
function clearPersonRequestOps(who, site, mo) {
  overlay.genAdjust = (overlay.genAdjust || []).filter(a => {
    if (a.who !== who || a.site !== site) return true;
    if (a.kind === 'setRequest') return a.mo !== mo;
    if (a.kind === 'setCap') return false;
    if (a.kind === 'addOff' || a.kind === 'addPrefer') return !(a.dates || []).some(d => d.startsWith(mo));
    return true;
  });
}

/* average distinct days/month each provider worked at `site` over the recent
   complete months — the anchor for generation targets */
const HIST_MONTHS = ['2026-06', '2026-07', '2026-08'];
function siteAvgDays(site) {
  const perMonth = new Map();
  for (const s of base) {
    if (s.forecast || !s.who || s.site !== site) continue;
    const mo = s.date.slice(0, 7);
    if (!HIST_MONTHS.includes(mo)) continue;
    if (!perMonth.has(s.who)) perMonth.set(s.who, {});
    const rec = perMonth.get(s.who);
    (rec[mo] = rec[mo] || new Set()).add(s.date);
  }
  const avg = new Map();
  for (const [who, rec] of perMonth) {
    const counts = Object.values(rec).map(set => set.size);   // months they actually worked
    avg.set(who, { avg: counts.reduce((a, b) => a + b, 0) / counts.length, months: counts.length });
  }
  return avg;
}

function poolFor(site, mo) {
  const avg = siteAvgDays(site);
  const ex = EXAMPLE_SCHEDULING[site];
  if (ex && ex.month === mo) {
    return withClaudeTargets(applyPoolAdjust(ex.pool.map(([who, role, seeded, float]) => {
      const h = avg.get(who);
      /* floats keep their small caps; regulars target their own recent average
         when it's a credible signal (2+ months, 4+ days/mo) — otherwise the
         planned roster number stands in for missing/stray W2W history */
      const useAvg = !float && !!h && h.months >= 2 && h.avg >= 4;
      return { who, role, target: useAvg ? Math.round(h.avg) : seeded, avg: h ? h.avg : 0, fromAvg: useAvg, float: !!float };
    }), site), site, mo);
  }
  return withClaudeTargets(applyPoolAdjust([...avg.entries()]
    .filter(([, h]) => h.avg >= 1)
    .map(([who, h]) => ({ who, role: providerRole({ pos: '', who }) || 'ANY', target: Math.max(2, Math.round(h.avg)), avg: h.avg, fromAvg: true, float: false })), site), site, mo);
}

/* ---------- employment tiers (shift-preference hierarchy) ----------
   full-time > part-time > PRN: when two providers are otherwise comparable,
   the higher tier wins the shift. Set manually (provider table / chat) and
   stored globally; unset providers default to full-time, floats to PRN. */
const TIER_LABEL = { ft: 'Full-time', pt: 'Part-time', prn: 'PRN' };
const TIER_BONUS = { ft: 40, pt: 20, prn: 0 };
function tierOf(who, isFloat) {
  const t = (overlay.tiers || {})[who];
  return t === 'ft' || t === 'pt' || t === 'prn' ? t : (isFloat ? 'prn' : 'ft');
}

/* when Opus 4.8 produced per-provider targets for this exact site+month, use them.
   Opus may aim HIGHER than a provider's baseline but never lower — the floor rule
   (nobody below average − 1) hangs off the target, so a lowball target would quietly
   under-schedule people. Explicit request caps still win inside the engine. */
function withClaudeTargets(pool, site, mo) {
  const ct = state.gen.claudeTargets;
  if (!ct || state.gen.claudeKey !== `${site}|${mo}`) return pool;
  return pool.map(p => {
    if (!ct.has(p.who)) return p;
    const raw = ct.get(p.who);
    const target = Math.max(raw, p.target);
    return { ...p, target, fromAvg: false, fromClaude: true, claudeClamped: raw < p.target ? raw : null };
  });
}

/* apply structured ops returned by /api/chat (same effect as handleCommand) */
function applyBackendOps(ops) {
  const g = state.gen;
  let n = 0;
  for (const op of ops || []) {
    const who = op.who || '';
    const first = who.replace(/,.*$/, '');
    const iso = (op.dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (op.kind === 'addProvider' && who) {
      addAdjust('addProvider', { who, role: op.role || 'PHY', target: op.target || 12, tod: op.tod || null }, `${first} added (${op.role || 'PHY'}, ${op.target || 12}/mo${op.tod ? ', ' + op.tod + 's' : ''})`); n++;
    } else if (op.kind === 'removeProvider' && who) {
      addAdjust('removeProvider', { who }, `${first} removed`); n++;
    } else if (op.kind === 'addOff' && who && iso.length) {
      addAdjust('addOff', { who, dates: iso }, `${first} off ${moShort(g.month)} ${fmtDayRanges(g.month, new Set(iso))}`); n++;
    } else if (op.kind === 'addPrefer' && who && iso.length) {
      addAdjust('addPrefer', { who, dates: iso }, `${first} prefers ${moShort(g.month)} ${fmtDayRanges(g.month, new Set(iso))}`); n++;
    } else if (op.kind === 'setCap' && who && op.value) {
      addAdjust('setCap', { who, value: op.value }, `${first} capped at ${op.value}`); n++;
    } else if (op.kind === 'setTarget' && who && op.value) {
      addAdjust('setTarget', { who, value: op.value }, `${first} target ${op.value}/mo`); n++;
    } else if (op.kind === 'setTimeOfDay' && who && op.tod) {
      addAdjust('setTimeOfDay', { who, tod: op.tod }, `${first} → ${op.tod}s only`); n++;
    } else if (op.kind === 'setTier' && who && ['ft', 'pt', 'prn'].includes(op.tier)) {
      overlay.tiers[who] = op.tier;
      audit(`${who} employment tier set to ${TIER_LABEL[op.tier]} (via assistant)`, 'ai'); n++;
    } else if (op.kind === 'maxRun' && op.value) {
      overlay.genAdjust = overlay.genAdjust.filter(a => a.kind !== 'maxRun');
      addAdjust('maxRun', { value: op.value }, `max ${op.value} in a row (all sites)`, '*'); n++;
    } else if (op.kind === 'move' && who && op.toWho && op.date && g.result) {
      const a = g.result.assignments.find(x => x.who === who && x.slot.date === op.date);
      if (a) { const slot = a.slot; removeFromSlot(g.result, slot); addToSlot(g.result, slot, op.toWho); recomputeProposalDerived(g.result); n++; }
    }
  }
  if (n) audit(`Opus 4.8 applied ${n} operation${n === 1 ? '' : 's'} from the chat box`, 'ai');
  return n;
}

function runGeneration(site, mo) {
  const all = adminShifts();
  const openHere = all.filter(s => s.site === site && s.date.startsWith(mo) && !s.who);
  const slots = openHere.filter(s => slotRole(s.pos) !== 'SKIP')
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
  const skipped = openHere.length - slots.length;
  const pool = poolFor(site, mo);
  const reqs = requestsFor(site, mo);
  const profiles = timeProfiles();
  const maxRun = (genAdjustFor(site).slice().reverse().find(a => a.kind === 'maxRun') || {}).value || 5;
  const minedMap = compileMinedRules();
  const stats = new Map(pool.map(p => [p.who, { ...p, assigned: 0, preferGot: 0, dates: new Set(), shiftByDate: new Map(), prof: profiles.get(p.who) || null }]));
  for (const s of all) {
    if (!s.who || !s.date.startsWith(mo)) continue;
    const st = stats.get(s.who);
    if (st) { st.dates.add(s.date); st.shiftByDate.set(s.date, s); }
  }
  for (const st of stats.values()) {
    st.preDates = st.dates.size;
    const m = minedMap.get(st.who);
    if (m && m.loadN != null && m.loadHard) st.minedLoadFloor = m.loadN;
  }
  const assignments = [];
  const unfilled = [];
  const capsHit = new Set();
  for (const slot of slots) {
    const need = slotRole(slot.pos);
    const slotDow = dowOf(slot.date);
    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      if (need !== 'ANY' && p.role !== 'ANY' && p.role !== need) continue;
      const st = stats.get(p.who);
      const r = reqs.get(p.who);
      const mined = minedMap.get(p.who);
      if (r && r.off.has(slot.date)) continue;                                   // hard: unavailable
      let cap = (r && r.cap) || p.target + 1;                                    // hard: never more than 1 over their average/target
      if (mined && mined.loadN != null && mined.loadHard && !(r && r.cap)) cap = Math.max(0, mined.loadN - st.preDates);  // mined: exactly-N months pin the cap
      if (st.assigned >= cap) { if (r && r.cap) capsHit.add(p.who); continue; }
      if (st.dates.has(slot.date)) continue;                                     // hard: one shift/day
      const prevShift = st.shiftByDate.get(addDays(slot.date, -1));              // hard: ≥10h rest between shifts
      if (prevShift && absMin(slot.date, slot.start) - shiftEndMin(prevShift) < MIN_REST_MIN) continue;
      const pMax = (mined && mined.blockMax) || maxRun;                          // mined block rule overrides the global max-run
      let run = 0;
      for (let k = 1; k <= pMax; k++) { if (st.dates.has(addDays(slot.date, -k))) run++; else break; }
      if (run >= pMax) continue;                                                 // hard: max consecutive days (assistant-tunable, default 5)
      const bucket = shiftBucket(slot);
      if (st.tod) { if (bucket !== st.tod) continue; }                           // hard: assistant rule ("nights only")
      else if (st.prof && st.prof.total >= 8 && st.prof[bucket] / st.prof.total <= 0.05) continue;  // hard: never works this time of day
      if (mined && minedBlocks(mined, slot, slotDow)) continue;                  // hard: mined-from-history rules
      let score = 0;
      if (mined) score += minedScore(mined, slot, slotDow);                      // soft: mined-from-history rules
      if (!st.tod && st.prof && st.prof.total >= 4) score += Math.round((st.prof[bucket] / st.prof.total - 0.33) * 60);  // time-of-day affinity
      /* floor rule: nobody ends the month below their average minus one — a
         provider still under floor outbids every other consideration.
         PRN is exempt: "as needed" carries no guaranteed load.
         Exactly-N providers' floor IS their N. */
      let floor = tierOf(p.who, p.float) === 'prn' ? 0 : Math.max(0, Math.min(p.target - 1, (r && r.cap) || Infinity));
      if (st.minedLoadFloor != null && !(r && r.cap)) floor = st.minedLoadFloor;
      if (st.dates.size < floor) score += 400 + (floor - st.dates.size) * 10;
      if (r && r.prefer.has(slot.date)) score += 100;                            // honor preferences
      if (st.dates.has(addDays(slot.date, -1))) score += Math.round(45 * (mined ? mined.blockMult : 1));  // build blocks (mined style scales it)
      score += TIER_BONUS[tierOf(p.who, p.float)];                               // hierarchy: full-time > part-time > PRN
      score -= (st.assigned / Math.max(1, p.target)) * 70;                       // balance load
      if (score > bestScore) { best = p; bestScore = score; }
    }
    if (!best) { unfilled.push(slot); continue; }
    const st = stats.get(best.who);
    const r = reqs.get(best.who);
    const preferred = !!(r && r.prefer.has(slot.date));
    assignments.push({ slot, who: best.who, preferred });
    st.assigned++;
    if (preferred) st.preferGot++;
    st.dates.add(slot.date);
    st.shiftByDate.set(slot.date, slot);
  }
  return finishGenResult({ site, mo, slots, skipped, assignments, unfilled, stats, reqs, capsHit, maxRun, engine: 'greedy' });
}

/* shared tail for both engines: per-provider run/floor stats + summary counts */
function finishGenResult({ site, mo, slots, skipped, assignments, unfilled, stats, reqs, capsHit, maxRun, engine, solver }) {
  for (const st of stats.values()) {
    let bestRun = 0;
    for (const d of st.dates) {
      if (st.dates.has(addDays(d, -1))) continue;
      let len = 1;
      while (st.dates.has(addDays(d, len))) len++;
      bestRun = Math.max(bestRun, len);
    }
    st.longestRun = bestRun;
    const r = reqs.get(st.who);
    st.floor = tierOf(st.who, st.float) === 'prn' ? 0 : Math.max(0, Math.min(st.target - 1, (r && r.cap) || Infinity));
    if (st.minedLoadFloor != null && !(r && r.cap)) st.floor = st.minedLoadFloor;
    st.underFloor = st.dates.size < st.floor;
  }
  const underFloor = [...stats.values()].filter(st => st.underFloor).map(st => st.who);
  const offDays = [...reqs.values()].reduce((a, r) => a + r.off.size, 0);
  const preferTotal = [...reqs.values()].reduce((a, r) => a + r.prefer.size, 0);
  const preferGot = [...stats.values()].reduce((a, s) => a + s.preferGot, 0);
  return { site, mo, slots: slots.length, skipped, assignments, unfilled, stats, reqs, offDays, preferTotal, preferGot, capsHit: [...capsHit], maxRun, underFloor, engine, solver: solver || null };
}

/* ---------- MILP placement engine (HiGHS, in-browser WebAssembly) ----------
   The greedy engine above fills slot-by-slot in date order; this one hands the
   whole month to a real mixed-integer optimizer (HiGHS via highs-js, the same
   solver class commercial rostering tools use). Identical hard rules — role,
   days off, one shift/day, ≥10h rest, max-run, time-of-day — but coverage,
   floors, preferences, tier hierarchy, and block scheduling are traded off
   globally instead of slot-at-a-time. The greedy engine remains the instant
   preview and the fallback when the WASM solver can't load. */

const SOLVER_TIME_LIMIT_S = 20;

let highsLoad = null;
function loadHighs() {
  if (highsLoad) return highsLoad;
  highsLoad = new Promise((resolve, reject) => {
    const boot = () => Module({ locateFile: f => 'vendor/' + f }).then(resolve, reject);
    if (typeof Module === 'function') { boot(); return; }
    const tag = document.createElement('script');
    tag.src = 'vendor/highs.js';
    tag.onload = boot;
    tag.onerror = () => reject(new Error('could not load vendor/highs.js'));
    document.head.append(tag);
  });
  highsLoad.catch(() => { highsLoad = null; });   // a failed load stays retryable
  return highsLoad;
}

async function runGenerationSolver(site, mo, opts = {}) {
  const t0 = performance.now();
  const highs = await loadHighs();

  /* identical inputs to the greedy engine — or explicit overrides (backtest) */
  const all = adminShifts();
  let slots, skipped;
  if (opts.slots) {
    slots = opts.slots.slice().sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    skipped = 0;
  } else {
    const openHere = all.filter(s => s.site === site && s.date.startsWith(mo) && !s.who);
    slots = openHere.filter(s => slotRole(s.pos) !== 'SKIP')
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    skipped = openHere.length - slots.length;
  }
  const pool = opts.pool || poolFor(site, mo);
  const reqs = opts.reqs || requestsFor(site, mo);
  const profiles = opts.profiles || timeProfiles();
  const maxRun = opts.maxRun || (genAdjustFor(site).slice().reverse().find(a => a.kind === 'maxRun') || {}).value || 5;
  const minedMap = opts.minedMap || compileMinedRules();
  const stats = new Map(pool.map(p => [p.who, { ...p, assigned: 0, preferGot: 0, dates: new Set(), shiftByDate: new Map(), prof: profiles.get(p.who) || null }]));
  for (const s of (opts.monthShifts || all)) {
    if (!s.who || !s.date.startsWith(mo)) continue;
    const st = stats.get(s.who);
    if (st) { st.dates.add(s.date); st.shiftByDate.set(s.date, s); }
  }
  const daysIn = new Date(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 0).getDate();
  /* rotation-phase anchoring: worked days just OUTSIDE the month feed the rest,
     max-run, and block-adjacency logic (a 7-on block ending the 31st should
     continue, not restart) — but never the month's load/floor counts */
  const mStart = mo + '-01';
  const mEnd = `${mo}-${String(daysIn).padStart(2, '0')}`;
  const loEdge = addDays(mStart, -6), hiEdge = addDays(mEnd, 6);
  for (const s of (opts.edgeShifts || all)) {
    if (!s.who || s.date.startsWith(mo) || s.date < loEdge || s.date > hiEdge) continue;
    const st = stats.get(s.who);
    if (st && !st.shiftByDate.has(s.date)) st.shiftByDate.set(s.date, s);
  }
  const dayNumOf = iso => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8)) - Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7) - 1, 1)) / 86400000) + 1;

  /* decision variables: x{provider}_{slot} for every legal pairing, with the
     greedy engine's scoring terms as the per-assignment reward */
  const cols = [];
  const byProv = new Map();
  pool.forEach((p, pi) => {
    const st = stats.get(p.who);
    const r = reqs.get(p.who) || null;
    let cap = (r && r.cap) || p.target + 1;
    if (opts.capAdjust && opts.capAdjust.has(p.who)) cap = Math.max(0, cap - opts.capAdjust.get(p.who));   // refill: kept shifts already spent it
    let floor = tierOf(p.who, p.float) === 'prn' ? 0 : Math.max(0, Math.min(p.target - 1, (r && r.cap) || Infinity));
    let overAt = p.target, overW = 40;
    const m = minedMap.get(p.who);
    if (m && m.loadN != null && !(r && r.cap)) {   // an explicit request cap outranks the mined load rule
      if (m.loadHard) {
        cap = Math.max(0, m.loadN - st.dates.size);   // total days pinned at N (cap counts NEW assignments)
        floor = m.loadN;
        st.minedLoadFloor = m.loadN;
      } else {
        floor = Math.max(floor, m.loadN - 1);
        overAt = m.loadN;
        overW = 80;   // steady-N providers: leaving N costs real points, but genuine variation can still win
      }
    }
    byProv.set(p.who, { p, pi, st, r, cap, floor, overAt, overW, byDay: new Map(), names: [] });
  });
  slots.forEach((slot, si) => {
    const need = slotRole(slot.pos);
    const day = +slot.date.slice(8);
    const dow = dowOf(slot.date);
    const bucket = shiftBucket(slot);
    for (const pr of byProv.values()) {
      const { p, pi, st, r } = pr;
      if (need !== 'ANY' && p.role !== 'ANY' && p.role !== need) continue;
      if (r && r.off.has(slot.date)) continue;                                 // hard: unavailable
      if (opts.excluded && opts.excluded.has(p.who + '|' + slotKey(slot))) continue;   // hard: removed from this exact slot
      if (st.dates.has(slot.date)) continue;                                   // hard: already working that day (any site)
      const prev = st.shiftByDate.get(addDays(slot.date, -1));                 // hard: ≥10h rest vs pre-existing shifts, both directions
      if (prev && absMin(slot.date, slot.start) - shiftEndMin(prev) < MIN_REST_MIN) continue;
      const next = st.shiftByDate.get(addDays(slot.date, 1));
      if (next && absMin(next.date, next.start) - shiftEndMin(slot) < MIN_REST_MIN) continue;
      if (st.tod) { if (bucket !== st.tod) continue; }                         // hard: "nights only" rule
      else if (st.prof && st.prof.total >= 8 && st.prof[bucket] / st.prof.total <= 0.05) continue;  // hard: never works this time of day
      const mined = minedMap.get(p.who);
      if (mined && minedBlocks(mined, slot, dow)) continue;                    // hard: mined-from-history rules
      let reward = 1000 + TIER_BONUS[tierOf(p.who, p.float)];                  // fill first, tier breaks ties
      if (!st.tod && st.prof && st.prof.total >= 4) reward += Math.round((st.prof[bucket] / st.prof.total - 0.33) * 60);
      if (r && r.prefer.has(slot.date)) reward += 100;
      if (mined) reward += minedScore(mined, slot, dow);                       // soft: mined-from-history rules
      const name = `x${pi}_${si}`;
      cols.push({ name, who: p.who, si, slot, reward });
      pr.names.push(name);
      if (!pr.byDay.has(day)) pr.byDay.set(day, []);
      pr.byDay.get(day).push({ name, slot });
    }
  });

  if (!cols.length) {
    return finishGenResult({ site, mo, slots, skipped, assignments: [], unfilled: slots.slice(), stats, reqs, capsHit: new Set(), maxRun, engine: 'milp', solver: { vars: 0, rows: 0, ms: performance.now() - t0, status: 'Empty' } });
  }

  const obj = cols.map(c => `${c.reward} ${c.name}`);
  const cons = [];
  const bins = cols.map(c => c.name);
  let cn = 0;
  const addCon = expr => { cons.push(` c${++cn}: ${expr}`); };

  /* every slot gets at most one provider */
  const bySlot = new Map();
  for (const c of cols) {
    if (!bySlot.has(c.si)) bySlot.set(c.si, []);
    bySlot.get(c.si).push(c.name);
  }
  for (const names of bySlot.values()) addCon(`${names.join(' + ')} <= 1`);

  for (const pr of byProv.values()) {
    if (!pr.names.length) continue;
    const { pi, st, r, p } = pr;

    /* one shift per day, linked through a worked-day indicator w */
    const wByDay = new Map();
    for (const [day, items] of pr.byDay) {
      const w = `w${pi}_${day}`;
      addCon(`${items.map(i => i.name).join(' + ')} - ${w} = 0`);
      bins.push(w);
      wByDay.set(day, w);
    }

    /* never more than 1 over target (or the explicit request cap) */
    addCon(`${pr.names.join(' + ')} <= ${pr.cap}`);

    /* ≥10h rest between proposed shifts on adjacent days: since at most one
       shift is worked per day, one row per next-day slot covers all conflicts */
    for (const [day, items] of pr.byDay) {
      const nextItems = pr.byDay.get(day + 1);
      if (!nextItems) continue;
      for (const b of nextItems) {
        const conflicts = items.filter(a => absMin(b.slot.date, b.slot.start) - shiftEndMin(a.slot) < MIN_REST_MIN);
        if (conflicts.length) addCon(`${conflicts.map(c => c.name).join(' + ')} + ${b.name} <= 1`);
      }
    }

    /* max consecutive days, counting pre-existing shifts in the month AND the
       anchored edge days just outside it (runs must not restart at the seam).
       A hard mined block rule overrides the global max-run for this provider —
       a 7-on hospitalist gets real 7-day stretches even with a global max of 5. */
    const mm = minedMap.get(p.who);
    const pMax = (mm && mm.blockMax) || maxRun;
    const preDay = new Set([...st.dates].map(d => +d.slice(8)));
    for (const d of st.shiftByDate.keys()) if (!d.startsWith(mo)) preDay.add(dayNumOf(d));
    for (let i = 1 - pMax; i <= daysIn; i++) {
      const terms = [];
      let constC = 0;
      for (let d = i; d <= i + pMax; d++) {
        if (wByDay.has(d)) terms.push(wByDay.get(d));
        else if (preDay.has(d)) constC++;
      }
      if (terms.length && terms.length + constC > pMax) addCon(`${terms.join(' + ')} <= ${Math.max(0, pMax - constC)}`);
    }

    /* mined block structure: blocks run at least blockMin days — a block start
       (worked day d but not d−1) forces the next blockMin−1 days. Relaxed when
       a continuation day has no eligible slot or falls past the month end, so
       structure can never cost coverage outright. */
    if (mm && mm.blockMin >= 2) {
      for (const [day, w] of wByDay) {
        if (preDay.has(day - 1)) continue;                    // continues an anchored block — not a start
        const left = wByDay.get(day - 1) || null;             // absent → day-1 unworkable → working day IS a start
        for (let k = 1; k < mm.blockMin; k++) {
          const t = day + k;
          if (preDay.has(t)) continue;                        // that day is already worked — satisfied
          const wt = wByDay.get(t);
          if (!wt) break;                                     // can't force beyond eligibility/month — relax
          addCon(left ? `${wt} - ${w} + ${left} >= 0` : `${wt} - ${w} >= 0`);
        }
      }
    }

    const wNames = [...wByDay.values()];

    /* floor: nobody below their average − 1 (soft, but priced above everything
       except leaving a slot empty — same dominance the greedy +400 bonus had) */
    const need = pr.floor - st.dates.size;
    if (need > 0 && wNames.length) {
      addCon(`${wNames.join(' + ')} + u${pi} >= ${need}`);
      obj.push(`- 450 u${pi}`);
    }

    /* soft load-balance: days beyond target cost a little, so extras spread out
       (steady-N providers get a much steeper pull back to their N) */
    const room = pr.overAt - st.dates.size;
    if (wNames.length > room) {
      addCon(`${wNames.join(' + ')} - o${pi} <= ${room}`);
      obj.push(`- ${pr.overW} o${pi}`);
    }

    /* block scheduling: reward back-to-back worked days (greedy's +45),
       scaled by the provider's mined block style (7-on folks get double,
       scattered-singles folks nearly none) */
    const blockW = Math.round(45 * (mm ? mm.blockMult : 1));
    if (blockW > 0) {
      for (const [day, w] of wByDay) {
        const left = wByDay.get(day - 1) || (preDay.has(day - 1) ? true : null);
        if (!left) continue;
        const a = `a${pi}_${day}`;
        addCon(`${a} - ${w} <= 0`);
        if (left !== true) addCon(`${a} - ${left} <= 0`);
        obj.push(`+ ${blockW} ${a}`);
      }
    }
  }

  const lp = `Maximize\n obj: ${obj.join('\n   + ').replace(/\+ -/g, '- ')}\nSubject To\n${cons.join('\n')}\nBinary\n ${bins.join('\n ')}\nEnd\n`;

  await new Promise(r => setTimeout(r, 30));   // let the status line paint before the sync solve
  /* stop within 0.5% of provably optimal — the last fraction of a percent is
     pure proof time, not schedule quality */
  const sol = highs.solve(lp, { time_limit: opts.timeLimit || SOLVER_TIME_LIMIT_S, mip_rel_gap: 0.005 });
  const okStatus = ['Optimal', 'Time limit reached', 'Bound on objective reached', 'Target for objective reached'];
  if (!okStatus.includes(sol.Status)) throw new Error(`HiGHS status: ${sol.Status}`);

  /* decode the solution back into the proposal shape both UIs already consume */
  const assignments = [];
  const covered = new Set();
  const capsHit = new Set();
  for (const c of cols.sort((a, b) => a.si - b.si)) {
    const v = sol.Columns[c.name];
    if (!v || v.Primal < 0.5) continue;
    const st = stats.get(c.who);
    const r = reqs.get(c.who);
    const preferred = !!(r && r.prefer.has(c.slot.date));
    assignments.push({ slot: c.slot, who: c.who, preferred });
    covered.add(c.si);
    st.assigned++;
    if (preferred) st.preferGot++;
    st.dates.add(c.slot.date);
    st.shiftByDate.set(c.slot.date, c.slot);
  }
  for (const pr of byProv.values()) {
    if (pr.r && pr.r.cap && pr.st.assigned >= pr.r.cap) capsHit.add(pr.p.who);
  }
  const unfilled = slots.filter((s, si) => !covered.has(si));
  return finishGenResult({
    site, mo, slots, skipped, assignments, unfilled, stats, reqs, capsHit, maxRun,
    engine: 'milp',
    solver: { vars: bins.length, rows: cn, ms: performance.now() - t0, status: sol.Status },
  });
}

/* solver first, greedy as the safety net */
async function runGenerationBest(site, mo) {
  try {
    return await runGenerationSolver(site, mo);
  } catch (err) {
    audit(`Optimizer unavailable (${String(err.message || err)}) — used the greedy engine`, 'ai');
    return runGeneration(site, mo);
  }
}

/* for synchronous call sites (dialogs, chat parser, undo chips): show the
   greedy result instantly, then swap in the optimized one when it lands —
   unless the user moved on (different site/month, cleared, or already applied) */
let rebuildSeq = 0;
function rebuildProposal(site, mo) {
  const g = state.gen;
  g.result = runGeneration(site, mo);
  g.applied = false;
  const seq = ++rebuildSeq;
  runGenerationSolver(site, mo).then(res => {
    if (seq !== rebuildSeq || g.site !== site || g.month !== mo || !g.result || g.applied) return;
    g.result = res;
    render();
  }).catch(() => {});   // greedy preview already on screen
}

/* ---------- proposal repair: clear a provider, refill only the opens ----------
   The "badly placed provider" workflow: strip someone's proposed shifts (slots
   reopen) and re-run the optimizer over ONLY the open slots, with every kept
   assignment locked as fixed context — rest, runs, floors, and caps all still
   hold across the kept + new combination, but nobody else moves. */

function clearProviderFromProposal(res, who) {
  const mine = res.assignments.filter(a => a.who === who);
  if (!mine.length) return 0;
  const st = res.stats.get(who);
  for (const a of mine) {
    if (st) { st.assigned--; st.dates.delete(a.slot.date); st.shiftByDate?.delete(a.slot.date); if (a.preferred) st.preferGot--; }
    res.unfilled.push(a.slot);
  }
  res.assignments = res.assignments.filter(a => a.who !== who);
  (res.clearedWho = res.clearedWho || new Set()).add(who);   // benched: Refill won't hand the opens back to them
  recomputeProposalDerived(res);
  audit(`Proposal edit: cleared ${who} — ${mine.length} slot${mine.length === 1 ? '' : 's'} reopened (excluded from refill until a full regenerate)`, 'ai');
  return mine.length;
}

async function refillOpenSlots() {
  const g = state.gen;
  const res = g.result;
  if (!res || g.refilling || !res.unfilled.length) return;
  g.refilling = true;
  render();
  try {
    const keptByWho = new Map();
    for (const a of res.assignments) keptByWho.set(a.who, (keptByWho.get(a.who) || 0) + 1);
    const fixed = res.assignments.map(a => ({ ...a.slot, who: a.who }));
    const partial = await runGenerationSolver(g.site, g.month, {
      slots: res.unfilled.slice(),
      pool: poolFor(g.site, g.month).filter(p => !(res.clearedWho && res.clearedWho.has(p.who))),   // benched providers sit out
      monthShifts: [...adminShifts().filter(s => s.who && s.date.startsWith(g.month)), ...fixed],
      capAdjust: keptByWho,   // kept proposal shifts consume the cap — refill can't double-load anyone
      excluded: res.excluded, // removed-from-slot providers never get that slot back
    });
    const merged = {
      ...partial,
      slots: res.slots,
      skipped: res.skipped,
      assignments: [...res.assignments, ...partial.assignments].sort((a, b) =>
        a.slot.date.localeCompare(b.slot.date) || a.slot.start.localeCompare(b.slot.start) || a.slot.pos.localeCompare(b.slot.pos)),
      clearedWho: res.clearedWho,
      excluded: res.excluded,
    };
    for (const a of res.assignments) {   // fold kept assignments back into the per-provider table
      const st = merged.stats.get(a.who);
      if (st) { st.assigned++; if (a.preferred) st.preferGot++; }
    }
    merged.preferGot = [...merged.stats.values()].reduce((x, s) => x + (s.preferGot || 0), 0);
    g.result = merged;
    g.applied = false;
    audit(`Refilled open slots: ${partial.assignments.length} of ${res.unfilled.length} filled by the optimizer, ${res.assignments.length} kept assignments untouched`, 'ai');
  } catch (err) {
    audit(`Refill failed (${String(err.message || err)}) — proposal unchanged`, 'ai');
  }
  g.refilling = false;
  saveOverlay();
  render();
}

/* ---------- Analyze: mine the real 6-month schedules into rules ----------
   Deterministic pattern mining over every human-made assignment (no AI in the
   loop): weekday shape, weekend rhythm, block style, and position loyalty per
   provider, each with support (observations) and confidence. Near-certain
   patterns become HARD rules (eligibility filters); consistent-but-not-total
   ones become SOFT rules (objective coefficients). The scheduler can cycle any
   chip hard → soft → off — history encodes real constraints AND accidents, so
   the human gets the last word. Everything feeds the same MILP. */

function dowOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function mineHistory(excludeMo) {
  const days = new Map();       // who -> Set(date)
  const posCount = new Map();   // who -> Map(pos -> shifts)
  let minD = null, maxD = null;
  for (const s of base) {
    if (s.forecast || !s.who || slotRole(s.pos) === 'SKIP') continue;
    if (excludeMo && s.date.startsWith(excludeMo)) continue;
    if (!minD || s.date < minD) minD = s.date;
    if (!maxD || s.date > maxD) maxD = s.date;
    if (!days.has(s.who)) { days.set(s.who, new Set()); posCount.set(s.who, new Map()); }
    days.get(s.who).add(s.date);
    const pc = posCount.get(s.who);
    pc.set(s.pos, (pc.get(s.pos) || 0) + 1);
  }
  const rules = {};
  for (const [who, dset] of days) {
    const n = dset.size;
    if (n < 8) continue;   // too little history to say anything
    const list = [...dset].sort();
    const dow = [0, 0, 0, 0, 0, 0, 0];
    let wk = 0;
    for (const d of list) { const w = dowOf(d); dow[w]++; if (w === 0 || w === 6) wk++; }
    const out = [];
    const first = who.replace(/,.*$/, '');
    /* hard: weekdays they have NEVER worked (needs real support) */
    const neverDays = [];
    if (n >= 20) for (let d = 0; d < 7; d++) if (dow[d] === 0) neverDays.push(d);
    const wkNever = neverDays.includes(0) && neverDays.includes(6);
    const weekdayNever = neverDays.filter(d => d !== 0 && d !== 6);
    if (wkNever) out.push({ kind: 'weekendNever', mode: 'hard', conf: 1, support: n, text: `${first}: never works weekends (0 of ${n} days)` });
    if (weekdayNever.length && weekdayNever.length <= 3) out.push({ kind: 'dowNever', days: weekdayNever, mode: 'hard', conf: 1, support: n, text: `${first}: never works ${weekdayNever.map(d => DOW_NAMES[d]).join('/')} (0 of ${n} days)` });
    /* soft: weekend appetite (when not already hard-never) */
    const share = wk / n;
    if (!wkNever) {
      if (share < 0.10 && n >= 15) out.push({ kind: 'weekendBias', dir: -30, mode: 'soft', conf: Math.min(1, 1 - share / 0.29), support: n, text: `${first}: avoids weekends (${Math.round(share * 100)}% of days)` });
      else if (share > 0.40) out.push({ kind: 'weekendBias', dir: 30, mode: 'soft', conf: Math.min(1, share / 0.55), support: n, text: `${first}: weekend-heavy (${Math.round(share * 100)}% of days)` });
    }
    /* soft: weekday shape, when meaningfully non-uniform */
    const shares = dow.map(c => c / n);
    const active = shares.filter((_, i) => !neverDays.includes(i));
    const mx = Math.max(...shares) * 7;
    const mn = (active.length ? Math.min(...active) : 0) * 7;
    if (n >= 15 && (mx > 1.7 || mn < 0.45)) {
      const top = shares.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => DOW_NAMES[x[1]]);
      out.push({ kind: 'dowPattern', share: shares, mode: 'soft', conf: Math.min(1, (mx - 1) / 1.5), support: n, text: `${first}: weekdays skew ${top.join('/')}` });
    }
    /* consecutive-day runs — dropping any run truncated by the data window or
       an excluded month (a sliced block fakes a short one; Blake's "1-day
       block" was really a February block cut at the March 1 boundary) */
    const runObjs = [];
    let runStart = list[0], runLen = 1;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i] === addDays(list[i - 1], 1)) { runLen++; continue; }
      runObjs.push({ first: runStart, last: list[i - 1], len: runLen });
      if (i < list.length) { runStart = list[i]; runLen = 1; }
    }
    const seam = d => d < minD || d > maxD || (excludeMo && d.startsWith(excludeMo));
    const runs = runObjs.filter(o => !seam(addDays(o.first, -1)) && !seam(addDays(o.last, 1))).map(o => o.len);
    /* block STRUCTURE: a tight band of block lengths (e.g. always 3–4 days) is
       a shape rule the optimizer can enforce — and combined with an exact
       monthly load it pins the whole composition (10 in 3–4s ⇒ 3+3+4).
       10% trimmed per tail so a one-off swap pickup can't widen the band. */
    let blockRule = null;
    if (runs.length >= 6) {
      const sr = runs.slice().sort((a, b) => a - b);
      const lo = sr[Math.floor(sr.length * 0.1)];
      const hi = sr[Math.min(sr.length - 1, Math.ceil(sr.length * 0.9) - 1)];
      const within = runs.filter(r2 => r2 >= lo && r2 <= hi).length / runs.length;
      if (lo >= 2 && hi <= 10 && hi - lo <= 3) {
        blockRule = { kind: 'blockLen', min: lo, max: hi, mode: within >= 0.92 ? 'hard' : 'soft', conf: within, support: runs.length, text: `${first}: works in blocks of ${lo === hi ? lo : lo + '–' + hi} days (${runs.length} blocks)` };
        out.push(blockRule);
      }
    }
    if (!blockRule && runs.length) {
      const meanRun = runs.reduce((a, b) => a + b, 0) / runs.length;
      const modeRun = [...runs.reduce((m, r) => m.set(r, (m.get(r) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
      if (modeRun >= 5) out.push({ kind: 'blockStyle', mult: 2, mode: 'soft', conf: Math.min(1, meanRun / 7), support: runs.length, text: `${first}: long stretches (typical block ${modeRun}, avg ${meanRun.toFixed(1)})` });
      else if (meanRun < 1.5 && runs.length >= 6) out.push({ kind: 'blockStyle', mult: 0.3, mode: 'soft', conf: Math.min(1, 1 - meanRun / 3), support: runs.length, text: `${first}: mostly single days (avg block ${meanRun.toFixed(1)})` });
    }
    /* load consistency: someone who works the same number of days every single
       complete month is telling you their contract, not a coincidence — pin it.
       (hard = cap at N and floor raised to N; near-constant = soft pull to N) */
    const byMo = new Map();
    for (const d of list) { const m = d.slice(0, 7); byMo.set(m, (byMo.get(m) || 0) + 1); }
    const allComplete = [];
    for (let m = minD.slice(0, 7); m <= maxD.slice(0, 7); ) {
      const [y2, mm] = m.split('-').map(Number);
      const lastDay = `${m}-${String(new Date(y2, mm, 0).getDate()).padStart(2, '0')}`;
      if (minD <= m + '-01' && maxD >= lastDay && (!excludeMo || m !== excludeMo)) allComplete.push(m);
      m = `${mm === 12 ? y2 + 1 : y2}-${String((mm % 12) + 1).padStart(2, '0')}`;
    }
    if (allComplete.length >= 4) {
      const counts = allComplete.map(m => byMo.get(m) || 0);
      const mx2 = Math.max(...counts), mn2 = Math.min(...counts);
      if (mn2 >= 1) {   // worked every complete month — a real monthly rhythm
        if (mx2 === mn2) {
          /* hard pinning takes 5+ invariant months — at 4 the backtest proved
             invariance is often coincidence (5 of 15 pins were wrong blind) */
          const hard = allComplete.length >= 5;
          out.push({ kind: 'loadExact', n: mx2, mode: hard ? 'hard' : 'soft', conf: hard ? 1 : 0.8, support: allComplete.length, text: `${first}: exactly ${mx2} days every month (${allComplete.length} of ${allComplete.length} months)` });
        } else if (mx2 - mn2 <= 2) {
          const med = counts.slice().sort((a, b) => a - b)[counts.length >> 1];
          out.push({ kind: 'loadTight', n: med, mode: 'soft', conf: 1 - (mx2 - mn2) / 4, support: allComplete.length, text: `${first}: steady ${med}±1 days/month (range ${mn2}–${mx2})` });
        }
      }
    }
    /* position loyalty — SOFT by default even at 100%: coverage outranks zone
       loyalty (hard zone-locks cratered fill at multi-zone sites), and the
       scheduler can promote any chip to HARD when it's a true credential line */
    const pc = [...posCount.get(who).entries()].sort((a, b) => b[1] - a[1]);
    const totalP = pc.reduce((a, b) => a + b[1], 0);
    if (pc.length && totalP >= 15) {
      const [topPos, cnt] = pc[0];
      const f = cnt / totalP;
      if (f >= 0.92) out.push({ kind: 'posOnly', pos: topPos, mode: 'soft', conf: f, support: totalP, text: `${first}: only works “${topPos}” (${Math.round(f * 100)}% of ${totalP} shifts)` });
      else if (f >= 0.6) out.push({ kind: 'posPrefer', pos: topPos, mode: 'soft', conf: f, support: totalP, text: `${first}: mainly “${topPos}” (${Math.round(f * 100)}%)` });
    }
    if (out.length) rules[who] = out;
  }
  return { window: [minD, maxD], rules };
}

function ruleKey(who, r) { return who + '|' + r.kind + '|' + (r.pos || (r.days || []).join(',')); }

/* carry the scheduler's hard/soft/off choices from one ruleset onto another */
function carryRuleModes(from, onto) {
  if (!from || !from.rules) return onto;
  const modes = new Map();
  for (const [who, rs] of Object.entries(from.rules)) for (const r of rs) modes.set(ruleKey(who, r), r.mode);
  for (const [who, rs] of Object.entries(onto.rules)) for (const r of rs) { const k = ruleKey(who, r); if (modes.has(k)) r.mode = modes.get(k); }
  return onto;
}

function runAnalyze() {
  const mined = carryRuleModes(overlay.analyze, mineHistory());
  overlay.analyze = { generatedAt: TODAY, ...mined, narration: null };
  const total = Object.values(mined.rules).reduce((a, b) => a + b.length, 0);
  audit(`Analyzed ${mined.window[0]} → ${mined.window[1]}: mined ${total} rules for ${Object.keys(mined.rules).length} providers`, 'ai');
  saveOverlay();
}

/* flatten active rules into a fast per-provider lookup for the engines */
function compileMinedRules(an = overlay.analyze) {
  const map = new Map();
  if (!an || !an.rules) return map;
  for (const [who, rs] of Object.entries(an.rules)) {
    const c = { dowNever: new Set(), dowAvoid: new Set(), weekendNever: false, weekendBias: 0, dowShare: null, blockMult: 1, posOnly: null, posPrefer: null, loadN: null, loadHard: false, blockMin: 0, blockMax: null };
    let any = false;
    for (const r of rs) {
      if (r.mode === 'off') continue;
      any = true;
      const hard = r.mode === 'hard';
      if (r.kind === 'dowNever') r.days.forEach(d => (hard ? c.dowNever : c.dowAvoid).add(d));
      else if (r.kind === 'weekendNever') { if (hard) c.weekendNever = true; else c.weekendBias = -35; }
      else if (r.kind === 'weekendBias') c.weekendBias = r.dir;
      else if (r.kind === 'dowPattern') c.dowShare = r.share;
      else if (r.kind === 'blockStyle') c.blockMult = r.mult;
      else if (r.kind === 'blockLen') {
        if (hard) { c.blockMin = r.min; c.blockMax = r.max; }   // hard: overrides the global max-run for this provider, both directions
        else c.blockMult = Math.max(c.blockMult, 1.5);
      }
      else if (r.kind === 'posOnly') { if (hard) c.posOnly = r.pos; else c.posPrefer = r.pos; }
      else if (r.kind === 'posPrefer') c.posPrefer = r.pos;
      else if (r.kind === 'loadExact') { c.loadN = r.n; c.loadHard = hard; }
      else if (r.kind === 'loadTight') { c.loadN = r.n; c.loadHard = false; }
    }
    if (any) map.set(who, c);
  }
  return map;
}

/* per-assignment score delta from soft mined rules — shared by both engines */
function minedScore(m, slot, dow) {
  let s = 0;
  if (m.dowAvoid.has(dow)) s -= 35;
  if (m.weekendBias && (dow === 0 || dow === 6)) s += m.weekendBias;
  if (m.dowShare) s += Math.max(-35, Math.min(35, Math.round((m.dowShare[dow] * 7 - 1) * 25)));
  if (m.posPrefer && slot.pos === m.posPrefer) s += 40;
  return s;
}

/* hard mined rules → not eligible for this slot */
function minedBlocks(m, slot, dow) {
  if (m.dowNever.has(dow)) return true;
  if (m.weekendNever && (dow === 0 || dow === 6)) return true;
  if (m.posOnly && slot.pos !== m.posOnly) return true;
  return false;
}

/* ---------- backtest: regenerate a real month blind and compare ---------- */

function realMonths() {
  const set = new Set();
  for (const s of base) if (!s.forecast) set.add(s.date.slice(0, 7));
  return [...set].sort();
}

async function runBacktest(site, mo) {
  const g = state.gen;
  g.backtest = { running: true, site, mo };
  render();
  try {
    const real = base.filter(s => !s.forecast && s.who && s.site === site && s.date.startsWith(mo) && slotRole(s.pos) !== 'SKIP');
    if (real.length < 30) throw new Error(`only ${real.length} real assigned shifts at ${siteName(site)} in ${mo} — pick a bigger site/month`);
    const slots = real.map(s => ({ ...s, who: '' }));
    /* roster + targets learned ONLY from the other months (no peeking) */
    const perWho = new Map();
    for (const s of base) {
      if (s.forecast || !s.who || s.site !== site || s.date.startsWith(mo) || slotRole(s.pos) === 'SKIP') continue;
      if (!perWho.has(s.who)) perWho.set(s.who, { months: new Map(), role: new Map() });
      const r = perWho.get(s.who);
      const m = s.date.slice(0, 7);
      if (!r.months.has(m)) r.months.set(m, new Set());
      r.months.get(m).add(s.date);
      const ro = slotRole(s.pos);
      r.role.set(ro, (r.role.get(ro) || 0) + 1);
    }
    const pool = [];
    for (const [who, r] of perWho) {
      const counts = [...r.months.values()].map(x => x.size);
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      if (avg < 2) continue;
      const role = ([...r.role.entries()].sort((a, b) => b[1] - a[1])[0] || ['ANY'])[0];
      pool.push({ who, role: role === 'SKIP' ? 'ANY' : role, target: Math.max(2, Math.round(avg)), avg, fromAvg: true, float: false });
    }
    const profiles = new Map();
    for (const s of base) {
      if (s.forecast || !s.who || s.date.startsWith(mo)) continue;
      if (!profiles.has(s.who)) profiles.set(s.who, { total: 0, day: 0, eve: 0, night: 0 });
      const t = profiles.get(s.who);
      t.total++;
      t[shiftBucket(s)]++;
    }
    const minedEx = carryRuleModes(overlay.analyze, mineHistory(mo));   // leakage-free, same hard/soft choices
    const monthShifts = base.filter(s => !s.forecast && s.who && s.date.startsWith(mo) && s.site !== site);
    const res = await runGenerationSolver(site, mo, {
      slots, pool, reqs: new Map(), profiles, maxRun: 5, monthShifts,
      edgeShifts: base.filter(s => !s.forecast && s.who),   // real adjacent-month shifts anchor rotation phase
      minedMap: overlay.analyze ? compileMinedRules(minedEx) : new Map(),
      timeLimit: 60,   // diagnostics can afford a real solve — load pins tighten the MIP
    });
    const realById = new Map(real.map(s => [s.id, s.who]));
    let match = 0;
    const genWho = new Map();
    for (const a of res.assignments) {
      if (realById.get(a.slot.id) === a.who) match++;
      genWho.set(a.who, (genWho.get(a.who) || 0) + 1);
    }
    const realWho = new Map();
    for (const s of real) realWho.set(s.who, (realWho.get(s.who) || 0) + 1);
    const provs = new Set([...genWho.keys(), ...realWho.keys()]);
    let mae = 0;
    for (const p of provs) mae += Math.abs((genWho.get(p) || 0) - (realWho.get(p) || 0));
    mae /= Math.max(1, provs.size);
    const realDays = new Set(real.map(s => s.who + '|' + s.date));
    let dayHit = 0;
    for (const a of res.assignments) if (realDays.has(a.who + '|' + a.slot.date)) dayHit++;
    g.backtest = {
      running: false, site, mo, usedRules: !!overlay.analyze,
      slotMatch: match / real.length, dayMatch: dayHit / real.length,
      filled: res.assignments.length, slots: real.length, mae, provs: provs.size,
      engine: res.engine, ms: res.solver && res.solver.ms,
    };
    audit(`Backtest ${siteName(site)} ${fmtMonth(mo)}${overlay.analyze ? ' (mined rules on)' : ' (no mined rules)'}: ${Math.round(g.backtest.slotMatch * 100)}% exact-slot match, ${Math.round(g.backtest.dayMatch * 100)}% same-person-same-day, load error ${mae.toFixed(1)} days/provider`, 'ai');
  } catch (err) {
    g.backtest = { running: false, site, mo, error: String(err.message || err) };
  }
  saveOverlay();
  render();
}

/* ---------- Analyze card (Generate view) ---------- */

function renderAnalyzeCard(wrap) {
  const g = state.gen;
  const an = overlay.analyze;
  const open = !!g.analyzeOpen;
  const box = el('div', 'reqform analyzebox');
  cardHeader(box, `${open ? '▾' : '▸'} 📊 Learned rules from history`, an ? '↻ Re-analyze' : '🔍 Analyze history', () => {
    runAnalyze();
    g.analyzeOpen = true;
    if (g.result) rebuildProposal(g.site, g.month);
    render();
  });
  const h2 = box.querySelector('h2');
  if (h2) {
    h2.style.cursor = 'pointer';
    h2.title = open ? 'Collapse' : 'Expand';
    h2.onclick = () => { g.analyzeOpen = !open; render(); };
  }
  if (!an) {
    if (open) box.append(el('div', 'reqhint', 'Mines every human-made assignment in the imported W2W history — who works which weekdays, weekend rhythm, block shapes and exact monthly loads, position loyalty — into hard and soft rules with confidence scores. The optimizer then builds months that look like the ones your schedulers actually build. Nothing changes until you run it, and every rule stays toggleable.'));
    else box.append(el('div', 'reqhint', 'Not run yet — click Analyze history, or ▸ to read what it does.'));
    wrap.append(box);
    return;
  }
  const total = Object.values(an.rules).reduce((a, b) => a + b.length, 0);
  const counts = { hard: 0, soft: 0, off: 0 };
  for (const rs of Object.values(an.rules)) for (const r of rs) counts[r.mode] = (counts[r.mode] || 0) + 1;
  if (!open) {
    box.append(el('div', 'reqhint', `${total} rules across ${Object.keys(an.rules).length} providers (${counts.hard} hard · ${counts.soft} soft${counts.off ? ` · ${counts.off} off` : ''}), mined ${fmtDate(an.window[0])} – ${fmtDate(an.window[1])} — all active in generation. Click ▸ to browse, toggle, or backtest.`));
    wrap.append(box);
    return;
  }
  box.append(el('div', 'reqhint', `Mined ${fmtDate(an.window[0])} – ${fmtDate(an.window[1])}: ${total} rules across ${Object.keys(an.rules).length} providers — ${counts.hard} hard · ${counts.soft} soft · ${counts.off} off. HARD = the optimizer may never break it; soft = it pays to follow it. Click a chip to cycle hard → soft → off.`));

  const chipFor = (who, r) => {
    const chip = el('button', 'adjchip rulechip mode-' + r.mode,
      `${r.text.replace(/^[^:]+: /, '')} · ${Math.round(r.conf * 100)}%${r.mode === 'hard' ? ' · HARD' : r.mode === 'off' ? ' · OFF' : ''}`);
    chip.type = 'button';
    chip.title = `${r.text}\nconfidence ${Math.round(r.conf * 100)}% · support ${r.support} observations\nClick to cycle: hard → soft → off`;
    chip.onclick = () => {
      r.mode = r.mode === 'hard' ? 'soft' : r.mode === 'soft' ? 'off' : 'hard';
      audit(`Mined rule set to ${r.mode.toUpperCase()}: ${r.text}`, 'ai');
      saveOverlay();
      if (g.result) rebuildProposal(g.site, g.month);
      render();
    };
    return chip;
  };

  /* look up ANY mined provider, roster or not */
  const poolNames = new Set(poolFor(g.site, g.month).map(p => p.who));
  const allWho = Object.keys(an.rules).sort();
  const lookRow = el('div', 'adjrow analyzerow lookuprow');
  lookRow.append(el('span', 'todaylabel', '🔍 Look up'));
  const sel = document.createElement('select');
  const og1 = document.createElement('optgroup');
  og1.label = `${siteName(g.site)} roster`;
  const og2 = document.createElement('optgroup');
  og2.label = 'Everyone else';
  for (const w of allWho) {
    const o = el('option', '', w);
    o.value = w;
    (poolNames.has(w) ? og1 : og2).append(o);
  }
  if (og1.children.length) sel.append(og1);
  if (og2.children.length) sel.append(og2);
  if (!g.analyzeWho || !an.rules[g.analyzeWho]) g.analyzeWho = allWho.find(w => poolNames.has(w)) || allWho[0];
  sel.value = g.analyzeWho;
  sel.onchange = () => { g.analyzeWho = sel.value; render(); };
  lookRow.append(sel);
  box.append(lookRow);
  if (g.analyzeWho && an.rules[g.analyzeWho]) {
    const lr = el('div', 'adjrow analyzerow');
    for (const r of an.rules[g.analyzeWho]) lr.append(chipFor(g.analyzeWho, r));
    box.append(lr);
  }

  const shown = [...poolNames].filter(w => an.rules[w]).sort();
  if (!shown.length) box.append(el('div', 'reqhint', `No mined rules for the current ${siteName(g.site)} roster (providers need 8+ worked days in the window).`));
  else box.append(el('div', 'reqhint rosterlabel', `${siteName(g.site)} roster:`));
  for (const who of shown) {
    const row = el('div', 'adjrow analyzerow');
    row.append(el('span', 'todaylabel', who.replace(/,.*$/, '')));
    for (const r of an.rules[who]) row.append(chipFor(who, r));
    box.append(row);
  }
  const others = Object.keys(an.rules).length - shown.length;
  if (others > 0) box.append(el('div', 'reqhint', `…plus ${others} more providers beyond the ${siteName(g.site)} roster (use Look up above) — their rules travel with them wherever they're scheduled.`));
  if (backendOn()) {
    const nb = el('button', '', an.narrating ? '✦ Opus is reviewing…' : '✦ Opus, sanity-check these rules');
    nb.type = 'button';
    nb.disabled = !!an.narrating;
    nb.onclick = () => narrateAnalysis();
    box.append(nb);
  }
  if (an.narration) box.append(el('div', 'claudeanalysis', an.narration));
  /* backtest: the proof the imitation works */
  const bt = el('div', 'backtestrow');
  bt.append(el('span', 'todaylabel', '🧪 Backtest'));
  const moSel = document.createElement('select');
  for (const m of realMonths()) {
    const o = el('option', '', fmtMonth(m));
    o.value = m;
    if (g.backtest && g.backtest.mo === m) o.selected = true;
    moSel.append(o);
  }
  const runB = el('button', 'primary', `Blind-rebuild a real ${siteName(g.site)} month & compare`);
  runB.type = 'button';
  runB.disabled = !!(g.backtest && g.backtest.running);
  runB.onclick = () => runBacktest(g.site, moSel.value);
  bt.append(moSel, runB);
  box.append(bt);
  const b = g.backtest;
  if (b) {
    if (b.running) box.append(el('div', 'reqhint', `Re-staffing ${siteName(b.site)} ${fmtMonth(b.mo)} blind — roster, targets, and rules all learned from the OTHER months only…`));
    else if (b.error) box.append(el('div', 'conflict', '⚠ ' + b.error));
    else {
      const kp = el('div', 'kpirow');
      kp.append(kpi(`${Math.round(b.dayMatch * 100)}%`, 'Same person, same day as the human schedule', b.dayMatch >= 0.7 ? 'ok' : ''));
      kp.append(kpi(`${Math.round(b.slotMatch * 100)}%`, 'Exact slot → same person', b.slotMatch >= 0.55 ? 'ok' : ''));
      kp.append(kpi(b.mae.toFixed(1), 'Load error (days/provider)', b.mae <= 1.5 ? 'ok' : 'warn'));
      kp.append(kpi(`${b.filled}/${b.slots}`, 'Slots refilled', b.filled === b.slots ? 'ok' : ''));
      box.append(kp);
      box.append(el('div', 'reqhint', `${fmtMonth(b.mo)} at ${siteName(b.site)}, rebuilt with no knowledge of that month${b.usedRules ? ' (mined rules ON)' : ' (mined rules OFF — run Analyze and compare)'}: ${Math.round(b.dayMatch * 100)}% of assignments put the same provider on the same day your schedulers chose. Re-run after toggling rules to see what each one buys.`));
    }
  }
  wrap.append(box);
}

/* one-shot Opus review of the mined rules (statistics in, narration out) */
async function narrateAnalysis() {
  const an = overlay.analyze;
  if (!an || !backendOn() || an.narrating) return;
  an.narrating = true;
  render();
  try {
    const poolNames = new Set(poolFor(state.gen.site, state.gen.month).map(p => p.who));
    const lines = [];
    for (const [who, rs] of Object.entries(an.rules)) {
      for (const r of rs) lines.push(`${poolNames.has(who) ? '[current roster] ' : ''}${r.text} — confidence ${Math.round(r.conf * 100)}%, support ${r.support}, currently ${r.mode.toUpperCase()}`);
    }
    const data = await backendCall('/api/agent', {
      system: 'You review scheduling rules that were statistically mined from six months of real hospital shift schedules. HARD rules become inviolable constraints in an optimizer; SOFT rules become preferences. Your job: flag rules that look like artifacts of short-staffing or small samples rather than true constraints (suggest softening/off), flag any that look strong enough to promote to HARD, and note anything surprising a scheduler should confirm. Be concise — a short paragraph then a few bullets naming specific providers. No tables.',
      messages: [{ role: 'user', content: `Rules mined ${an.window[0]} → ${an.window[1]} (${lines.length} total; roster of the site being scheduled is tagged):\n` + lines.slice(0, 160).join('\n') }],
      tools: [],
    });
    an.narration = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    audit('Opus 4.8 reviewed the mined rule set', 'ai');
  } catch (err) {
    an.narration = 'Review failed: ' + String(err.message || err);
  }
  an.narrating = false;
  saveOverlay();
  render();
}

function applyGeneration(gen) {
  const d = overlay.adminDraft;
  for (const a of gen.assignments) {
    const s = a.slot;
    if (s.forecast) {
      /* forecast slots are admin-side scaffolding — publish real added shifts instead */
      d.added.push({ id: nextAddId(), date: s.date, pos: s.pos, start: s.start, end: s.end, who: a.who, site: s.site, note: '' });
      if (!d.removed.includes(s.id)) d.removed.push(s.id);
    } else {
      d.edits[s.id] = { ...(d.edits[s.id] || {}), who: a.who };
    }
  }
  saveOverlay();
  audit(`AI draft: filled ${gen.assignments.length} of ${gen.slots} ${fmtMonth(gen.mo)} slots at ${siteName(gen.site)} from ${gen.reqs.size} provider requests (${gen.unfilled.length} left open)`, 'ai');
  render();
}

async function stageGenerate() {
  if (backendOn()) return stageGenerateClaude();
  const g = state.gen;
  g.running = true; g.result = null; g.applied = false; g.showEmails = false; g.expanded = new Set();
  g.claudeTargets = null; g.claudeKey = null; g.claudePlan = null;
  rebuildSeq++;   // invalidate any in-flight background rebuild
  render();
  const pool = poolFor(g.site, g.month);
  const reqs = requestsFor(g.site, g.month);
  const openCount = adminShifts().filter(s => s.site === g.site && s.date.startsWith(g.month) && !s.who && slotRole(s.pos) !== 'SKIP').length;
  const setStep = t => { const elx = document.getElementById('genStatus'); if (elx) elx.textContent = t; };
  const pause = ms => new Promise(r => setTimeout(r, ms));
  setStep(`Reading ${reqs.size} provider request${reqs.size === 1 ? '' : 's'}…`);
  await pause(500);
  setStep(`Building the constraint model — ${openCount.toLocaleString()} open slots × ${pool.length} providers…`);
  await pause(500);
  setStep('Solving with HiGHS — mixed-integer optimizer, right here in the browser…');
  g.result = await runGenerationBest(g.site, g.month);
  g.running = false;
  render();
}

/* ---------- provider email previews ---------- */

function emailAddress(who) {
  const c = overlay.contacts[who];
  if (c && c.email) return c.email;
  return who.replace(/,.*$/, '').toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@reliashealthcare.com';
}

function groupRuns(list) {
  const out = [];
  for (const s of list.slice().sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))) {
    const last = out[out.length - 1];
    if (last && last.pos === s.pos && last.start === s.start && last.end === s.end && s.date === addDays(last.endDate, 1)) last.endDate = s.date;
    else out.push({ startDate: s.date, endDate: s.date, pos: s.pos, start: s.start, end: s.end });
  }
  return out;
}

function scheduleEmail(gen, who) {
  const first = who.replace(/,.*$/, '').split(' ')[0];
  const mine = gen.assignments.filter(a => a.who === who).map(a => a.slot);
  const lines = [`Hi ${first},`, '', `Your ${fmtMonth(gen.mo)} schedule at ${siteName(gen.site)} is ready — ${mine.length} shift${mine.length === 1 ? '' : 's'}:`, ''];
  for (const r of groupRuns(mine)) {
    lines.push(`  • ${fmtDate(r.startDate)}${r.endDate !== r.startDate ? `–${fmtDate(r.endDate)}` : ''} · ${r.start}–${r.end} · ${r.pos}`);
  }
  const req = gen.reqs.get(who);
  if (req && req.off.size) lines.push('', `Your requested days off (${moShort(gen.mo)} ${fmtDayRanges(gen.mo, req.off)}) are fully protected.`);
  if (req && req.prefer.size) lines.push(`We placed ${gen.stats.get(who)?.preferGot || 0} of your ${req.prefer.size} preferred days.`);
  lines.push('', 'Need a change? Reply here, or use the swap board in MyReliasSchedule.', '', '— Relias Scheduling (drafted by AI, reviewed by your scheduler)');
  return { to: emailAddress(who), subject: `Your ${fmtMonth(gen.mo)} schedule — ${siteName(gen.site)}`, body: lines.join('\n') };
}

function collectEmail(site, mo) {
  return {
    to: `every ${siteName(site)} provider (individually)`,
    subject: `${fmtMonth(mo)} scheduling requests — reply by the 15th`,
    body: `Hi Dr. —,\n\nWe're building the ${fmtMonth(mo)} schedule for ${siteName(site)}. Reply to this email with your requests, or tap your dates in MyReliasSchedule → Requests:\n\n  • Days you can't work\n  • Days you'd prefer to work\n  • A shift-count target, if any\n\nEverything received by the 15th is guaranteed consideration. Replies are read automatically and added to your request file.\n\n— Relias Scheduling (drafted by AI, reviewed by your scheduler)`,
  };
}

/* ---------- "talk to the schedule" assistant ----------
   Free-typed commands become structured ops (overlay.genAdjust) the generator
   consumes. Parsing is a built-in intent matcher in this prototype; production
   swaps it for a Claude API call emitting the same op schema. */

function knownPeople() {
  const set = new Set(base.filter(s => s.who).map(s => s.who));
  for (const a of overlay.genAdjust || []) if (a.kind === 'addProvider') set.add(a.who);
  return [...set];
}

function findPerson(text) {
  const t = text.toLowerCase();
  let best = null;
  for (const name of knownPeople()) {
    const clean = name.replace(/,.*$/, '').toLowerCase();
    if (t.includes(clean) && (!best || clean.length > best.len)) best = { name, len: clean.length };
  }
  if (best) return best.name;
  const tokens = new Set(t.match(/[a-z]{3,}/g) || []);
  const matches = new Set();
  for (const name of knownPeople()) {
    const last = name.replace(/,.*$/, '').split(' ').pop().toLowerCase();
    if (tokens.has(last)) matches.add(name);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

const STOPCAPS = /^(Sep|Sept|September|Oct|October|Nov|November|Dec|December|Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Add|New|Hire|Take|Move|Give|Cap|Limit|Nights?|Days?|Evenings?|Only|About|Per|Month|Shifts?|Physician|Doctor|Provider|Nurse|Starting|Joining|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Zone|The|She|He|They|We|Our|His|Her|Their)$/i;
function extractNewName(original) {
  /* lookahead keeps pairs overlapping, so "Hire Marcus Webb" tries (Marcus, Webb)
     even after (Hire, Marcus) is rejected */
  for (const m of original.matchAll(/\b([A-Z][a-z]{2,})\s+(?=([A-Z][a-z]{2,})\b)/g)) {
    if (STOPCAPS.test(m[1]) || STOPCAPS.test(m[2])) continue;
    return `${m[1]} ${m[2]}`;
  }
  return null;
}

function parseDates(text, defaultMo) {
  let mo = defaultMo;
  const t = text.toLowerCase();
  const MONTHS = { september: '2026-09', sept: '2026-09', sep: '2026-09', october: '2026-10', oct: '2026-10', november: '2026-11', nov: '2026-11', december: '2026-12', dec: '2026-12', august: '2026-08', aug: '2026-08', july: '2026-07', jul: '2026-07' };
  for (const [k, v] of Object.entries(MONTHS)) if (new RegExp('\\b' + k + '\\b').test(t)) { mo = v; break; }
  const [y, m] = mo.split('-').map(Number);
  const daysIn = new Date(y, m, 0).getDate();
  const dow = d => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const days = new Set();
  if (/\bweekends?\b/.test(t)) for (let d = 1; d <= daysIn; d++) { if (dow(d) === 0 || dow(d) === 6) days.add(d); }
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((nm, i) => {
    if (new RegExp('\\b' + nm + 's?\\b').test(t)) for (let d = 1; d <= daysIn; d++) if (dow(d) === i) days.add(d);
  });
  if (/\b(first|1st) week\b/.test(t)) for (let d = 1; d <= 7; d++) days.add(d);
  if (/\blast week\b/.test(t)) for (let d = daysIn - 6; d <= daysIn; d++) days.add(d);
  /* strip counts ("12 shifts", "4 in a row") so they don't read as dates */
  let t2 = t.replace(/\b\d{1,2}\s*(shifts?\b|days?\s*(a|per)\s*month|per month|\/mo\b|(days?\s*)?(in a row|consecutive|straight))/g, ' ');
  const RANGE = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|—|to|through|thru)\s*(\d{1,2})(?:st|nd|rd|th)?\b/g;
  for (const r of t2.matchAll(RANGE)) {
    const a = +r[1], b = +r[2];
    if (a >= 1 && b >= a && b <= 31) for (let d = a; d <= b; d++) days.add(d);
  }
  t2 = t2.replace(RANGE, ' ');
  for (const s of t2.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g)) { const d = +s[1]; if (d >= 1 && d <= 31) days.add(d); }
  return { mo, dates: [...days].filter(d => d <= daysIn).sort((a, b) => a - b).map(d => `${mo}-${String(d).padStart(2, '0')}`) };
}

const todOf = t =>
  /\bnights?\b|overnights?\b|nocturnist/.test(t) ? 'night'
    : /\bdays?\s+(only|shifts?)\b|\bday shift|\bonly days?\b/.test(t) ? 'day'
      : /\bevenings?\b|\bswing\b/.test(t) ? 'eve' : null;

let chatSeq = 0;
function pushChat(from, text) {
  overlay.genChat.push({ id: 'c' + Date.now() + '-' + (chatSeq++), from, text, created: TODAY });
  if (overlay.genChat.length > 60) overlay.genChat = overlay.genChat.slice(-60);
}

let adjSeq = 0;
function addAdjust(kind, data, summary, site) {
  overlay.genAdjust.push({ id: 'j' + Date.now() + '-' + (adjSeq++), site: site || state.gen.site, kind, summary, created: TODAY, ...data });
}

function handleCommand(raw) {
  const g = state.gen;
  const text = raw.trim();
  const t = text.toLowerCase();
  const firstName = n => n.replace(/,.*$/, '');
  let changed = false;
  let reply = '';

  const person = findPerson(text);
  const { mo, dates } = parseDates(text, g.month);
  const tod = todOf(t);
  const numAfter = re => { const m = t.match(re); return m ? +m[1] : null; };

  /* move an assignment inside the current proposal */
  if (/\b(move|reassign|switch)\b/.test(t) && / to /i.test(text)) {
    if (!g.result) return { reply: 'Generate a schedule first — then I can move assignments around inside the proposal.', changed: false };
    const [left, right] = text.split(/ to /i);
    const fromWho = findPerson(left);
    const toWho = findPerson(right);
    const date = parseDates(left.replace(/shifts?/gi, ' '), g.month).dates[0];
    if (!fromWho || !toWho || !date) return { reply: 'I couldn\'t parse that move. Try: "Move Blake Lovely\'s Sep 14 shift to Jimmy Tu".', changed: false };
    const a = g.result.assignments.find(x => x.who === fromWho && x.slot.date === date);
    if (!a) return { reply: `${firstName(fromWho)} has no proposed shift on ${fmtDate(date)}.`, changed: false };
    const warns = [];
    if (g.result.assignments.some(x => x.who === toWho && x.slot.date === date)) warns.push(`${firstName(toWho)} already works that day`);
    const req = g.result.reqs.get(toWho);
    if (req && req.off.has(date)) warns.push(`${firstName(toWho)} marked ${fmtDate(date)} unavailable`);
    const need = slotRole(a.slot.pos);
    const toRole = providerRole({ pos: '', who: toWho });
    if (need !== 'ANY' && toRole && toRole !== need) warns.push(`role mismatch — ${need} slot, ${toRole} provider`);
    const fromSt = g.result.stats.get(fromWho);
    if (fromSt) { fromSt.assigned--; fromSt.dates.delete(date); }
    let toSt = g.result.stats.get(toWho);
    if (!toSt) {
      toSt = { who: toWho, role: toRole || 'ANY', target: 0, avg: 0, fromAvg: false, float: false, assigned: 0, preferGot: 0, dates: new Set(), prof: timeProfiles().get(toWho) || null, longestRun: 0, tod: null };
      g.result.stats.set(toWho, toSt);
    }
    toSt.assigned++; toSt.dates.add(date);
    a.who = toWho;
    a.preferred = !!(req && req.prefer.has(date));
    audit(`Assistant: moved ${fmtDate(date)} ${a.slot.start}–${a.slot.end} ${a.slot.pos} from ${fromWho} to ${toWho}`, 'ai');
    return { reply: `Done — ${fmtDate(date)} ${a.slot.start}–${a.slot.end} moved from ${firstName(fromWho)} to ${firstName(toWho)}.${warns.length ? ` ⚠ Heads up: ${warns.join('; ')}.` : ''} (Moves live inside this proposal — regenerating rebuilds from scratch.)`, changed: false };
  }

  if (person && /\b(remove|drop|no longer|resigned?|quit|retir\w*|is leaving|off the schedule)\b/.test(t) && !dates.length) {
    addAdjust('removeProvider', { who: person }, `${firstName(person)} removed`);
    audit(`Assistant: removed ${person} from the ${siteName(g.site)} generation pool`, 'ai');
    reply = `Removed ${person} from the ${siteName(g.site)} pool — the generator won't schedule them.`;
    changed = true;
  } else if (person && dates.length && /\b(off|out|unavailable|vacation|pto|can'?t|cannot)\b/.test(t) && !/\b(add|hire|onboard)\b/.test(t)) {
    addAdjust('addOff', { who: person, dates }, `${firstName(person)} off ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}`);
    audit(`Assistant: marked ${person} unavailable ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}`, 'ai');
    reply = `Got it — ${firstName(person)} is unavailable ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}. That's a hard rule.`;
    changed = true;
  } else if (person && dates.length && /\b(prefers?|wants? to work|would like|likes? to work)\b/.test(t)) {
    addAdjust('addPrefer', { who: person, dates }, `${firstName(person)} prefers ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}`);
    audit(`Assistant: noted ${person} prefers ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}`, 'ai');
    reply = `Noted — ${firstName(person)} prefers ${moShort(mo)} ${fmtDayRanges(mo, new Set(dates))}; the generator will chase those days.`;
    changed = true;
  } else if (/\b(add|hire|onboard|bring(ing)? (in|on)|joining|new (provider|physician|doctor|apc|np|pa)|starts? (with us|in))\b/.test(t)) {
    const isNew = !person;
    let name = person || extractNewName(text);
    if (!name) return { reply: 'Who should I add? Try: "Add a new physician, Dr. Sarah Chen, nights only, 12 shifts a month".', changed: false };
    const role = /\bapc\b|\bnp\b|\bpa\b|nurse practitioner|midlevel/.test(t) ? 'APC' : 'PHY';
    if (isNew && !/,/.test(name)) name = name + (role === 'PHY' ? ', MD' : ', NP');
    const target = numAfter(/(\d{1,2})\s*(?:shifts?|days?)(?:\s*(?:a|per)\s*month)?/) || 12;
    addAdjust('addProvider', { who: name, role, target, tod }, `${firstName(name)} added (${role}, ${target}/mo${tod ? ', ' + tod + 's' : ''})`);
    audit(`Assistant: added ${name} to the ${siteName(g.site)} pool — ${role}, target ${target}/mo${tod ? ', ' + tod + ' shifts only' : ''}`, 'ai');
    reply = `Added ${name} to the ${siteName(g.site)} pool — ${role === 'PHY' ? 'physician' : 'APC'}, target ${target} shifts/month${tod ? `, ${tod === 'eve' ? 'evening' : tod} shifts only` : ''}${isNew ? '.' : ' (recognized from the existing roster).'}`;
    changed = true;
  } else if (person && tod && /\b(only|switch\w*|moves? to|going|works?|is)\b/.test(t)) {
    addAdjust('setTimeOfDay', { who: person, tod }, `${firstName(person)} → ${tod}s only`);
    audit(`Assistant: restricted ${person} to ${tod} shifts`, 'ai');
    reply = `Done — ${firstName(person)} now gets ${tod === 'eve' ? 'evening' : tod} shifts only. Hard rule; overrides their history.`;
    changed = true;
  } else if (/\b(no more than|at most|max\w*|cap|limit)\b/.test(t) && /\b(in a row|consecutive|straight)\b/.test(t)) {
    const n = numAfter(/(\d{1,2})\s*(?:days?|shifts?)?\s*(?:in a row|consecutive|straight)/) || numAfter(/(?:no more than|at most|max\w*|cap|limit)\D{0,12}(\d{1,2})/);
    if (!n) return { reply: 'How many in a row? Try: "No more than 4 days in a row".', changed: false };
    addAdjust('maxRun', { value: n }, `max ${n} in a row (all sites)`, '*');
    audit(`Assistant: global rule — no more than ${n} consecutive days`, 'ai');
    reply = `Rule set — nobody gets more than ${n} days in a row. Applies to every site's generation.`;
    changed = true;
  } else if (person && /\b(no more than|at most|max\w*|cap|limit)\b/.test(t)) {
    const n = numAfter(/\bat\s+(\d{1,2})\b/) || numAfter(/(?:no more than|at most|max\w*|cap|limit)\D{0,40}(\d{1,2})/);
    if (!n) return { reply: `What's the cap for ${firstName(person)}? Try: "Cap ${firstName(person)} at 10 shifts".`, changed: false };
    addAdjust('setCap', { who: person, value: n }, `${firstName(person)} capped at ${n}`);
    audit(`Assistant: capped ${person} at ${n} shifts`, 'ai');
    reply = `Capped — ${firstName(person)} won't be scheduled past ${n} shifts.`;
    changed = true;
  } else if (person && numAfter(/(\d{1,2})\s*(?:shifts?|days?)\b/) && /\b(target|should|schedule|give|gets?|aim)\b/.test(t)) {
    const n = numAfter(/(\d{1,2})\s*(?:shifts?|days?)\b/);
    addAdjust('setTarget', { who: person, value: n }, `${firstName(person)} target ${n}/mo`);
    audit(`Assistant: set ${person}'s target to ${n}/mo`, 'ai');
    reply = `Target updated — the generator now aims ${firstName(person)} at ${n} shifts/month.`;
    changed = true;
  } else {
    return {
      reply: 'I can handle things like:\n• "Add a new physician, Dr. Sarah Chen, nights only, 12 shifts a month"\n• "Take Cole Young off the schedule"\n• "Jimmy Tu is unavailable Sep 8–12"  ·  "Kristin Mitchell prefers the last week"\n• "Cap Renee Mitchell at 10 shifts"  ·  "No more than 4 days in a row"\n• "Emily Stuart works days only"\n• After generating: "Move Blake Lovely\'s Sep 14 shift to Jimmy Tu"',
      changed: false,
    };
  }

  if (changed && g.result) {
    rebuildProposal(g.site, g.month);
    reply += ` Regenerated: ${g.result.assignments.length} of ${g.result.slots} slots filled.`;
  } else if (changed) {
    reply += ' It\'ll apply the next time you generate.';
  }
  return { reply, changed };
}

/* ---------- open-ended Opus copilot: tools over the whole site ----------
   The chat is a real agent loop: Opus answers questions or calls these tools,
   the browser executes them against the live data (base + overlay), and the
   results go back for the next turn. Shift changes stage as drafts (invisible
   to staff until Publish), so full control stays reversible. */

const AGENT_TOOLS = [
  { name: 'get_schedule', description: 'Read shifts from the working schedule (published + drafts). Filter by site code, month (YYYY-MM), provider name, or open-only. Returns compact rows with shift ids.',
    input_schema: { type: 'object', properties: { site: { type: 'string' }, month: { type: 'string' }, who: { type: 'string' }, openOnly: { type: 'boolean' }, dateFrom: { type: 'string' }, dateTo: { type: 'string' } } } },
  { name: 'get_providers', description: 'Roster for a site+month: role, employment tier, target, recent average, usual time of day, requests on file (off/prefer/cap), and current month assignment counts.',
    input_schema: { type: 'object', properties: { site: { type: 'string' }, month: { type: 'string' } } } },
  { name: 'update_shift', description: 'Stage a draft edit to an existing shift by id: reassign (who, empty string = make OPEN), change times, note, position, or site. Staff cannot see drafts until published.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, who: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, date: { type: 'string' }, pos: { type: 'string' }, site: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'add_shift', description: 'Stage a new draft shift.',
    input_schema: { type: 'object', required: ['date', 'start', 'end', 'pos', 'site'], properties: { date: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, pos: { type: 'string' }, site: { type: 'string' }, who: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'remove_shift', description: 'Stage a draft removal of a shift by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'set_tier', description: 'Set a provider\'s employment tier: ft (full-time), pt (part-time), prn (as needed). Hierarchy: ft > pt > prn for shift preference; prn has no guaranteed load.',
    input_schema: { type: 'object', required: ['who', 'tier'], properties: { who: { type: 'string' }, tier: { type: 'string', enum: ['ft', 'pt', 'prn'] } } } },
  { name: 'proposal_ops', description: 'Apply generation-pool operations (addProvider/removeProvider/addOff/addPrefer/setCap/setTarget/setTimeOfDay/maxRun/move) and rebuild the AI proposal with the HiGHS optimizer. Same op shapes as before.',
    input_schema: { type: 'object', required: ['ops'], properties: { ops: { type: 'array', items: { type: 'object' } } } } },
  { name: 'run_generation', description: 'Rebuild the AI proposal for a site+month with the HiGHS mixed-integer optimizer (in-browser WASM solver; guarantees all hard rules, globally optimizes coverage/floors/preferences; takes ~5–20s). Returns fill stats and per-provider loads. Use this for whole-month placement instead of hand-assigning shifts.',
    input_schema: { type: 'object', properties: { site: { type: 'string' }, month: { type: 'string' } } } },
  { name: 'clear_provider_proposal', description: 'Remove ALL of one provider\'s shifts from the current AI proposal — the slots become OPEN, nobody else moves, and that provider is benched from refills (a full run_generation brings them back). Follow with refill_open_slots to hand the opens to others. Touches only the proposal, never drafts or the published schedule.',
    input_schema: { type: 'object', required: ['who'], properties: { who: { type: 'string' } } } },
  { name: 'refill_open_slots', description: 'Partial regeneration: the optimizer fills ONLY the proposal\'s currently OPEN slots while every existing assignment stays locked (rest/run/load rules hold across the combination). Use after clearing a provider or opening shifts.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'get_drafts', description: 'List currently staged draft changes (edits/adds/removals) awaiting publish.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'discard_drafts', description: 'Throw away ALL staged draft changes. Only when the user explicitly asks.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'publish_drafts', description: 'Publish every staged draft to the live schedule and notify affected staff. ONLY call when the user explicitly says to publish.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'get_audit', description: 'Recent audit-log entries (publishes, approvals, AI actions).',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } } },
];

async function agentToolExec(name, input) {
  const g = state.gen;
  const fmtRow = s => `${s.id} | ${s.date} ${s.start}–${s.end} | ${s.pos} | ${s.site || '—'} | ${s.who || 'OPEN'}${s.draft ? ' | DRAFT' : ''}${s.note ? ` | note: ${s.note}` : ''}`;
  try {
    if (name === 'get_schedule') {
      let list = adminShifts();
      if (input.site) list = list.filter(s => s.site === input.site);
      if (input.month) list = list.filter(s => s.date.startsWith(input.month));
      if (input.who) list = list.filter(s => s.who && s.who.toLowerCase().includes(String(input.who).toLowerCase()));
      if (input.openOnly) list = list.filter(s => !s.who);
      if (input.dateFrom) list = list.filter(s => s.date >= input.dateFrom);
      if (input.dateTo) list = list.filter(s => s.date <= input.dateTo);
      list.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
      const total = list.length;
      const opens = list.filter(s => !s.who).length;
      return `${total} shifts (${opens} open)${total > 350 ? ' — showing first 350' : ''}:\n` + list.slice(0, 350).map(fmtRow).join('\n');
    }
    if (name === 'get_providers') {
      const site = input.site || g.site;
      const mo = input.month || g.month;
      const reqs = requestsFor(site, mo);
      const profiles = timeProfiles();
      const counts = new Map();
      for (const s of adminShifts()) if (s.who && s.date.startsWith(mo) && s.site === site) counts.set(s.who, (counts.get(s.who) || 0) + 1);
      return poolFor(site, mo).map(p => {
        const r = reqs.get(p.who);
        const bits = [`${p.who} — ${p.role}; ${TIER_LABEL[tierOf(p.who, p.float)]}; target ${p.target}${p.avg ? ` (avg ${p.avg.toFixed(1)})` : ''}; ${mo} assigned ${counts.get(p.who) || 0}; usual ${p.tod || usualShift(profiles.get(p.who))}`];
        if (r) {
          if (r.off.size) bits.push(`off ${[...r.off].map(d => +d.slice(8)).join(',')}`);
          if (r.prefer.size) bits.push(`prefers ${[...r.prefer].map(d => +d.slice(8)).join(',')}`);
          if (r.cap) bits.push(`cap ${r.cap}`);
        }
        return bits.join('; ');
      }).join('\n') || 'no providers found';
    }
    if (name === 'update_shift') {
      const s = adminShifts().find(x => x.id === input.id);
      if (!s) return `No shift with id ${input.id}.`;
      const fields = {};
      for (const k of ['who', 'start', 'end', 'date', 'pos', 'site', 'note']) if (input[k] !== undefined) fields[k] = input[k];
      draftEdit(s, fields);
      audit(`Copilot draft edit — ${describeShift({ ...s, ...fields })}${fields.who !== undefined ? ` (${s.who || 'OPEN'} → ${fields.who || 'OPEN'})` : ''}`, 'ai');
      return `Staged draft edit on ${s.date} ${s.start}–${s.end} ${s.pos}: ${JSON.stringify(fields)}. ${draftCount()} draft changes pending publish.`;
    }
    if (name === 'add_shift') {
      const d = overlay.adminDraft;
      const id = nextAddId();
      d.added.push({ id, date: input.date, pos: input.pos, start: input.start, end: input.end, who: input.who || '', site: input.site, note: input.note || '' });
      audit(`Copilot draft add — ${input.date} ${input.start}–${input.end} ${input.pos} (${input.who || 'OPEN'})`, 'ai');
      return `Staged new draft shift ${id}. ${draftCount()} draft changes pending publish.`;
    }
    if (name === 'remove_shift') {
      const s = adminShifts().find(x => x.id === input.id);
      if (!s) return `No shift with id ${input.id}.`;
      const d = overlay.adminDraft;
      if (!d.removed.includes(input.id)) d.removed.push(input.id);
      audit(`Copilot draft removal — ${describeShift(s)}`, 'ai');
      return `Staged draft removal of ${s.date} ${s.start}–${s.end} ${s.pos}. ${draftCount()} draft changes pending publish.`;
    }
    if (name === 'set_tier') {
      if (!['ft', 'pt', 'prn'].includes(input.tier)) return 'tier must be ft, pt, or prn';
      overlay.tiers[input.who] = input.tier;
      audit(`${input.who} employment tier set to ${TIER_LABEL[input.tier]} (via copilot)`, 'ai');
      return `${input.who} is now ${TIER_LABEL[input.tier]}.`;
    }
    if (name === 'proposal_ops') {
      const n = applyBackendOps(input.ops || []);
      if (n) { g.result = await runGenerationBest(g.site, g.month); g.applied = false; }
      return n ? `Applied ${n} ops; proposal rebuilt by ${g.result.engine === 'milp' ? 'the HiGHS optimizer' : 'the greedy fallback engine'}: ${g.result.assignments.length}/${g.result.slots} filled.` : 'No ops matched — check names/fields.';
    }
    if (name === 'run_generation') {
      if (input.site) g.site = input.site;
      if (input.month) g.month = input.month;
      g.result = await runGenerationBest(g.site, g.month);
      g.applied = false;
      const under = g.result.underFloor.map(n2 => n2.replace(/,.*$/, '')).join(', ');
      const engine = g.result.engine === 'milp'
        ? `HiGHS MILP optimizer (${g.result.solver.vars} vars, ${g.result.solver.status}, ${(g.result.solver.ms / 1000).toFixed(1)}s)`
        : 'greedy fallback engine (optimizer unavailable)';
      return `Proposal for ${siteName(g.site)} ${g.month} — placed by ${engine}: ${g.result.assignments.length}/${g.result.slots} filled, ${g.result.unfilled.length} open.` +
        (under ? ` Below floor: ${under}.` : ' Everyone at/above their floor.') + '\nLoads: ' +
        [...g.result.stats.values()].filter(s => s.assigned).sort((a, b) => b.assigned - a.assigned).map(s => `${s.who.replace(/,.*$/, '')} ${s.assigned}/${s.target}`).join(', ');
    }
    if (name === 'clear_provider_proposal') {
      if (!g.result) return 'No proposal yet — run run_generation first.';
      const frag = String(input.who || '').toLowerCase();
      const full = [...g.result.stats.keys()].find(k => k.toLowerCase().includes(frag));
      if (!full) return `No provider matching "${input.who}" in the proposal.`;
      const n = clearProviderFromProposal(g.result, full);
      g.applied = false;
      return n ? `Cleared ${full} — ${n} slots reopened (${g.result.unfilled.length} open total). Call refill_open_slots to redistribute.` : `${full} has no proposed shifts.`;
    }
    if (name === 'refill_open_slots') {
      if (!g.result) return 'No proposal yet — run run_generation first.';
      const before = g.result.unfilled.length;
      if (!before) return 'Nothing to do — no open slots in the proposal.';
      await refillOpenSlots();
      return `Refill done: ${before - g.result.unfilled.length} of ${before} open slots filled by the optimizer (${g.result.engine === 'milp' ? g.result.solver.status : 'greedy'}); ${g.result.unfilled.length} remain open. Kept assignments untouched.`;
    }
    if (name === 'get_drafts') {
      const d = overlay.adminDraft;
      const edits = Object.entries(d.edits).map(([id, f]) => `edit ${id}: ${JSON.stringify(f)}`);
      const adds = d.added.map(a => `add ${a.id}: ${a.date} ${a.start}–${a.end} ${a.pos} (${a.who || 'OPEN'})`);
      const rems = d.removed.map(id => `remove ${id}`);
      return [...edits, ...adds, ...rems].join('\n') || 'No draft changes staged.';
    }
    if (name === 'discard_drafts') {
      const n = draftCount();
      overlay.adminDraft = { edits: {}, added: [], removed: [] };
      audit(`Copilot discarded ${n} draft changes (user request)`, 'ai');
      return `Discarded ${n} draft changes.`;
    }
    if (name === 'publish_drafts') {
      const n = draftCount();
      if (!n) return 'Nothing to publish — no draft changes staged.';
      publishDraft();
      return `Published ${n} changes; affected staff notified in the employee app.`;
    }
    if (name === 'get_audit') {
      return (overlay.audit || []).slice(0, Math.min(input.limit || 20, 50)).map(a => `${a.created || ''} [${a.kind || 'log'}] ${a.text}`).join('\n') || 'Audit log is empty.';
    }
    return `Unknown tool ${name}.`;
  } catch (err) {
    return `Tool error: ${String(err.message || err)}`;
  }
}

let agentConvo = [];   // in-memory conversation (API format); resets each login/reload

function agentSystemPrompt() {
  const g = state.gen;
  return [
    `You are the scheduling copilot for Relias Healthcare's MyReliasSchedule console (currently viewing ${siteName(g.site)}, ${g.month}). The user is the scheduler; help with ANYTHING schedule-related: answer questions, analyze coverage/fairness, and make changes.`,
    `You have full control through your tools. Read before you write: check the schedule/roster with get_schedule/get_providers rather than assuming. Shift edits stage as DRAFTS the staff can't see; tell the user drafts are pending and that they (or you, if they say so) must publish. Only call publish_drafts or discard_drafts when the user explicitly asks.`,
    `House rules you must respect and can explain: nobody ends a month below their average minus one (PRN exempt); nobody above target+1; ≥10h rest between shifts; one shift/day; max-consecutive-days rule; keep people on their usual time of day; hierarchy full-time > part-time > PRN.`,
    `Schedule placement is done by the HiGHS mixed-integer optimizer (a real MILP solver running in the browser), NOT by you and not by a greedy heuristic — run_generation/proposal_ops invoke it, and its result is provably optimal or near-optimal under the house rules. Never hand-place a whole month shift-by-shift; adjust the inputs (requests, caps, targets, tiers, rules) and re-run the optimizer. Individual swaps/edits via update_shift are fine. The tool result tells you which engine placed the proposal; "greedy fallback" appears only if the solver failed to load.`,
    `Site codes: ${Object.entries(SITE_NAMES).map(([c, n]) => `${c}=${n}`).join(', ')}.`,
    `Be concise and concrete — cite names, dates, and counts from tool results. If a request is ambiguous, ask.`,
  ].join('\n\n');
}

async function runAgentChat(text) {
  const g = state.gen;
  agentConvo.push({ role: 'user', content: text });
  if (agentConvo.length > 40) agentConvo = agentConvo.slice(-30);
  let mutated = false;
  const MUTATING = new Set(['update_shift', 'add_shift', 'remove_shift', 'set_tier', 'proposal_ops', 'run_generation', 'clear_provider_proposal', 'refill_open_slots', 'discard_drafts', 'publish_drafts']);
  for (let hop = 0; hop < 8; hop++) {
    const data = await backendCall('/api/agent', { system: agentSystemPrompt(), messages: agentConvo, tools: AGENT_TOOLS });
    agentConvo.push({ role: 'assistant', content: data.content });
    const textParts = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (textParts) pushChat('ai', textParts);
    const calls = (data.content || []).filter(b => b.type === 'tool_use');
    if (!calls.length || data.stop_reason !== 'tool_use') break;
    const results = [];
    for (const c of calls) {
      pushChat('tool', `🔧 ${c.name}(${JSON.stringify(c.input).slice(0, 120)})`);
      if (MUTATING.has(c.name)) mutated = true;
      results.push({ type: 'tool_result', tool_use_id: c.id, content: await agentToolExec(c.name, c.input || {}) });
    }
    agentConvo.push({ role: 'user', content: results });
    saveOverlay();
    render();   // live progress — user watches the tools fire
  }
  return mutated;
}

function renderScheduleChat(wrap) {
  const g = state.gen;
  const box = el('div', 'reqform genchat');
  const on = backendOn();
  cardHeader(box, '💬 Talk to the schedule', on ? '🔌 Claude connected' : '🔌 Connect Claude', openBackendDialog);
  box.append(el('div', 'reqhint', on
    ? 'Opus 4.8 with full control — ask anything schedule-related or tell it what to change: shifts, drafts, tiers, rules, whole-month generation. Shift changes stage as drafts until published.'
    : 'Free-type roster and rule changes — parsed in-browser now; connect the Claude backend for the full copilot.'));
  const log = el('div', 'chatlog');
  const msgs = overlay.genChat || [];
  if (!msgs.length) {
    log.append(el('div', 'chatmsg ai', 'Hi! I can see and change everything here — ask me things like "who covers Northport nights the week of Sep 14?", "swap Blake\'s Sep 22 to Kristin", "why is Tupelo short?", or "build October and publish it."'));
  }
  for (const m of msgs.slice(-30)) log.append(el('div', 'chatmsg ' + (m.from === 'you' ? 'you' : m.from === 'tool' ? 'tool' : 'ai'), m.text));
  box.append(log);
  const form = el('form', 'chatform');
  const inp = el('input');
  inp.placeholder = 'e.g. "Take Cole Young off the schedule" or "No more than 4 days in a row"';
  inp.autocomplete = 'off';
  const send = el('button', 'primary', 'Send');
  send.type = 'submit';
  form.append(inp, send);
  form.onsubmit = async e => {
    e.preventDefault();
    const text = inp.value.trim();
    if (!text) return;
    pushChat('you', text);
    if (backendOn()) {
      g.chatFocus = true;
      saveOverlay();
      render();
      try {
        await runAgentChat(text);
      } catch (err) {
        pushChat('ai', `Claude backend error (${String(err.message || err)}). Using the in-browser parser instead: ` + handleCommand(text).reply);
      }
    } else {
      pushChat('ai', handleCommand(text).reply);
    }
    g.chatFocus = true;
    saveOverlay();
    render();
  };
  box.append(form);
  const active = (overlay.genAdjust || []).filter(a => a.site === g.site || a.site === '*');
  if (active.length) {
    const chips = el('div', 'adjrow');
    chips.append(el('span', 'todaylabel', 'Active changes'));
    for (const a of active.slice(-10)) {
      const chip = el('span', 'adjchip', a.summary);
      const x = el('button', 'adjx', '✕');
      x.type = 'button';
      x.title = 'Undo this change';
      x.onclick = () => {
        overlay.genAdjust = overlay.genAdjust.filter(z => z.id !== a.id);
        rebuildProposal(g.site, g.month);
        pushChat('ai', `Undid: ${a.summary}.`);
        saveOverlay();
        render();
      };
      chip.append(x);
      chips.append(chip);
    }
    box.append(chips);
  }
  wrap.append(box);
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
    if (g.chatFocus) { g.chatFocus = false; inp.focus(); }
  });
}

/* ---------- requests editor + rules dialogs ---------- */

function cardHeader(box, title, btnLabel, onClick) {
  const head = el('div', 'cardhead');
  head.append(el('h2', '', title));
  if (btnLabel) {
    const b = el('button', 'cardheadbtn', btnLabel);
    b.type = 'button';
    b.onclick = onClick;
    head.append(b);
  }
  box.append(head);
}

function openModal(cls, build) {
  const dlg = document.createElement('dialog');
  dlg.className = 'gen-modal ' + (cls || '');
  const body = el('div');
  dlg.append(body);
  document.body.append(dlg);
  const cleanup = () => { if (dlg.parentNode) dlg.remove(); };
  dlg.addEventListener('close', cleanup);   // Escape key closes → clean up too
  const close = () => { dlg.close(); cleanup(); };
  build(body, close);
  dlg.showModal();
  return { dlg, body, close };
}

/* styled in-app confirmation (replaces native confirm() for console actions) */
function confirmModal({ title, body, confirmLabel, danger, onConfirm }) {
  openModal('confirm-modal', (mb, close) => {
    mb.append(el('h2', '', title || 'Please confirm'));
    if (body) mb.append(el('div', 'confirm-body', body));
    const actions = el('div', 'dialog-actions');
    actions.append(el('span', 'spacer'));
    const cancel = el('button', '', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    const ok = el('button', danger ? 'confirm-danger' : 'primary', confirmLabel || 'Confirm');
    ok.type = 'button';
    ok.onclick = () => { close(); onConfirm && onConfirm(); };
    actions.append(cancel, ok);
    mb.append(actions);
  });
}

/* enter / modify a single provider's requests on a clickable month calendar */
function openRequestEditor(initialWho) {
  const g = state.gen;
  const site = g.site, mo = g.month;
  const pool = poolFor(site, mo);
  if (!pool.length) { alert('No providers in this site pool yet.'); return; }
  const edit = { who: initialWho || pool[0].who, off: new Set(), prefer: new Set(), cap: '', note: '' };

  function load(who) {
    const r = requestsFor(site, mo).get(who);
    edit.who = who;
    edit.off = new Set([...(r?.off || [])].filter(d => d.startsWith(mo)));
    edit.prefer = new Set([...(r?.prefer || [])].filter(d => d.startsWith(mo)));
    edit.cap = r?.cap || '';
    edit.note = r?.note || '';
  }
  load(edit.who);

  const modal = openModal('req-modal', (body, close) => {
    function paint() {
      body.innerHTML = '';
      body.append(el('h2', '', `Requests — ${siteName(site)}, ${fmtMonth(mo)}`));

      const picker = el('label', 'modal-field', 'Provider ');
      const sel = document.createElement('select');
      for (const p of [...pool].sort((a, b) => a.who.localeCompare(b.who))) {
        const o = el('option', '', `${p.who}${p.float ? ' (float)' : ''}`);
        o.value = p.who;
        if (p.who === edit.who) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => { load(sel.value); paint(); };
      picker.append(sel);
      body.append(picker);

      const legend = el('div', 'preflegend');
      legend.append(el('span', 'prefchip pref-like', '✓ prefers to work'));
      legend.append(el('span', 'prefchip pref-no', '✕ unavailable'));
      legend.append(el('span', '', 'Click a day to cycle: prefer → unavailable → clear.'));
      body.append(legend);

      const [y, m] = mo.split('-').map(Number);
      const table = el('table', 'reqcal');
      const hr = el('tr');
      for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) hr.append(el('th', '', d));
      table.append(hr);
      const first = new Date(Date.UTC(y, m - 1, 1));
      const daysIn = new Date(y, m, 0).getDate();
      let tr = el('tr');
      for (let i = 0; i < first.getUTCDay(); i++) tr.append(el('td', 'off'));
      for (let day = 1; day <= daysIn; day++) {
        const iso = `${mo}-${String(day).padStart(2, '0')}`;
        const on = edit.off.has(iso), pf = edit.prefer.has(iso);
        const td = el('td', 'reqcell' + (on ? ' cell-off' : pf ? ' cell-prefer' : ''), String(day));
        td.onclick = () => {
          if (edit.prefer.has(iso)) { edit.prefer.delete(iso); edit.off.add(iso); }
          else if (edit.off.has(iso)) { edit.off.delete(iso); }
          else { edit.prefer.add(iso); }
          paint();
        };
        tr.append(td);
        if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
      }
      if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
      body.append(table);

      const capField = el('label', 'modal-field', 'Max shifts this month (optional) ');
      const capInp = document.createElement('input');
      capInp.type = 'number'; capInp.min = '0'; capInp.max = '31';
      capInp.value = edit.cap;
      capInp.placeholder = 'no cap';
      capInp.oninput = () => { edit.cap = capInp.value; };
      capField.append(capInp);
      body.append(capField);

      const noteField = el('label', 'modal-field', 'Note (optional) ');
      const noteInp = document.createElement('input');
      noteInp.type = 'text';
      noteInp.value = edit.note;
      noteInp.placeholder = 'e.g. "prefers Zone B", "wedding weekend"';
      noteInp.oninput = () => { edit.note = noteInp.value; };
      noteField.append(noteInp);
      body.append(noteField);

      const summary = el('div', 'reqhint', `${edit.prefer.size} preferred · ${edit.off.size} unavailable${edit.cap ? ` · cap ${edit.cap}` : ''}`);
      body.append(summary);

      const actions = el('div', 'dialog-actions');
      const clearBtn = el('button', '', 'Clear all for this person');
      clearBtn.type = 'button';
      clearBtn.onclick = () => { edit.off = new Set(); edit.prefer = new Set(); edit.cap = ''; edit.note = ''; paint(); };
      actions.append(clearBtn, el('span', 'spacer'));
      const cancel = el('button', '', 'Cancel');
      cancel.type = 'button';
      cancel.onclick = close;
      const save = el('button', 'primary', 'Save requests');
      save.type = 'button';
      save.onclick = () => {
        clearPersonRequestOps(edit.who, site, mo);
        const off = [...edit.off].sort(), prefer = [...edit.prefer].sort();
        const cap = edit.cap ? Number(edit.cap) : null;
        addAdjust('setRequest', { who: edit.who, mo, off, prefer, cap, note: edit.note.trim() },
          `${edit.who.replace(/,.*$/, '')} requests set (${off.length} off · ${prefer.length} prefer${cap ? ` · cap ${cap}` : ''})`, site);
        audit(`Requests editor: set ${edit.who} for ${fmtMonth(mo)} — ${off.length} off, ${prefer.length} prefer${cap ? `, cap ${cap}` : ''}`, 'ai');
        rebuildProposal(site, mo);
        saveOverlay();
        close();
        render();
      };
      actions.append(cancel, save);
      body.append(actions);
    }
    paint();
  });
  return modal;
}

/* quick structured rules — global + per-provider */
function openRulesDialog() {
  const g = state.gen;
  const site = g.site, mo = g.month;
  openModal('rules-modal', (body, close) => {
    function paint() {
      body.innerHTML = '';
      body.append(el('h2', '', `Rules — ${siteName(site)}, ${fmtMonth(mo)}`));

      /* global: max consecutive days */
      const g1 = el('div', 'rulegroup');
      g1.append(el('h3', '', 'Global rule'));
      const r1 = el('div', 'reqrow');
      const curMax = (genAdjustFor(site).slice().reverse().find(a => a.kind === 'maxRun') || {}).value || 5;
      const maxLab = el('label', '', 'No more than ');
      const maxInp = document.createElement('input');
      maxInp.type = 'number'; maxInp.min = '1'; maxInp.max = '14'; maxInp.value = curMax;
      maxInp.className = 'rulenum';
      maxLab.append(maxInp, document.createTextNode(' days in a row (everyone, all sites)'));
      const maxBtn = el('button', 'primary', 'Set');
      maxBtn.type = 'button';
      maxBtn.onclick = () => {
        const n = Number(maxInp.value);
        if (!n) return;
        overlay.genAdjust = overlay.genAdjust.filter(a => a.kind !== 'maxRun');
        addAdjust('maxRun', { value: n }, `max ${n} in a row (all sites)`, '*');
        audit(`Rules dialog: max ${n} consecutive days`, 'ai');
        rebuildProposal(site, mo);
        saveOverlay();
        paint();
      };
      r1.append(maxLab, maxBtn);
      g1.append(r1);
      body.append(g1);

      /* per-provider rule */
      const g2 = el('div', 'rulegroup');
      g2.append(el('h3', '', 'Provider rule'));
      const r2 = el('div', 'reqrow');
      const pool = poolFor(site, mo);
      const pSel = document.createElement('select');
      for (const p of [...pool].sort((a, b) => a.who.localeCompare(b.who))) {
        const o = el('option', '', p.who); o.value = p.who; pSel.append(o);
      }
      const kSel = document.createElement('select');
      for (const [v, label] of [['night', 'nights only'], ['day', 'days only'], ['eve', 'evenings only'], ['cap', 'cap at…'], ['target', 'target…'], ['remove', 'remove from schedule']]) {
        const o = el('option', '', label); o.value = v; kSel.append(o);
      }
      const vInp = document.createElement('input');
      vInp.type = 'number'; vInp.min = '1'; vInp.max = '31'; vInp.value = '10'; vInp.className = 'rulenum';
      const syncV = () => { vInp.style.display = (kSel.value === 'cap' || kSel.value === 'target') ? '' : 'none'; };
      kSel.onchange = syncV; syncV();
      const applyBtn = el('button', 'primary', 'Apply');
      applyBtn.type = 'button';
      applyBtn.onclick = () => {
        const who = pSel.value, kind = kSel.value, n = Number(vInp.value);
        const first = who.replace(/,.*$/, '');
        if (kind === 'remove') { addAdjust('removeProvider', { who }, `${first} removed`, site); audit(`Rules dialog: removed ${who}`, 'ai'); }
        else if (kind === 'cap') { addAdjust('setCap', { who, value: n }, `${first} capped at ${n}`, site); audit(`Rules dialog: capped ${who} at ${n}`, 'ai'); }
        else if (kind === 'target') { addAdjust('setTarget', { who, value: n }, `${first} target ${n}/mo`, site); audit(`Rules dialog: ${who} target ${n}`, 'ai'); }
        else { addAdjust('setTimeOfDay', { who, tod: kind }, `${first} → ${kind}s only`, site); audit(`Rules dialog: ${who} ${kind} only`, 'ai'); }
        rebuildProposal(site, mo);
        saveOverlay();
        paint();
      };
      r2.append(pSel, kSel, vInp, applyBtn);
      g2.append(r2);
      body.append(g2);

      /* active rules with remove */
      const active = (overlay.genAdjust || []).filter(a => (a.site === site || a.site === '*') && ['maxRun', 'setTimeOfDay', 'setCap', 'setTarget', 'removeProvider', 'addProvider'].includes(a.kind));
      const listBox = el('div', 'rulegroup');
      listBox.append(el('h3', '', `Active rules (${active.length})`));
      if (!active.length) listBox.append(el('div', 'reqhint', 'No rules yet. Day-off and preference requests live in the requests editor; this dialog is for hard rules.'));
      else {
        const chips = el('div', 'adjrow');
        for (const a of active) {
          const chip = el('span', 'adjchip', a.summary);
          const x = el('button', 'adjx', '✕');
          x.type = 'button';
          x.onclick = () => {
            overlay.genAdjust = overlay.genAdjust.filter(z => z.id !== a.id);
            rebuildProposal(site, mo);
            saveOverlay();
            paint();
          };
          chip.append(x);
          chips.append(chip);
        }
        listBox.append(chips);
      }
      body.append(listBox);

      const actions = el('div', 'dialog-actions');
      actions.append(el('span', 'spacer'));
      const done = el('button', 'primary', 'Done');
      done.type = 'button';
      done.onclick = () => { close(); render(); };
      actions.append(done);
      body.append(actions);
    }
    paint();
  });
}

/* ---------- manual edits to a generated proposal ----------
   These mutate the in-memory proposal (g.result); regenerating rebuilds from
   scratch, same as the chat "move" command. */

function ensureStat(res, who) {
  let st = res.stats.get(who);
  if (st) return st;
  st = { who, role: providerRole({ pos: '', who }) || 'ANY', target: 0, avg: 0, fromAvg: false, float: false,
    assigned: 0, preferGot: 0, dates: new Set(), shiftByDate: new Map(), prof: timeProfiles().get(who) || null, longestRun: 0, tod: null };
  res.stats.set(who, st);
  return st;
}

function recomputeProposalDerived(res) {
  for (const st of res.stats.values()) {
    let best = 0;
    for (const d of st.dates) {
      if (st.dates.has(addDays(d, -1))) continue;
      let len = 1;
      while (st.dates.has(addDays(d, len))) len++;
      best = Math.max(best, len);
    }
    st.longestRun = best;
  }
  res.preferGot = [...res.stats.values()].reduce((a, s) => a + (s.preferGot || 0), 0);
}

function slotKey(slot) { return slot.id || `${slot.date}|${slot.start}|${slot.end}|${slot.pos}`; }

function removeFromSlot(res, slot) {
  const a = res.assignments.find(x => x.slot === slot);
  if (!a) return;
  const st = res.stats.get(a.who);
  if (st) { st.assigned--; st.dates.delete(slot.date); st.shiftByDate?.delete(slot.date); if (a.preferred) st.preferGot--; }
  res.assignments = res.assignments.filter(x => x !== a);
  res.unfilled.push(slot);
  /* hard rule: whoever was removed can never be refilled onto THIS slot —
     a full Generate resets the exclusions */
  (res.excluded = res.excluded || new Set()).add(a.who + '|' + slotKey(slot));
  audit(`Proposal edit: opened up ${describeShift(slot)} (was ${a.who} — excluded from getting it back on refill)`, 'ai');
}

function addToSlot(res, slot, who) {
  res.unfilled = res.unfilled.filter(s => s !== slot);
  const r = res.reqs.get(who);
  const preferred = !!(r && r.prefer.has(slot.date));
  res.assignments.push({ slot, who, preferred });
  const st = ensureStat(res, who);
  st.assigned++; st.dates.add(slot.date); st.shiftByDate?.set(slot.date, slot); if (preferred) st.preferGot++;
  audit(`Proposal edit: assigned ${who} to ${describeShift(slot)}`, 'ai');
}

/* who could legally take this open slot, given the current proposal state */
function proposalCandidates(res, slot) {
  const need = slotRole(slot.pos);
  const bucket = shiftBucket(slot);
  const out = [];
  for (const st of res.stats.values()) {
    if (need !== 'ANY' && st.role !== 'ANY' && st.role !== need) continue;
    const r = res.reqs.get(st.who);
    const warn = [];
    if (st.dates.has(slot.date)) continue;                                    // already works that day — never valid
    if (r && r.off.has(slot.date)) warn.push('marked off');
    const prev = st.shiftByDate?.get(addDays(slot.date, -1));
    if (prev && absMin(slot.date, slot.start) - shiftEndMin(prev) < MIN_REST_MIN) warn.push('<10h rest');
    if (st.tod && bucket !== st.tod) warn.push(`usually ${st.tod}s`);
    else if (!st.tod && st.prof && st.prof.total >= 8 && st.prof[bucket] / st.prof.total <= 0.05) warn.push('off-pattern time');
    const cap = (r && r.cap) || st.target + 1;
    const over = st.assigned >= cap;
    out.push({ who: st.who, assigned: st.assigned, target: st.target, over, warn: warn.join(' · ') });
  }
  return out.sort((a, b) =>
    (a.warn ? 1 : 0) - (b.warn ? 1 : 0) ||
    (a.over ? 1 : 0) - (b.over ? 1 : 0) ||
    a.assigned - b.assigned ||
    a.who.localeCompare(b.who));
}

function openSlotPicker(res, slot) {
  openModal('picker-modal', (body, close) => {
    body.append(el('h2', '', `Fill ${fmtDateLong(slot.date)} · ${slot.start}–${slot.end}`));
    body.append(el('div', 'reqhint', `${slot.pos} at ${siteName(slot.site)} — pick who works it. Best fits first; ⚠ ones break a rule but you can override. Search reaches everyone in the system, or type any new name.`));
    const assign = who => {
      addToSlot(res, slot, who);
      recomputeProposalDerived(res);
      state.gen.applied = false;
      saveOverlay();
      close();
      render();
    };
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'pickersearch';
    search.placeholder = '🔍 Search anyone — or type a new name to add them…';
    search.autocomplete = 'off';
    body.append(search);
    const cands = proposalCandidates(res, slot);
    const candWho = new Set(cands.map(c => c.who));
    const everyone = [...new Set(base.filter(s => s.who).map(s => s.who))].sort();
    const list = el('div', 'pickerlist');
    body.append(list);
    const rowBtn = (who, metaText, warn) => {
      const row = el('button', 'pickeritem' + (warn ? ' warn' : ''));
      row.type = 'button';
      row.append(el('span', 'pickname', who));
      row.append(el('span', 'pickmeta', metaText));
      row.onclick = () => assign(who);
      return row;
    };
    const paint = () => {
      list.innerHTML = '';
      const raw = search.value.trim();
      const q = raw.toLowerCase();
      const matches = q ? cands.filter(c => c.who.toLowerCase().includes(q)) : cands;
      if (matches.length) list.append(el('div', 'pickerlabel', 'Best fits from this roster'));
      for (const c of matches.slice(0, q ? 8 : 16)) {
        const meta = [`${c.assigned}/${c.target}`];
        if (c.over) meta.push('at cap');
        if (c.warn) meta.push('⚠ ' + c.warn);
        list.append(rowBtn(c.who, meta.join(' · '), c.warn || c.over));
      }
      if (q) {
        const rest = everyone.filter(w => !candWho.has(w) && w.toLowerCase().includes(q)).slice(0, 8);
        if (rest.length) {
          list.append(el('div', 'pickerlabel', 'Everyone in the system'));
          const all = adminShifts();
          for (const w of rest) {
            const busy = all.some(s => s.who === w && s.date === slot.date);
            list.append(rowBtn(w, busy ? '⚠ already works that day' : 'not in this site’s pool', busy));
          }
        }
        const known = candWho.has(raw) || everyone.some(w => w.toLowerCase() === q) || matches.some(c => c.who.toLowerCase() === q);
        if (!known && raw.length >= 3) {
          list.append(el('div', 'pickerlabel', 'New name'));
          list.append(rowBtn(raw, '➕ assign as typed — new to the system', false));
        }
        if (!matches.length && !rest.length && raw.length < 3) list.append(el('div', 'approval-empty', 'No matches — keep typing (3+ letters lets you add a brand-new name).'));
      } else if (!cands.length) {
        list.append(el('div', 'approval-empty', 'No one in the pool can take this slot cleanly — search above for anyone in the system, or type a new name.'));
      }
    };
    search.oninput = paint;
    paint();
    setTimeout(() => search.focus(), 0);
    const act = el('div', 'dialog-actions');
    act.append(el('span', 'spacer'));
    const cancel = el('button', '', 'Close');
    cancel.type = 'button';
    cancel.onclick = close;
    act.append(cancel);
    body.append(act);
  });
}

/* connect the Claude backend */
function openBackendDialog() {
  openModal('backend-modal', (body, close) => {
    const cfg = backendCfg() || {};
    const status = el('div', 'reqhint', '');
    function paint() {
      body.innerHTML = '';
      body.append(el('h2', '', '🔌 Connect Claude (Opus 4.8)'));
      body.append(el('div', 'reqhint', 'Point the console at your Cloudflare Worker so the chat box and Generate button run on Opus 4.8. Without a backend, everything still works using the in-browser logic.'));
      const urlF = el('label', 'modal-field', 'Backend URL ');
      const urlI = document.createElement('input');
      urlI.type = 'url'; urlI.placeholder = 'https://shiftboard-claude.<subdomain>.workers.dev';
      urlI.value = cfg.url || '';
      urlF.append(urlI);
      const tokF = el('label', 'modal-field', 'Console token (optional) ');
      const tokI = document.createElement('input');
      tokI.type = 'password'; tokI.placeholder = 'only if you set CONSOLE_TOKEN';
      tokI.value = cfg.token || '';
      tokF.append(tokI);
      body.append(urlF, tokF, status);
      const actions = el('div', 'dialog-actions');
      const test = el('button', '', 'Test connection');
      test.type = 'button';
      test.onclick = async () => {
        const url = urlI.value.trim().replace(/\/+$/, '');
        if (!url) { status.textContent = 'Enter the Worker URL first.'; return; }
        status.textContent = 'Testing…';
        try {
          const res = await fetch(url + '/api/health');
          const h = await res.json();
          status.textContent = h.ok
            ? `✓ Connected. Model ${h.model}. ${h.hasKey ? 'API key set.' : '⚠ No API key on the Worker yet — run: wrangler secret put ANTHROPIC_API_KEY'}${h.tokenRequired ? ' Token required.' : ''}`
            : 'Reached the Worker but it reported not-ok.';
        } catch (e) { status.textContent = '✗ Could not reach that URL. Check it and that the Worker is deployed.'; }
      };
      /* no Disconnect button by design — the owner wants the backend always on
         so nobody unplugs Opus by accident; saving an empty URL just reverts
         to the built-in default Worker */
      const save = el('button', 'primary', 'Save');
      save.type = 'button';
      save.onclick = () => { backendSet({ url: urlI.value.trim(), token: tokI.value.trim() }); close(); render(); };
      actions.append(el('span', 'spacer'), test, save);
      body.append(actions);
    }
    paint();
  });
}

/* Opus-4.8-driven generation: Claude writes the analysis + rationale while the
   HiGHS optimizer places the shifts in parallel (all hard rules guaranteed) */
async function stageGenerateClaude() {
  const g = state.gen;
  g.running = true; g.result = null; g.applied = false; g.showEmails = false; g.expanded = new Set();
  g.claudeTargets = null; g.claudeKey = null; g.claudePlan = null;
  render();
  rebuildSeq++;   // invalidate any in-flight background rebuild
  const steps = ['Sending the roster and requests to Opus 4.8…', 'Opus 4.8 is reading the month…', 'HiGHS optimizer is placing the shifts…'];
  let i = 0;
  const tick = () => { const e = document.getElementById('genStatus'); if (e && i < steps.length) { e.textContent = steps[i++]; setTimeout(tick, 900); } };
  tick();
  const profiles = timeProfiles();
  /* send each provider's EFFECTIVE baseline as their average: real worked
     average when it's a credible signal, otherwise the planned-roster target.
     Sending the raw noisy average (e.g. 2 stray days at a forecast site) made
     Opus "honor" a phantom tiny load and lowball everyone. */
  const providers = poolFor(g.site, g.month).map(p => ({ who: p.who, role: p.role, avg: p.fromAvg && p.avg ? p.avg : p.target, usual: usualShift(profiles.get(p.who)), tier: tierOf(p.who, p.float) }));
  const reqs = [...requestsFor(g.site, g.month).values()]
    .filter(r => providers.some(p => p.who === r.who) || r.source === 'example')
    .map(r => ({ who: r.who, off: [...r.off].filter(d => d.startsWith(g.month)).map(d => +d.slice(8)), prefer: [...r.prefer].filter(d => d.startsWith(g.month)).map(d => +d.slice(8)), cap: r.cap, note: r.note }));
  const openSlots = adminShifts().filter(s => s.site === g.site && s.date.startsWith(g.month) && !s.who && slotRole(s.pos) !== 'SKIP').length;
  const maxRun = (genAdjustFor(g.site).slice().reverse().find(a => a.kind === 'maxRun') || {}).value || 5;
  /* Opus writes the narrative; the optimizer owns the placement AND the numbers.
     (/api/generate still returns targets for older clients, but they are no
     longer applied — asking a language model to pick twenty interacting
     integers is exactly the job the MILP provably does better.) */
  const [plan, res] = await Promise.allSettled([
    backendCall('/api/generate', {
      site: g.site, siteName: siteName(g.site), month: g.month, historyMonths: HIST_MONTHS.length,
      openSlots, providers, requests: reqs, rules: `no more than ${maxRun} consecutive days; at least 10h between shifts; keep night providers on nights`,
    }),
    runGenerationBest(g.site, g.month),
  ]);
  if (plan.status === 'fulfilled') {
    g.claudePlan = { analysis: plan.value.analysis, notes: plan.value.notes || [] };
    audit(`Opus 4.8 analyzed ${fmtMonth(g.month)} at ${siteName(g.site)}; the HiGHS optimizer placed the shifts`, 'ai');
  } else {
    g.claudePlan = { error: String((plan.reason && plan.reason.message) || plan.reason) };
    audit(`Claude backend call failed (${g.claudePlan.error}); the proposal was still generated locally`, 'ai');
  }
  g.result = res.status === 'fulfilled' ? res.value : runGeneration(g.site, g.month);
  g.running = false;
  saveOverlay();
  render();
}

/* ---------- generate view ---------- */

/* month-calendar preview of a generated proposal (assigned chips removable, OPEN chips fillable) */
function proposalChip(res, it) {
  const s = it.slot;
  const b = el('button', 'chip mini2 proposal' + (it.who ? '' : ' open'));
  b.type = 'button';
  b.style.setProperty('--site', siteColor(s.site));
  const need = slotRole(s.pos);
  if (it.who && (need === 'PHY' || need === 'APC')) b.classList.add('role-' + need.toLowerCase());
  b.append(el('span', 't', `${s.start}–${s.end}`));
  const who = el('span', 'who', it.who ? it.who.replace(/,.*$/, '') : 'OPEN');
  if (it.preferred) who.append(el('span', 'prefmark', ' ✓'));
  b.append(who);
  if (isPhone()) b.append(el('span', 'site', s.pos));
  if (it.who) {
    b.classList.add('editable');
    b.title = `${s.start}–${s.end} · ${s.pos} · ${it.who}${it.preferred ? ' · preferred day granted' : ''}\nClick to remove — the shift opens back up.`;
    b.onclick = () => confirmModal({
      title: 'Open up this shift?',
      body: `${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos}\n\nRemoves ${it.who} — the slot becomes OPEN.`,
      confirmLabel: 'Open it up',
      danger: true,
      onConfirm: () => {
        removeFromSlot(res, s);
        recomputeProposalDerived(res);
        state.gen.applied = false;
        saveOverlay();
        render();
      },
    });
  } else {
    b.classList.add('editable');
    b.title = `Open ${s.pos} · ${s.start}–${s.end}\nClick to assign someone.`;
    b.onclick = () => openSlotPicker(res, s);
  }
  return b;
}

function renderProposalCalendar(wrap, res) {
  const rf = state.gen.roleFilter;
  const box = el('div', 'reqform');
  box.append(el('h2', '', `Proposed schedule — ${siteName(res.site)}, ${fmtMonth(res.mo)}${rf ? (rf === 'PHY' ? ' — physicians only' : ' — APCs only') : ''}`));
  const legend = el('div', 'preflegend');
  const roleBtn = (role, label, cls) => {
    const b = el('button', 'chip mini2 legendchip clickable ' + cls + (rf === role ? ' on' : ''), label + (rf === role ? ' ✓' : ''));
    b.type = 'button';
    b.title = rf === role ? 'Show everyone again' : `Show only the ${label.replace(/s$/, '')} schedule`;
    b.onclick = () => { state.gen.roleFilter = rf === role ? null : role; render(); };
    return b;
  };
  legend.append(roleBtn('PHY', 'physicians', 'role-phy'));
  legend.append(roleBtn('APC', 'APCs', 'role-apc'));
  legend.append(el('span', 'chip mini2 open legendchip', 'still OPEN'));
  const pm = el('span', 'chip mini2 legendchip');
  pm.append(document.createTextNode('name '));
  pm.append(el('span', 'prefmark', '✓'));
  pm.append(document.createTextNode(' = preferred day granted'));
  legend.append(pm);
  legend.append(el('span', '', 'Click a role to filter · click a name to open the shift · click OPEN to fill it.'));
  box.append(legend);

  const keep = slot => !rf || slotRole(slot.pos) === rf || slotRole(slot.pos) === 'ANY';
  const byDay = new Map();
  const put = it => {
    const d = it.slot.date;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  };
  for (const a of res.assignments) if (keep(a.slot)) put({ slot: a.slot, who: a.who, preferred: a.preferred });
  for (const s of res.unfilled) if (keep(s)) put({ slot: s, who: '', preferred: false });

  if (isPhone()) {
    phoneMonthCal(box, res.mo, byDay, {
      detailChip: it => proposalChip(res, it),
      expandSet: state.gen.expanded,
      searchable: false,
      isOpen: it => !it.who,
      sort: (a, b) => a.slot.start.localeCompare(b.slot.start) || a.slot.pos.localeCompare(b.slot.pos),
      cellMarks: (iso, cell) => {
        const out = [];
        if (cell.length) out.push(el('span', 'cellcount', String(cell.length)));
        const openCount = cell.filter(it => !it.who).length;
        if (openCount) out.push(el('span', 'cellcount open', `${openCount} open`));
        return out;
      },
    });
    wrap.append(box);
    return;
  }

  const [y, m] = res.mo.split('-').map(Number);
  const table = el('table', 'bigcal');
  const hr = el('tr');
  for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) hr.append(el('th', '', d));
  table.append(hr);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(y, m, 0).getDate();
  let tr = el('tr');
  for (let i = 0; i < first.getUTCDay(); i++) tr.append(el('td', 'off'));
  for (let day = 1; day <= daysIn; day++) {
    const iso = `${res.mo}-${String(day).padStart(2, '0')}`;
    const td = el('td');
    const cell = (byDay.get(iso) || []).sort((a, b) =>
      a.slot.start.localeCompare(b.slot.start) || a.slot.pos.localeCompare(b.slot.pos));
    const dn = el('div', 'dn');
    dn.append(el('span', '', String(day)));
    const openCount = cell.filter(it => !it.who).length;
    if (openCount) dn.append(el('span', 'opendot', `${openCount} open`));
    td.append(dn);
    const expanded = state.gen.expanded.has(iso);
    const show = expanded ? cell : cell.slice(0, COLLAPSED_CHIPS);
    for (const it of show) td.append(proposalChip(res, it));
    if (cell.length > COLLAPSED_CHIPS) {
      const more = el('button', 'morebtn', expanded ? 'show less' : `+${cell.length - COLLAPSED_CHIPS} more`);
      more.onclick = () => {
        if (expanded) state.gen.expanded.delete(iso); else state.gen.expanded.add(iso);
        render();
      };
      td.append(more);
    }
    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  box.append(table);
  wrap.append(box);
}

function renderGenerate(main) {
  const g = state.gen;
  const months = ['2026-09', '2026-10', '2026-11', '2026-12'];
  if (!months.includes(g.month)) g.month = months[0];
  $('#weekStats').textContent = `${siteName(g.site)} · ${fmtMonth(g.month)}${g.result ? ` · proposal: ${g.result.assignments.length} of ${g.result.slots} slots filled` : ''}`;
  const wrap = el('div', 'reqwrap');

  const intro = el('div', 'reqform genintro');
  intro.append(el('h2', '', '✨ AI schedule generation'));
  intro.append(el('div', 'reqhint',
    'Collect requests → reconcile → draft → publish. The reconciliation engine runs live in this browser — days off are never violated, caps and rest rules hold, blocks stay together, night people stay on nights (time-of-day is learned from each provider\'s history), and each provider is targeted at their own average days worked over the last three months. In production the same loop runs through Claude\'s API, including emailing providers to collect requests and sending everyone their schedule.'));
  wrap.append(intro);

  renderScheduleChat(wrap);

  /* controls */
  const ctrl = el('div', 'reqform');
  const row = el('div', 'reqrow');
  const siteSel = document.createElement('select');
  for (const s of [...new Set(base.map(x => x.site).filter(Boolean))].sort((a, b) => siteName(a).localeCompare(siteName(b)))) {
    const o = el('option', '', `${siteName(s)}${EXAMPLE_SCHEDULING[s] ? ' ★' : ''}`);
    o.value = s;
    if (s === g.site) o.selected = true;
    siteSel.append(o);
  }
  siteSel.onchange = () => { g.site = siteSel.value; g.result = null; g.applied = false; g.showEmails = false; g.claudeTargets = null; g.claudePlan = null; render(); };
  const moSel = document.createElement('select');
  for (const m of months) {
    const o = el('option', '', fmtMonth(m));
    o.value = m;
    if (m === g.month) o.selected = true;
    moSel.append(o);
  }
  moSel.onchange = () => { g.month = moSel.value; g.result = null; g.applied = false; g.showEmails = false; g.claudeTargets = null; g.claudePlan = null; render(); };
  const lb = (t, i) => { const l = el('label', '', t + ' '); l.append(i); return l; };
  row.append(lb('Site (★ = example requests seeded)', siteSel), lb('Month', moSel));
  const goBtn = el('button', 'primary genbtn', g.running ? 'Generating…' : '✨ Generate Schedule');
  goBtn.disabled = g.running;
  goBtn.onclick = stageGenerate;
  row.append(goBtn);
  ctrl.append(row);
  if (g.running) {
    const st = el('div', 'genstatus', 'Starting…');
    st.id = 'genStatus';
    ctrl.append(st);
  }
  wrap.append(ctrl);

  /* requests on file */
  const reqs = requestsFor(g.site, g.month);
  const poolNames = new Set(poolFor(g.site, g.month).map(p => p.who));
  const visibleReqs = [...reqs.values()].filter(r => poolNames.has(r.who) || r.source === 'example');
  const reqBox = el('div', 'reqform');
  cardHeader(reqBox, `Requests on file — ${siteName(g.site)}, ${fmtMonth(g.month)} (${visibleReqs.length})`,
    '✎ Enter / modify requests', () => openRequestEditor());
  if (!visibleReqs.length) {
    reqBox.append(el('div', 'approval-empty', 'Nothing on file for this site/month. Use “Enter / modify requests” to add them here, or staff submit via the employee app. Example lists are seeded for NMMC-Tupelo ★ and DCH-Northport ★ in September.'));
  } else {
    const table = el('table', 'flat');
    table.innerHTML = '<thead><tr><th>Provider</th><th>Source</th><th>Requests</th></tr></thead>';
    const tb = el('tbody');
    for (const r of visibleReqs.sort((a, b) => a.who.localeCompare(b.who))) {
      const tr = el('tr');
      const tdName = el('td');
      const link = el('a', '', r.who);
      link.href = '#';
      link.title = 'Edit this provider’s requests';
      link.onclick = e => { e.preventDefault(); openRequestEditor(r.who); };
      tdName.append(link);
      tr.append(tdName);
      const tdS = el('td');
      const srcLabel = { example: 'example', assistant: 'assistant', edited: 'edited', submitted: 'submitted in-app' }[r.source] || r.source;
      tdS.append(el('span', 'srcpill src-' + r.source, srcLabel));
      tr.append(tdS);
      const parts = [];
      if (r.off.size) parts.push(`off: ${moShort(g.month)} ${fmtDayRanges(g.month, r.off)}`);
      if (r.prefer.size) parts.push(`prefers: ${moShort(g.month)} ${fmtDayRanges(g.month, r.prefer)}`);
      if (r.cap) parts.push(`max ${r.cap} shifts`);
      if (r.note) parts.push(`“${r.note}”`);
      tr.append(el('td', '', parts.join(' · ') || '—'));
      tb.append(tr);
    }
    table.append(tb);
    reqBox.append(table);
  }
  wrap.append(reqBox);

  renderAnalyzeCard(wrap);

  /* Opus 4.8's plan (when generated through the backend) */
  if (g.claudePlan) {
    const cp = el('div', 'reqform claudeplan');
    cardHeader(cp, '✦ Opus 4.8’s analysis', backendOn() ? '🔌 Claude connected' : null, backendOn() ? openBackendDialog : null);
    if (g.claudePlan.error) {
      cp.append(el('div', 'conflict', `⚠ Backend call failed: ${g.claudePlan.error}`));
      cp.append(el('div', 'reqhint', 'Fell back to the built-in engine below — the proposal is still valid. Check the Worker URL/key via 🔌 Connect Claude.'));
    } else {
      cp.append(el('div', 'claudeanalysis', g.claudePlan.analysis || ''));
      const notes = Array.isArray(g.claudePlan.notes) ? g.claudePlan.notes : (g.claudePlan.notes ? [String(g.claudePlan.notes)] : []);
      if (notes.length) {
        const ul = el('ul', 'ainotes');
        for (const n of notes) ul.append(el('li', '', n));
        cp.append(ul);
      }
      cp.append(el('div', 'reqhint', 'Opus 4.8 read the roster and requests and wrote this analysis; the HiGHS optimizer placed the shifts, so every hard rule holds by construction.'));
    }
    wrap.append(cp);
  }

  /* results */
  const res = g.result;
  if (res) {
    const kpis = el('div', 'kpirow');
    const pct = res.slots ? Math.round(res.assignments.length / res.slots * 100) : 0;
    kpis.append(kpi(`${pct}%`, `Slots filled (${res.assignments.length} of ${res.slots})`, pct >= 90 ? 'ok' : pct >= 60 ? '' : 'warn'));
    kpis.append(kpi(res.unfilled.length, 'Still open', res.unfilled.length ? 'warn' : 'ok'));
    kpis.append(kpi(res.offDays, 'Days-off honored (all of them)', 'ok'));
    kpis.append(kpi(`${res.preferGot}/${res.preferTotal}`, 'Preferred days granted', ''));
    wrap.append(kpis);

    wrap.append(el('div', 'reqhint enginebadge', res.engine === 'milp'
      ? `⚙ Placed by the HiGHS optimizer — mixed-integer model with ${res.solver.vars.toLocaleString()} decision variables and ${res.solver.rows.toLocaleString()} constraints, solved in-browser in ${(res.solver.ms / 1000).toFixed(1)}s (${res.solver.status === 'Optimal' ? 'proven optimal' : res.solver.status}).`
      : '⚙ Placed by the built-in greedy engine — instant preview; the HiGHS optimizer replaces it in the background when available.'));

    {
      const rr = el('div', 'refillrow');
      rr.append(el('span', 'reqhint', 'Refill touches ONLY open slots — nobody already placed moves, and whoever you removed from a shift is hard-blocked from getting it back. Full Generate resets everything.'));
      const rb = el('button', 'primary', g.refilling ? '⟲ Refilling…'
        : res.unfilled.length ? `⟲ Refill ${res.unfilled.length} open slot${res.unfilled.length === 1 ? '' : 's'}` : '⟲ Refill open slots');
      rb.type = 'button';
      rb.disabled = !!g.refilling || !res.unfilled.length;
      rb.title = res.unfilled.length
        ? 'Re-run the optimizer over ONLY the open slots. Everyone already placed stays exactly where they are — rest, run, and load rules still hold across the combination.'
        : 'Nothing open right now — remove a shift (click it in the calendar) or clear a provider (✕ below) first.';
      rb.onclick = () => refillOpenSlots();
      rr.append(rb);
      wrap.append(rr);
    }

    /* proposed month at a glance */
    renderProposalCalendar(wrap, res);

    /* AI notes */
    const notesBox = el('div', 'reqform');
    cardHeader(notesBox, 'AI notes on this proposal', '＋ Add rule', () => openRulesDialog());
    const ul = el('ul', 'ainotes');
    const bullet = t => ul.append(el('li', '', t));
    bullet(`Filled ${res.assignments.length} of ${res.slots} open slots (${pct}%).${res.skipped ? ` ${res.skipped} resident/student slots were left to the residency program.` : ''}`);
    const avgEx = [...res.stats.values()].filter(s => s.fromAvg && s.assigned).sort((a, b) => b.assigned - a.assigned)[0];
    bullet(`Each provider's target is their own average days worked per month, June–August${avgEx ? ` — e.g., ${avgEx.who.replace(/,.*$/, '')} averages ${avgEx.avg.toFixed(1)} days/month and is proposed for ${avgEx.assigned}` : ''}.`);
    bullet('Hard fairness rail: nobody is scheduled more than one shift above their average/target — requests shape which days you work, not how many.');
    const nightEx = [...res.stats.values()].find(s => {
      if (!s.assigned || !s.prof || s.prof.total < 8 || s.prof.night / s.prof.total < 0.9) return false;
      return res.assignments.filter(a => a.who === s.who).every(a => shiftBucket(a.slot) === 'night');
    });
    bullet(`Everyone keeps their usual time of day, learned from their history — a near-exclusive pattern is a hard rule, not a suggestion${nightEx ? ` (e.g., ${nightEx.who.replace(/,.*$/, '')} is ${Math.round(nightEx.prof.night / nightEx.prof.total * 100)}% nights historically and drew only night shifts)` : ''}.`);
    if (res.unfilled.length > 15) bullet(`Coverage gap: roughly ${Math.ceil(res.unfilled.length / 13)} more full-time providers are needed to fully cover ${siteName(res.site)} — a concrete number for recruiting.`);
    bullet(`Every requested day off was honored — the engine treats “unavailable” as a hard rule, never a suggestion.`);
    if (res.preferTotal) bullet(`${res.preferGot} of ${res.preferTotal} preferred days granted; the misses lost out to load balancing or one-shift-per-day.`);
    if (res.capsHit.length) bullet(`Shift caps held: ${res.capsHit.map(n => n.replace(/,.*$/, '')).join(', ')} stopped at their requested maximums.`);
    bullet(res.underFloor.length
      ? `⚠ Below their normal load (average − 1): ${res.underFloor.map(n => n.replace(/,.*$/, '')).join(', ')} — their days off, time-of-day pattern, or the open-shift mix left too few eligible shifts. Consider freeing shifts for them.`
      : `Everyone gets at least their average minus one — nobody's month falls below their normal load.`);
    const runners = [...res.stats.values()].filter(s => s.longestRun >= 3).sort((a, b) => b.longestRun - a.longestRun).slice(0, 2);
    for (const r of runners) bullet(`Block scheduling: ${r.who.replace(/,.*$/, '')} works up to ${r.longestRun} consecutive days rather than scattered singles.`);
    bullet(`At least 10 hours off between shifts — no mid-to-morning (e.g. 11:00–23:00 then a 06:00 start) and no night-to-day flips — and no stretches over ${res.maxRun} days, by rule.`);
    for (const r of [...res.reqs.values()].filter(r => r.note && !r.off.size && !r.prefer.size && !r.cap)) {
      bullet(`Noted but not auto-enforced: ${r.who.replace(/,.*$/, '')} — “${r.note}”.`);
    }
    notesBox.append(ul);
    wrap.append(notesBox);

    /* per-provider table */
    const provBox = el('div', 'reqform');
    provBox.append(el('h2', '', 'Proposed load by provider'));
    const pt = el('table', 'flat');
    pt.innerHTML = '<thead><tr><th>Provider</th><th>Role</th><th>Tier</th><th>Usual shift</th><th>Assigned</th><th>Target (3-mo avg)</th><th>Preferred days</th><th>Longest block</th></tr></thead>';
    const ptb = el('tbody');
    let anyPlanned = false;
    const rfNow = state.gen.roleFilter;
    for (const s of [...res.stats.values()].filter(s => (s.assigned || s.underFloor) && (!rfNow || s.role === rfNow || s.role === 'ANY')).sort((a, b) => b.assigned - a.assigned)) {
      const tr = el('tr');
      const tdN = el('td');
      if (s.assigned) {
        const cx = el('button', 'adjx clearprov', '✕');
        cx.type = 'button';
        cx.title = `Clear all ${s.assigned} of ${s.who.replace(/,.*$/, '')}'s proposed shifts — the slots reopen, then hit Refill to give them to others.`;
        cx.onclick = () => confirmModal({
          title: 'Clear this provider from the proposal?',
          body: `${s.who}\n\nRemoves all ${s.assigned} proposed shift${s.assigned === 1 ? '' : 's'} — those slots become OPEN and nobody else moves. “Refill open slots” gives them to OTHER providers; a full Generate brings this person back into play.`,
          confirmLabel: 'Clear them',
          danger: true,
          onConfirm: () => {
            clearProviderFromProposal(g.result, s.who);
            g.applied = false;
            saveOverlay();
            render();
          },
        });
        tdN.append(cx);
      }
      tdN.append(document.createTextNode(s.who));
      if (s.float) tdN.append(el('span', 'floatpill', 'float'));
      tr.append(tdN);
      tr.append(el('td', '', s.role));
      const tdT = el('td');
      const curTier = tierOf(s.who, s.float);
      const tierSel = document.createElement('select');
      tierSel.className = 'tiersel tier-' + curTier;
      for (const [k, label] of Object.entries(TIER_LABEL)) {
        const o = el('option', '', label);
        o.value = k;
        if (curTier === k) o.selected = true;
        tierSel.append(o);
      }
      tierSel.onchange = () => {
        overlay.tiers[s.who] = tierSel.value;
        audit(`${s.who} employment tier set to ${TIER_LABEL[tierSel.value]}`, 'ai');
        saveOverlay();
        rebuildProposal(g.site, g.month);
        render();
      };
      tdT.append(tierSel);
      tr.append(tdT);
      tr.append(el('td', '', s.tod ? ({ night: 'nights', day: 'days', eve: 'evenings' }[s.tod] + ' (rule)') : usualShift(s.prof)));
      const tdA = el('td', s.underFloor ? 'underfloor' : '', String(s.assigned));
      if (s.underFloor) { tdA.append(el('span', 'underfloor-tag', ` ⚠ below avg−1 (${s.dates.size}/${s.floor})`)); }
      tr.append(tdA);
      if (s.fromClaude) {
        tr.append(el('td', '', s.claudeClamped != null
          ? `${s.target} (Opus said ${s.claudeClamped} — raised to their average)`
          : `${s.target} (Opus)`));
      } else if (s.fromAvg) {
        tr.append(el('td', '', `${s.target} (avg ${s.avg.toFixed(1)})`));
      } else {
        anyPlanned = true;
        tr.append(el('td', '', `${s.target} *`));
      }
      tr.append(el('td', '', s.preferGot ? `✓ ${s.preferGot}` : '—'));
      tr.append(el('td', '', s.longestRun >= 2 ? `${s.longestRun} days` : '—'));
      ptb.append(tr);
    }
    pt.append(ptb);
    provBox.append(pt);
    if (anyPlanned) provBox.append(el('div', 'reqhint', '* no recent W2W history at this site (or float pool) — target comes from the planned demo roster instead of a worked average.'));
    wrap.append(provBox);

    /* actions */
    const act = el('div', 'reqform');
    const arow = el('div', 'reqrow');
    if (!g.applied) {
      const apply = el('button', 'primary genbtn', `Apply ${res.assignments.length} assignments as drafts`);
      apply.onclick = () => { applyGeneration(res); g.applied = true; render(); };
      arow.append(apply);
    } else {
      arow.append(el('span', 'okhint', `✓ Applied as drafts — publish from the Builder when ready`));
      const open = el('button', 'primary', 'Open Builder');
      open.onclick = () => { state.site = g.site; state.month = g.month; setView('builder'); };
      arow.append(open);
    }
    const mail = el('button', '', g.showEmails ? 'Hide email previews' : '📧 Preview provider emails');
    mail.onclick = () => { g.showEmails = !g.showEmails; render(); };
    arow.append(mail);
    act.append(arow);
    act.append(el('div', 'reqhint', 'Drafts stay invisible to staff until you Publish & notify in the Builder. Emails are previews — sending requires the production backend.'));
    wrap.append(act);

    /* email previews */
    if (g.showEmails) {
      const eb = el('div', 'reqform');
      eb.append(el('h2', '', 'Email previews — drafted by AI'));
      const renderEmail = (m, label) => {
        const card = el('div', 'emailcard');
        const head = el('div', 'emailhead');
        head.innerHTML = `<b>${label}</b> · To: ${m.to}<br>Subject: <b>${m.subject.replace(/</g, '&lt;')}</b>`;
        card.append(head, el('div', 'emailbody', m.body));
        return card;
      };
      eb.append(renderEmail(collectEmail(g.site, g.month), 'Request collection (sent before scheduling)'));
      const assigned = [...res.stats.values()].filter(s => s.assigned).sort((a, b) => b.assigned - a.assigned);
      for (const s of assigned.slice(0, 3)) eb.append(renderEmail(scheduleEmail(res, s.who), 'Schedule delivery'));
      if (assigned.length > 3) eb.append(el('div', 'reqhint', `…plus ${assigned.length - 3} more personalized schedule emails drafted, one per provider.`));
      wrap.append(eb);
    }
  }

  main.append(wrap);
}

/* ---------- shift dialog (draft editor) ---------- */

let dialogShift = null;

function updateSuggestions() {
  const f = $('#shiftForm');
  const box = $('#suggestBox');
  box.innerHTML = '';
  const pseudo = { id: dialogShift?.id || '·new·', date: f.date.value, site: f.site.value.trim(), start: f.start.value, end: f.end.value };
  if (!pseudo.date || !pseudo.site) return;
  const cands = suggestFor(pseudo, 8);
  if (!cands.length) return;
  box.append(el('div', 'sughead', `Good fits for ${pseudo.site} on ${fmtDate(pseudo.date)} — free that day, fewest shifts first`));
  for (const c of cands) {
    const btn = el('button', 'suggestbtn' + (c.likes ? ' likes' : ''));
    btn.type = 'button';
    btn.append(document.createTextNode(c.name.replace(/,.*$/, '') + ' '));
    btn.append(el('span', 'cnt', `(${c.count}${c.likes ? ' · prefers' : ''})`));
    btn.title = c.name;
    btn.onclick = () => { f.who.value = c.name; };
    box.append(btn);
  }
}

function openDialog(s, defaults) {
  dialogShift = s;
  const f = $('#shiftForm');
  $('#dialogTitle').textContent = s ? (s.draft ? 'Edit Shift (draft)' : 'Edit Shift') : 'Add Shift';
  $('#deleteShiftBtn').style.display = s ? '' : 'none';
  const v = s || { date: TODAY, start: '07:00', end: '19:00', who: '', site: '', note: '', pos: '', ...defaults };
  f.date.value = v.date; f.pos.value = v.pos; f.start.value = v.start; f.end.value = v.end;
  f.who.value = v.who; f.site.value = v.site; f.note.value = v.note;
  updateSuggestions();
  $('#shiftDialog').showModal();
}

function wireDialog() {
  const dlg = $('#shiftDialog');
  const f = $('#shiftForm');
  $('#cancelBtn').onclick = () => dlg.close();
  for (const name of ['date', 'site', 'start', 'end']) f[name].onchange = updateSuggestions;
  $('#deleteShiftBtn').onclick = () => {
    if (dialogShift && confirm('Remove this shift (as a draft change)?')) {
      draftRemove(dialogShift);
      audit(`Draft: removed ${describeShift(dialogShift)} (${dialogShift.who || 'OPEN'})`, 'edit');
      dlg.close();
      render();
    }
  };
  f.onsubmit = () => {
    const fields = {
      date: f.date.value, pos: f.pos.value.trim(), start: f.start.value, end: f.end.value,
      who: f.who.value.trim(), site: f.site.value.trim(), note: f.note.value.trim(),
    };
    if (dialogShift) {
      const before = { ...dialogShift };
      draftEdit(dialogShift, fields);
      const change = before.who !== fields.who ? ` (${before.who || 'OPEN'} → ${fields.who || 'OPEN'})` : '';
      audit(`Draft: edited ${describeShift({ ...before, ...fields })}${change}`, 'edit');
    } else {
      draftAdd(fields);
      audit(`Draft: added ${describeShift(fields)} (${fields.who || 'OPEN'})`, 'edit');
    }
    render();
  };
}

/* ---------- publish workflow ---------- */

function publishDraft() {
  const d = overlay.adminDraft;
  const total = draftCount();
  if (!total) return;
  const affected = new Map();
  const touch = (name, msg) => {
    if (!name) return;
    if (!affected.has(name)) affected.set(name, []);
    affected.get(name).push(msg);
  };
  const pub = new Map(publishedShifts().map(s => [s.id, s]));

  for (const [id, fields] of Object.entries(d.edits)) {
    const before = pub.get(id);
    if (!before) continue;
    const after = { ...before, ...fields };
    if (before.who && before.who !== after.who) touch(before.who, `no longer on ${describeShift(before)}`);
    if (after.who && after.who !== before.who) touch(after.who, `added to ${describeShift(after)}`);
    if (after.who && after.who === before.who &&
      (before.start !== after.start || before.end !== after.end || before.date !== after.date || before.site !== after.site || before.pos !== after.pos)) {
      touch(after.who, `changed: ${describeShift(before)} → ${describeShift(after)}`);
    }
    applyEditPublished(before, fields);
    audit(`Published edit — ${describeShift(after)}${before.who !== after.who ? ` (${before.who || 'OPEN'} → ${after.who || 'OPEN'})` : ''}`, 'publish');
  }
  for (const a of d.added) {
    overlay.added.push(a);
    if (a.who) touch(a.who, `added to ${describeShift(a)}`);
    audit(`Published new shift — ${describeShift(a)} (${a.who || 'OPEN'})`, 'publish');
  }
  for (const id of d.removed) {
    const before = pub.get(id);
    overlay.removed.push(id);
    if (before?.who) touch(before.who, `no longer on ${describeShift(before)}`);
    audit(`Published removal — ${before ? describeShift(before) : id}`, 'publish');
  }

  for (const [name, msgs] of affected) {
    pushNotif(name, `Schedule updated: ${msgs.slice(0, 3).join(' · ')}${msgs.length > 3 ? ` (+${msgs.length - 3} more)` : ''}`, 'month');
  }
  overlay.adminDraft = { edits: {}, added: [], removed: [] };
  audit(`Published ${total} change${total === 1 ? '' : 's'} — ${affected.size} ${affected.size === 1 ? 'person' : 'people'} notified`, 'publish');
  saveOverlay();
  render();
  alert(`Published ${total} change${total === 1 ? '' : 's'}. ${affected.size} ${affected.size === 1 ? 'person was' : 'people were'} notified in the employee app.`);
}

function renderPublishBar() {
  const bar = $('#publishBar');
  const n = draftCount();
  const show = n > 0 && (state.view === 'builder' || state.view === 'generate');
  bar.hidden = !show;
  if (!show) return;
  const d = overlay.adminDraft;
  $('#publishSummary').innerHTML = `<b>${n} draft change${n === 1 ? '' : 's'}</b> — staff can't see ${n === 1 ? 'it' : 'them'} yet (${Object.keys(d.edits).length} edited · ${d.added.length} added · ${d.removed.length} removed)`;
}

/* ---------- exports ---------- */

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const csvEsc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

function exportCsv() {
  if (state.view === 'generate' && state.gen.result) {
    const rows = [['Date', 'Start', 'End', 'Position', 'Site', 'AssignedTo', 'PreferredDay'].join(',')];
    for (const a of state.gen.result.assignments) {
      rows.push([a.slot.date, a.slot.start, a.slot.end, csvEsc(a.slot.pos), csvEsc(a.slot.site), csvEsc(a.who), a.preferred ? 'yes' : ''].join(','));
    }
    download(`ai-proposal-${state.gen.site}-${state.gen.month}.csv`, rows.join('\n'), 'text/csv');
    return;
  }
  if (state.view === 'reports') {
    const rows = [['Name', 'Shifts', 'Hours', 'Nights', 'WeekendDays', 'Sites'].join(',')];
    for (const p of fairnessRows(state.month).sort((a, b) => b.n - a.n)) {
      rows.push([csvEsc(p.name), p.n, Math.round(p.h), p.nights, p.wknd, csvEsc([...p.sites].sort().join(' '))].join(','));
    }
    download(`fairness-${state.month}.csv`, rows.join('\n'), 'text/csv');
    return;
  }
  if (state.view === 'audit') {
    const rows = [['Date', 'Kind', 'Action'].join(',')];
    for (const a of overlay.audit.slice().reverse()) rows.push([a.created, a.kind, csvEsc(a.text)].join(','));
    download('audit-log.csv', rows.join('\n'), 'text/csv');
    return;
  }
  let list;
  let name;
  if (state.view === 'coverage') {
    list = filtered(adminShifts()).filter(s => !s.who && s.date.startsWith(state.month));
    name = `open-shifts-${state.month}.csv`;
  } else {
    list = filtered(adminShifts()).filter(s => s.date.startsWith(state.month));
    name = `schedule-${state.month}.csv`;
  }
  const rows = [['Date', 'Start', 'End', 'Position', 'Site', 'Assigned', 'Note', 'Draft'].join(',')];
  for (const s of list.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))) {
    rows.push([s.date, s.start, s.end, csvEsc(s.pos), csvEsc(s.site), csvEsc(s.who), csvEsc(s.note), s.draft ? 'draft' : ''].join(','));
  }
  download(name, rows.join('\n'), 'text/csv');
}

/* ---------- notification bell ---------- */

let notifOpen = false;

function renderBell() {
  const list = managerNotifs();
  const unread = list.filter(n => !n.read).length;
  const badge = $('#bellCount');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  const panel = $('#notifPanel');
  panel.hidden = !notifOpen;
  if (!notifOpen) return;
  panel.innerHTML = '';
  panel.append(el('h3', '', 'Notifications — Scheduler'));
  if (!list.length) {
    panel.append(el('div', 'notifempty', 'Nothing yet. Staff submissions, claims, and messages land here.'));
    return;
  }
  for (const n of list.slice(0, 30)) {
    const item = el('button', 'notifitem' + (n.read ? '' : ' unread'));
    item.append(el('span', 'notiftext', n.text));
    item.append(el('span', 'notifdate', fmtDateLong(n.created)));
    item.onclick = () => {
      notifOpen = false;
      setView('approvals');
    };
    panel.append(item);
  }
}

function toggleBell() {
  notifOpen = !notifOpen;
  renderBell();
  if (notifOpen) {
    let dirty = false;
    for (const n of overlay.notifs) if (n.to === '' && !n.read) { n.read = true; dirty = true; }
    if (dirty) saveOverlay();
    $('#bellCount').hidden = true;
  }
}

/* ---------- chrome ---------- */

function renderBadges() {
  const { swaps, subs, msgs } = pendingCounts();
  const pend = swaps + subs + msgs;
  const bA = $('#badgeApprovals');
  bA.hidden = !pend;
  bA.textContent = String(pend);
  const opensMonth = publishedShifts().filter(s => !s.who && s.date >= TODAY && s.date.startsWith(TODAY.slice(0, 7))).length;
  const bC = $('#badgeCoverage');
  bC.hidden = !opensMonth;
  bC.textContent = String(opensMonth);
  const bB = $('#badgeBuilder');
  const n = draftCount();
  bB.hidden = !n;
  bB.textContent = String(n);
}

function shiftPeriod(n) {
  const months = monthList();
  const i = months.indexOf(state.month);
  state.month = months[Math.min(Math.max(i + n, 0), months.length - 1)];
  render();
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  const periodControls = v === 'coverage' || v === 'builder' || v === 'reports';
  $('#filterBar').querySelector('.weeknav').style.display = periodControls ? '' : 'none';
  render();
}

function wireChrome() {
  document.querySelectorAll('#viewTabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#prevWeek').onclick = () => shiftPeriod(-1);
  $('#nextWeek').onclick = () => shiftPeriod(1);
  $('#weekSelect').onchange = e => { state.month = e.target.value; render(); };
  $('#siteFilter').onchange = e => { state.site = e.target.value; state.pos = ''; render(); };
  $('#posFilter').onchange = e => { state.pos = e.target.value; render(); };
  $('#searchBox').oninput = e => { state.search = e.target.value; render(); };
  $('#exportCsvBtn').onclick = exportCsv;
  $('#printBtn').onclick = () => print();
  $('#bellBtn').onclick = toggleBell;
  document.addEventListener('click', e => {
    if (notifOpen && !e.target.closest('#notifPanel') && !e.target.closest('#bellBtn')) {
      notifOpen = false;
      renderBell();
    }
  });
  $('#publishBtn').onclick = () => {
    const n = draftCount();
    if (confirm(`Publish ${n} draft change${n === 1 ? '' : 's'}? Everyone affected gets a notification in the employee app.`)) publishDraft();
  };
  $('#discardDraftBtn').onclick = () => {
    const n = draftCount();
    if (!confirm(`Throw away ${n} draft change${n === 1 ? '' : 's'}? The published schedule is untouched.`)) return;
    overlay.adminDraft = { edits: {}, added: [], removed: [] };
    audit(`Discarded ${n} draft change${n === 1 ? '' : 's'}`, 'denial');
    saveOverlay();
    render();
  };
  $('#exportJsonBtn').onclick = () => {
    download('shiftboard-data.json', JSON.stringify({ shifts: adminShifts().map(s => [s.date, s.pos, s.start, s.end, s.who || null, s.site || null, s.note || null, s.id]) }, null, 1), 'application/json');
  };
  $('#resetBtn').onclick = () => {
    if (confirm('Discard ALL local demo changes — approvals, drafts, staff submissions, messages, and the audit log — and return to the imported schedule?')) {
      overlay = EMPTY_OVERLAY();
      saveOverlay();
      render();
    }
  };
}

/* ---------- render root ---------- */

function render() {
  renderFilterBar();
  renderDatalists();
  renderBadges();
  renderPublishBar();
  const main = $('#main');
  main.innerHTML = '';
  if (state.view === 'approvals') renderApprovals(main);
  else if (state.view === 'coverage') renderCoverage(main);
  else if (state.view === 'builder') renderBuilder(main);
  else if (state.view === 'reports') renderReports(main);
  else if (state.view === 'generate') renderGenerate(main);
  else renderAudit(main);
  renderBell();
}

(async function init() {
  await unlockData();
  wireChrome();
  wireDialog();
  setView('approvals');
  /* live cross-tab sync: employee-tab actions appear here without a refresh */
  window.addEventListener('storage', e => {
    if (e.key !== LS_KEY) return;
    readOverlayFromStorage();
    render();
  });
})();
