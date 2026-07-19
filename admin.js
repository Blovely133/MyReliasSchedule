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
});

let base = [];          // [{id,date,pos,start,end,who,site,note}]
let overlay = EMPTY_OVERLAY();
let state = {
  view: 'approvals',
  month: null,          // 'YYYY-MM' — every periodized view runs on months

  site: '',
  pos: '',
  search: '',
  covFocus: null,       // {site, date} — coverage detail panel
  expandedDays: new Set(),
  repSort: { key: 'n', dir: -1 },
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
  $('#dataNote').textContent = `Imported from WhenToWork · ${fmtDate(raw.range[0])} – ${fmtDate(raw.range[1])}`;
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
  kpis.append(kpi(opensMonth, 'Open shifts left this month', opensMonth ? 'warn' : 'ok', () => { state.covFocus = null; state.month = TODAY.slice(0, 7); setView('coverage'); }));
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
  kpis.append(kpi(draftPending, 'Draft changes awaiting publish', draftPending ? 'draftk' : ''));
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
  legend.append(el('span', '', 'Click any cell to see the day and fill gaps.'));
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
      if (state.covFocus && state.covFocus.site === site && state.covFocus.date === d) b.classList.add('focus');
      if (cell.length) {
        b.append(el('span', 'gapnum', open ? `${open} open` : '✓'));
        b.append(el('span', 'totnum', `${cell.length} shift${cell.length === 1 ? '' : 's'}`));
      } else b.append(el('span', 'totnum', '—'));
      b.title = `${covName(site)} · ${fmtDateLong(d)} — ${cell.length} shifts, ${open} unfilled`;
      b.onclick = () => { state.covFocus = { site, date: d }; render(); };
      td.append(b);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  main.append(wrap);

  /* --- day detail / gap-filling panel --- */
  if (state.covFocus && days.includes(state.covFocus.date)) {
    const { site, date } = state.covFocus;
    const cell = ((bySiteDay.get(site) || new Map()).get(date) || []).slice()
      .sort((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    const panel = el('div', 'reqform covdetail');
    const h = el('h2');
    h.append(document.createTextNode(`${site === '—' ? '(no site listed)' : siteName(site)} — ${fmtDateLong(date)}`));
    const addBtn = el('button', '', '＋ Add shift here');
    addBtn.onclick = () => openDialog(null, { date, site: site === '—' ? '' : site, pos: state.pos || '' });
    const closeBtn = el('button', 'closebtn', 'Close');
    closeBtn.onclick = () => { state.covFocus = null; render(); };
    h.append(addBtn, closeBtn);
    panel.append(h);
    if (!cell.length) panel.append(el('div', 'approval-empty', 'No shifts here this day yet.'));
    for (const s of cell) {
      const row = el('div', 'covshift' + (s.who ? '' : ' open') + (s.draft ? ' draft' : ''));
      row.style.setProperty('--site', siteColor(s.site));
      row.append(el('span', 't', `${s.start}–${s.end}`));
      row.append(el('span', 'p', s.pos));
      row.append(s.who ? el('span', '', s.who) : el('span', 'openlbl', 'OPEN'));
      if (s.draft) row.append(el('span', 'draftflag', 'draft'));
      const edit = el('button', '', 'Edit');
      edit.onclick = () => openDialog(s);
      row.append(edit);
      if (!s.who) {
        const sugg = el('span', 'suggestrow');
        const cands = suggestFor(s, 5);
        sugg.append(el('span', '', cands.length ? 'Fill with:' : 'No free site-regulars that day — open the editor to assign anyone.'));
        for (const c of cands) {
          const btn = el('button', 'suggestbtn' + (c.likes ? ' likes' : ''));
          btn.append(document.createTextNode(c.name.replace(/,.*$/, '') + ' '));
          btn.append(el('span', 'cnt', `(${c.count} this mo${c.likes ? ' · prefers' : ''})`));
          btn.title = `${c.name} — works this site, free ${fmtDate(s.date)}, ${c.count} shifts this month${c.likes ? ', marked "prefer to work"' : ''}`;
          btn.onclick = () => {
            draftEdit(s, { who: c.name });
            audit(`Draft: assigned ${c.name} to ${describeShift(s)}`, 'edit');
            render();
          };
          sugg.append(btn);
        }
        row.append(sugg);
      }
      panel.append(row);
    }
    main.append(panel);
  }
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
    const td = el('td', iso === TODAY ? 'today' : '');
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
  const show = n > 0 && (state.view === 'builder' || state.view === 'coverage');
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
  if (v !== 'coverage') state.covFocus = null;
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
