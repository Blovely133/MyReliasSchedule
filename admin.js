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
  genAdjust: [],   // structured ops from the "talk to the schedule" box
  genChat: [],     // its conversation log
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
  expandedDays: new Set(),
  repSort: { key: 'n', dir: -1 },
  gen: { site: 'TUP', month: '2026-09', result: null, running: false, applied: false, showEmails: false, expanded: new Set(), roleFilter: null, claudeTargets: null, claudeKey: null, claudePlan: null },
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
function isNight(s) { return s.start >= '18:00' || isOvernight(s); }
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
function backendCfg() { try { return JSON.parse(localStorage.getItem(BACKEND_KEY) || 'null'); } catch { return null; } }
function backendSet(cfg) { if (cfg && cfg.url) localStorage.setItem(BACKEND_KEY, JSON.stringify(cfg)); else localStorage.removeItem(BACKEND_KEY); }
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
   The reconciliation engine runs live in the browser (deterministic greedy
   with hard rules + scoring). Example request lists are seeded for NMMC-Tupelo
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

/* when Opus 4.8 produced per-provider targets for this exact site+month, use them */
function withClaudeTargets(pool, site, mo) {
  const ct = state.gen.claudeTargets;
  if (!ct || state.gen.claudeKey !== `${site}|${mo}`) return pool;
  return pool.map(p => ct.has(p.who) ? { ...p, target: ct.get(p.who), fromAvg: false, fromClaude: true } : p);
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
  const stats = new Map(pool.map(p => [p.who, { ...p, assigned: 0, preferGot: 0, dates: new Set(), shiftByDate: new Map(), prof: profiles.get(p.who) || null }]));
  for (const s of all) {
    if (!s.who || !s.date.startsWith(mo)) continue;
    const st = stats.get(s.who);
    if (st) { st.dates.add(s.date); st.shiftByDate.set(s.date, s); }
  }
  const assignments = [];
  const unfilled = [];
  const capsHit = new Set();
  for (const slot of slots) {
    const need = slotRole(slot.pos);
    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      if (need !== 'ANY' && p.role !== 'ANY' && p.role !== need) continue;
      const st = stats.get(p.who);
      const r = reqs.get(p.who);
      if (r && r.off.has(slot.date)) continue;                                   // hard: unavailable
      const cap = (r && r.cap) || p.target + 1;                                  // hard: never more than 1 over their average/target
      if (st.assigned >= cap) { if (r && r.cap) capsHit.add(p.who); continue; }
      if (st.dates.has(slot.date)) continue;                                     // hard: one shift/day
      const prevShift = st.shiftByDate.get(addDays(slot.date, -1));              // hard: ≥10h rest between shifts
      if (prevShift && absMin(slot.date, slot.start) - shiftEndMin(prevShift) < MIN_REST_MIN) continue;
      let run = 0;
      for (let k = 1; k <= maxRun; k++) { if (st.dates.has(addDays(slot.date, -k))) run++; else break; }
      if (run >= maxRun) continue;                                               // hard: max consecutive days (assistant-tunable, default 5)
      const bucket = shiftBucket(slot);
      if (st.tod) { if (bucket !== st.tod) continue; }                           // hard: assistant rule ("nights only")
      else if (st.prof && st.prof.total >= 8 && st.prof[bucket] / st.prof.total <= 0.05) continue;  // hard: never works this time of day
      let score = 0;
      if (!st.tod && st.prof && st.prof.total >= 4) score += Math.round((st.prof[bucket] / st.prof.total - 0.33) * 60);  // time-of-day affinity
      if (r && r.prefer.has(slot.date)) score += 100;                            // honor preferences
      if (st.dates.has(addDays(slot.date, -1))) score += 45;                     // build blocks
      score += p.float ? -8 : 12;                                                // regulars first
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
  for (const st of stats.values()) {
    let bestRun = 0;
    for (const d of st.dates) {
      if (st.dates.has(addDays(d, -1))) continue;
      let len = 1;
      while (st.dates.has(addDays(d, len))) len++;
      bestRun = Math.max(bestRun, len);
    }
    st.longestRun = bestRun;
  }
  const offDays = [...reqs.values()].reduce((a, r) => a + r.off.size, 0);
  const preferTotal = [...reqs.values()].reduce((a, r) => a + r.prefer.size, 0);
  const preferGot = [...stats.values()].reduce((a, s) => a + s.preferGot, 0);
  return { site, mo, slots: slots.length, skipped, assignments, unfilled, stats, reqs, offDays, preferTotal, preferGot, capsHit: [...capsHit], maxRun };
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

function stageGenerate() {
  if (backendOn()) return stageGenerateClaude();
  const g = state.gen;
  g.running = true; g.result = null; g.applied = false; g.showEmails = false; g.expanded = new Set();
  g.claudeTargets = null; g.claudeKey = null; g.claudePlan = null;
  render();
  const pool = poolFor(g.site, g.month);
  const reqs = requestsFor(g.site, g.month);
  const openCount = adminShifts().filter(s => s.site === g.site && s.date.startsWith(g.month) && !s.who && slotRole(s.pos) !== 'SKIP').length;
  const steps = [
    `Reading ${reqs.size} provider request${reqs.size === 1 ? '' : 's'}…`,
    `Scoring ${openCount.toLocaleString()} open slots against ${pool.length} providers…`,
    'Applying rest rules, shift caps, and block scheduling…',
    'Balancing load and honoring preferences…',
  ];
  let i = 0;
  const tick = () => {
    const elx = document.getElementById('genStatus');
    if (!elx) { g.running = false; return; }
    if (i < steps.length) { elx.textContent = steps[i++]; setTimeout(tick, 700); }
    else { g.result = runGeneration(g.site, g.month); g.running = false; render(); }
  };
  tick();
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
    g.result = runGeneration(g.site, g.month);
    g.applied = false;
    reply += ` Regenerated: ${g.result.assignments.length} of ${g.result.slots} slots filled.`;
  } else if (changed) {
    reply += ' It\'ll apply the next time you generate.';
  }
  return { reply, changed };
}

function renderScheduleChat(wrap) {
  const g = state.gen;
  const box = el('div', 'reqform genchat');
  const on = backendOn();
  cardHeader(box, '💬 Talk to the schedule', on ? '🔌 Claude connected' : '🔌 Connect Claude', openBackendDialog);
  box.append(el('div', 'reqhint', on
    ? 'Connected to Opus 4.8 — type roster and rule changes in plain English, any phrasing. Falls back to the in-browser parser if the backend is unreachable.'
    : 'Free-type roster and rule changes — new providers, removals, days off, caps, "nights only", or moves after generating. Parsed in-browser now; connect the Claude backend to run this on Opus 4.8.'));
  const log = el('div', 'chatlog');
  const msgs = overlay.genChat || [];
  if (!msgs.length) {
    log.append(el('div', 'chatmsg ai', 'Hi! Tell me about roster or rule changes in plain English — e.g. "We have a new physician, Dr. Sarah Chen, starting in September — nights only, about 12 shifts a month."'));
  }
  for (const m of msgs.slice(-20)) log.append(el('div', 'chatmsg ' + (m.from === 'you' ? 'you' : 'ai'), m.text));
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
      pushChat('ai', '…');
      g.chatFocus = true;
      saveOverlay();
      render();
      try {
        const ctx = { text, site: g.site, siteName: siteName(g.site), month: g.month,
          people: [...new Set(base.map(s => s.who).filter(Boolean))],
          pool: poolFor(g.site, g.month).map(p => ({ who: p.who, role: p.role, target: p.target, tod: p.tod || null })) };
        const data = await backendCall('/api/chat', ctx);
        const n = applyBackendOps(data.ops);
        overlay.genChat[overlay.genChat.length - 1].text = (data.reply || 'Done.') + (n && g.result ? ` (regenerated: ${(g.result = runGeneration(g.site, g.month)).assignments.length}/${g.result.slots})` : '');
      } catch (err) {
        overlay.genChat.pop();   // drop the "…" placeholder
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
        if (g.result) { g.result = runGeneration(g.site, g.month); g.applied = false; }
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
        if (g.result) { g.result = runGeneration(site, mo); g.applied = false; }
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
        if (g.result) { g.result = runGeneration(site, mo); g.applied = false; }
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
        if (g.result) { g.result = runGeneration(site, mo); g.applied = false; }
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
            if (g.result) { g.result = runGeneration(site, mo); g.applied = false; }
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

function removeFromSlot(res, slot) {
  const a = res.assignments.find(x => x.slot === slot);
  if (!a) return;
  const st = res.stats.get(a.who);
  if (st) { st.assigned--; st.dates.delete(slot.date); st.shiftByDate?.delete(slot.date); if (a.preferred) st.preferGot--; }
  res.assignments = res.assignments.filter(x => x !== a);
  res.unfilled.push(slot);
  audit(`Proposal edit: opened up ${describeShift(slot)} (was ${a.who})`, 'ai');
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
    body.append(el('div', 'reqhint', `${slot.pos} at ${siteName(slot.site)} — pick who works it. Clean fits are listed first; ⚠ ones break a rule but you can override.`));
    const cands = proposalCandidates(res, slot);
    const list = el('div', 'pickerlist');
    if (!cands.length) list.append(el('div', 'approval-empty', 'No one in the pool can take this slot. Add a provider from the rules dialog first.'));
    for (const c of cands.slice(0, 16)) {
      const row = el('button', 'pickeritem' + (c.warn || c.over ? ' warn' : ''));
      row.type = 'button';
      row.append(el('span', 'pickname', c.who));
      const meta = [`${c.assigned}/${c.target}`];
      if (c.over) meta.push('at cap');
      if (c.warn) meta.push('⚠ ' + c.warn);
      row.append(el('span', 'pickmeta', meta.join(' · ')));
      row.onclick = () => {
        addToSlot(res, slot, c.who);
        recomputeProposalDerived(res);
        state.gen.applied = false;
        saveOverlay();
        close();
        render();
      };
      list.append(row);
    }
    body.append(list);
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
      const disc = el('button', 'danger', 'Disconnect');
      disc.type = 'button';
      disc.onclick = () => { backendSet(null); close(); render(); };
      const save = el('button', 'primary', 'Save');
      save.type = 'button';
      save.onclick = () => { backendSet({ url: urlI.value.trim(), token: tokI.value.trim() }); close(); render(); };
      actions.append(disc, el('span', 'spacer'), test, save);
      body.append(actions);
    }
    paint();
  });
}

/* Opus-4.8-driven generation: Claude sets targets + writes the rationale, the
   deterministic engine places the shifts (all hard rules still guaranteed) */
async function stageGenerateClaude() {
  const g = state.gen;
  g.running = true; g.result = null; g.applied = false; g.showEmails = false; g.expanded = new Set();
  g.claudeTargets = null; g.claudeKey = null; g.claudePlan = null;
  render();
  const steps = ['Sending provider history and requests to Opus 4.8…', 'Opus 4.8 is reading the requests and setting targets…', 'Placing shifts with the rule engine…'];
  let i = 0;
  const tick = () => { const e = document.getElementById('genStatus'); if (e && i < steps.length) { e.textContent = steps[i++]; setTimeout(tick, 900); } };
  tick();
  try {
    const profiles = timeProfiles();
    const providers = poolFor(g.site, g.month).map(p => ({ who: p.who, role: p.role, avg: p.avg || 0, usual: usualShift(profiles.get(p.who)) }));
    const reqs = [...requestsFor(g.site, g.month).values()]
      .filter(r => providers.some(p => p.who === r.who) || r.source === 'example')
      .map(r => ({ who: r.who, off: [...r.off].filter(d => d.startsWith(g.month)).map(d => +d.slice(8)), prefer: [...r.prefer].filter(d => d.startsWith(g.month)).map(d => +d.slice(8)), cap: r.cap, note: r.note }));
    const openSlots = adminShifts().filter(s => s.site === g.site && s.date.startsWith(g.month) && !s.who && slotRole(s.pos) !== 'SKIP').length;
    const maxRun = (genAdjustFor(g.site).slice().reverse().find(a => a.kind === 'maxRun') || {}).value || 5;
    const data = await backendCall('/api/generate', {
      site: g.site, siteName: siteName(g.site), month: g.month, historyMonths: HIST_MONTHS.length,
      openSlots, providers, requests: reqs, rules: `no more than ${maxRun} consecutive days; at least 10h between shifts; keep night providers on nights`,
    });
    g.claudeTargets = new Map((data.targets || []).filter(t => t.who && t.target).map(t => [t.who, t.target]));
    g.claudeKey = `${g.site}|${g.month}`;
    g.claudePlan = { analysis: data.analysis, notes: data.notes || [], targetCount: (data.targets || []).length };
    g.result = runGeneration(g.site, g.month);
    audit(`Opus 4.8 generated the ${fmtMonth(g.month)} plan for ${siteName(g.site)} — ${g.claudePlan.targetCount} provider targets`, 'ai');
  } catch (err) {
    g.claudePlan = { error: String(err.message || err) };
    g.result = runGeneration(g.site, g.month);   // graceful fallback to the local engine
    audit(`Claude backend call failed (${String(err.message || err)}); used the built-in engine instead`, 'ai');
  }
  g.running = false;
  saveOverlay();
  render();
}

/* ---------- generate view ---------- */

/* month-calendar preview of a generated proposal (assigned chips removable, OPEN chips fillable) */
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
    for (const it of show) {
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
      if (it.who) {
        b.classList.add('editable');
        b.title = `${s.start}–${s.end} · ${s.pos} · ${it.who}${it.preferred ? ' · preferred day granted' : ''}\nClick to remove — the shift opens back up.`;
        b.onclick = () => {
          if (!confirm(`Open up this shift?\n\n${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos}\n\nRemoves ${it.who}; the slot becomes OPEN.`)) return;
          removeFromSlot(res, s);
          recomputeProposalDerived(res);
          state.gen.applied = false;
          saveOverlay();
          render();
        };
      } else {
        b.classList.add('editable');
        b.title = `Open ${s.pos} · ${s.start}–${s.end}\nClick to assign someone.`;
        b.onclick = () => openSlotPicker(res, s);
      }
      td.append(b);
    }
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
  const goBtn = el('button', 'primary genbtn', g.running ? 'Generating…' : (backendOn() ? '✨ Generate with Opus 4.8' : '✨ Generate schedule'));
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

  /* Opus 4.8's plan (when generated through the backend) */
  if (g.claudePlan) {
    const cp = el('div', 'reqform claudeplan');
    cardHeader(cp, '✦ Opus 4.8’s analysis', backendOn() ? '🔌 Claude connected' : null, backendOn() ? openBackendDialog : null);
    if (g.claudePlan.error) {
      cp.append(el('div', 'conflict', `⚠ Backend call failed: ${g.claudePlan.error}`));
      cp.append(el('div', 'reqhint', 'Fell back to the built-in engine below — the proposal is still valid. Check the Worker URL/key via 🔌 Connect Claude.'));
    } else {
      cp.append(el('div', 'claudeanalysis', g.claudePlan.analysis || ''));
      if (g.claudePlan.notes?.length) {
        const ul = el('ul', 'ainotes');
        for (const n of g.claudePlan.notes) ul.append(el('li', '', n));
        cp.append(ul);
      }
      cp.append(el('div', 'reqhint', `Opus 4.8 set ${g.claudePlan.targetCount} provider targets from the history and requests; the rule engine below placed the shifts so every hard rule holds.`));
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
    pt.innerHTML = '<thead><tr><th>Provider</th><th>Role</th><th>Usual shift</th><th>Assigned</th><th>Target (3-mo avg)</th><th>Preferred days</th><th>Longest block</th></tr></thead>';
    const ptb = el('tbody');
    let anyPlanned = false;
    const rfNow = state.gen.roleFilter;
    for (const s of [...res.stats.values()].filter(s => s.assigned && (!rfNow || s.role === rfNow || s.role === 'ANY')).sort((a, b) => b.assigned - a.assigned)) {
      const tr = el('tr');
      const tdN = el('td', '', s.who);
      if (s.float) tdN.append(el('span', 'floatpill', 'float'));
      tr.append(tdN);
      tr.append(el('td', '', s.role));
      tr.append(el('td', '', s.tod ? ({ night: 'nights', day: 'days', eve: 'evenings' }[s.tod] + ' (rule)') : usualShift(s.prof)));
      tr.append(el('td', '', String(s.assigned)));
      if (s.fromClaude) {
        tr.append(el('td', '', `${s.target} (Opus)`));
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
  const show = n > 0 && state.view === 'builder';
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
  $('#filterBar').querySelector('.weeknav').style.visibility = periodControls ? 'visible' : 'hidden';
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
