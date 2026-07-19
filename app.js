/* MyReliasSchedule — schedule viewer/editor seeded from WhenToWork data.
   Published base data lives in encrypted form; user changes are a localStorage
   overlay (edits/adds/deletes keyed by shift id) so the import stays pristine. */

const LS_KEY = 'shiftboard-overlay-v1';
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

let base = [];          // [{id,date,pos,start,end,who,site,note}]
/* full overlay shape — includes the scheduler console's keys (adminDraft, audit)
   so saves/resets from either surface never drop the other's data */
const DEFAULT_OVERLAY = () => ({ edits: {}, added: [], removed: [], requests: [], contacts: {}, messages: [], trades: [], prefs: {}, notifs: [], reqSubmissions: [], adminDraft: { edits: {}, added: [], removed: [] }, audit: [] });
let overlay = DEFAULT_OVERLAY();
let state = {
  view: 'month',
  weekStart: null,      // ISO date of a Sunday
  month: null,          // 'YYYY-MM'
  site: '',
  pos: '',
  search: '',
  person: 'Blake Lovely, MD',
  viewAs: 'Blake Lovely, MD',   // '' = everyone (full schedule)
  expandedDays: new Set(),
  reqSub: 'prefs',       // Requests hub section: 'prefs' | 'trades' | 'open'
  showEveryone: false,   // month/week in employee view: false = my shifts, true = everyone at my sites
};

/* ---------- notifications ---------- */
/* to === '' means the manager (Everyone mode) inbox */
let notifSeq = 0;
function pushNotif(to, text, view, sub) {
  overlay.notifs.push({ id: 'n' + Date.now() + '-' + (notifSeq++), to, text, view, sub: sub || null, created: TODAY, read: false });
  if (overlay.notifs.length > 200) overlay.notifs = overlay.notifs.slice(-200);
}
function myNotifs() {
  return overlay.notifs.filter(n => n.to === state.viewAs).slice().reverse();
}

/* Site codes → full facility names, from WhenToWork's category list */
const SITE_NAMES = {
  'Psych': 'Arise Psychiatry',
  'OCH': 'Baptist - Oktibbeha',
  'BSF': 'Big South Fork',
  'BMC': 'Bolivar Medical Center',
  'CaldHM': 'Caldwell HM',
  'CMC': 'Caldwell Medical Center',
  'REG': 'DCH Regional',
  'FAY': 'DCH-Fayette',
  'NOR': 'DCH-Northport',
  'EDU': 'Education',
  '(FG)': 'Forrest General',
  'FGOBS': 'Forrest General ED OBS',
  'GRMC': 'Great River Medical Center',
  'HKH': 'Helen Keller',
  'HCH': 'Highland Community Hospital',
  'JDCH': 'Jefferson Davis Community Hospital',
  'MGH': 'Marion General Hospital',
  'AMY': 'NMMC-Amory',
  'Amy Ho': 'NMMC-Amory Hosp',
  'EUP': 'NMMC-Eupora',
  'HAM': 'NMMC-Hamilton',
  'Ham HM': 'NMMC-Hamilton HM',
  'Pon HM': 'NMMC-Pont HM',
  'PON': 'NMMC-Pontotoc',
  'TUP': 'NMMC-Tupelo',
  'TUPED': 'NMMC-Tupelo ED Admit Delays',
  'WP': 'NMMC-West Point',
  'NRMC': 'Natchitoches',
  'NRMCHM': 'Natchitoches HM',
  'NGH HM': 'Neshoba HM',
  'OUCHAM': 'Ouch - Hamilton',
  'OUCTUP': 'Ouch - Tupelo',
  'PRCH': 'Pearl River County Hospital',
  'PCGH': 'Perry County General Hospital',
  'SMC': 'South Mississippi County',
  'McC': 'Southwest McComb',
  'St D': "St Dominic's",
  'SDHM': "St. Dominic's HM",
  'TeleH': 'TeleHealth',
  'WGH': 'Walthall General Hospital',
};
const siteName = code => SITE_NAMES[code] || code;

/* phone layout: month/week/swap render as agenda lists instead of 7-col grids */
const phoneMq = window.matchMedia('(max-width: 640px)');
const isPhone = () => phoneMq.matches;
phoneMq.addEventListener('change', () => { if (base.length) render(); });

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ---------- data ---------- */

const decodeBase64 = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));

async function decryptSchedule(pin) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable. Open this site over HTTPS or localhost.');
  const res = await fetch('data/schedule-data.enc.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the protected schedule (${res.status}).`);
  const payload = await res.json();
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: decodeBase64(payload.salt), iterations: payload.iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(payload.iv) },
    key,
    decodeBase64(payload.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(clear));
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
  $('#dataNote').textContent = `Imported from WhenToWork · ${fmtDate(raw.range[0])} – ${fmtDate(raw.range[1])}`;
  try { overlay = { ...DEFAULT_OVERLAY(), ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch {}
  if (!overlay.requests) overlay.requests = [];
  if (!overlay.contacts) overlay.contacts = {};
  if (!overlay.messages) overlay.messages = [];
  if (!overlay.trades) overlay.trades = [];
  if (!overlay.prefs) overlay.prefs = {};
  if (!overlay.notifs) overlay.notifs = [];
  if (!overlay.reqSubmissions) overlay.reqSubmissions = [];
}

function waitForPinAttempt() {
  return new Promise(resolve => {
    const form = $('#accessForm');
    form.onsubmit = event => {
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
        : 'That PIN did not unlock the schedule. Try again.';
      input.value = '';
      submit.disabled = false;
      submit.textContent = 'Open schedule';
      input.focus();
    }
  }
}

function saveOverlay() {
  localStorage.setItem(LS_KEY, JSON.stringify(overlay));
}

function shifts() {
  const removed = new Set(overlay.removed);
  const out = [];
  for (const s of base) {
    if (removed.has(s.id)) continue;
    out.push(overlay.edits[s.id] ? { ...s, ...overlay.edits[s.id], edited: true } : s);
  }
  for (const a of overlay.added) if (!removed.has(a.id)) out.push({ ...a, edited: true });
  return out;
}

function filtered(list) {
  return list.filter(s =>
    (!state.site || s.site === state.site) &&
    (!state.pos || s.pos === state.pos));
}

/* sites an employee actually works, derived from their shifts */
function employeeSites(name) {
  const set = new Set();
  for (const s of base) if (s.who === name && s.site) set.add(s.site);
  for (const a of overlay.added) if (a.who === name && a.site) set.add(a.site);
  return set;
}

/* in employee view: schedule views show only their shifts — or, with the
   "Show Everyone Working" toggle on, every shift (all roles) at their sites */
function scoped(list) {
  if (!state.viewAs) return list;
  if (state.showEveryone) {
    const mySites = employeeSites(state.viewAs);
    return mySites.size ? list.filter(s => s.site && mySites.has(s.site)) : list;
  }
  return list.filter(s => s.who === state.viewAs);
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
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function sundayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return addDays(iso, -dt.getUTCDay());
}
function hours(s) {
  const [sh, sm] = s.start.split(':').map(Number);
  const [eh, em] = s.end.split(':').map(Number);
  let h = (eh + em / 60) - (sh + sm / 60);
  if (h <= 0) h += 24;
  return h;
}

/* ---------- site colors ---------- */

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

function addProviderRoleClass(node, role) {
  if (role) node.classList.add('role-' + role.toLowerCase());
}

/* ---------- filter bar ---------- */

function weekList() {
  const dates = new Set(shifts().map(s => sundayOf(s.date)));
  return [...dates].sort();
}

function monthList() {
  const months = new Set(shifts().map(s => s.date.slice(0, 7)));
  return [...months].sort();
}

function fmtMonth(mo) {
  const [y, m] = mo.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderFilterBar() {
  const weeks = weekList();
  if (!state.weekStart) {
    state.weekStart = weeks.includes(sundayOf(TODAY)) ? sundayOf(TODAY) : weeks[0];
  }
  const months = monthList();
  if (!state.month) {
    state.month = months.includes(TODAY.slice(0, 7)) ? TODAY.slice(0, 7) : months[0];
  }
  const ws = $('#weekSelect');
  ws.innerHTML = '';
  if (state.view === 'month' || state.view === 'requests') {
    for (const mo of months) {
      const o = el('option', '', fmtMonth(mo));
      o.value = mo;
      if (mo === state.month) o.selected = true;
      ws.append(o);
    }
  } else {
    for (const w of weeks) {
      const o = el('option', '', `Week of ${fmtDate(w)}`);
      o.value = w;
      if (w === state.weekStart) o.selected = true;
      ws.append(o);
    }
  }
  const va = $('#viewAsSelect');
  const people = [...new Set(base.map(s => s.who).filter(Boolean))].sort();
  va.innerHTML = '<option value="">Everyone (full schedule)</option>';
  for (const p of people) {
    const o = el('option', '', p);
    o.value = p;
    if (p === state.viewAs) o.selected = true;
    va.append(o);
  }

  const mySites = state.viewAs ? employeeSites(state.viewAs) : null;
  const sf = $('#siteFilter');
  const sites = [...new Set(base.map(s => s.site).filter(Boolean))]
    .filter(s => !mySites || mySites.has(s))
    .sort((a, b) => siteName(a).localeCompare(siteName(b)));
  if (state.site && mySites && !mySites.has(state.site)) state.site = '';
  sf.innerHTML = `<option value="">${mySites ? 'All my sites' : 'All sites'}</option>`;
  for (const s of sites) {
    const o = el('option', '', `${siteName(s)} (${s})`);
    o.value = s;
    if (s === state.site) o.selected = true;
    sf.append(o);
  }
  /* scope toggle: only meaningful in employee view on month/week */
  const st = $('#scopeToggle');
  const toggleable = state.viewAs && (state.view === 'month' || state.view === 'week');
  st.hidden = !toggleable;
  if (toggleable) {
    st.textContent = state.showEveryone ? 'Show My Schedule Only' : 'Show Everyone Working';
    st.classList.toggle('on', state.showEveryone);
    st.title = state.showEveryone
      ? 'Back to just your shifts'
      : 'See everyone working at your sites — APCs and physicians';
    st.onclick = () => { state.showEveryone = !state.showEveryone; render(); };
  }

  const pf = $('#posFilter');
  let list = state.site ? base.filter(s => s.site === state.site) : base;
  if (state.viewAs) {
    if (state.showEveryone && (state.view === 'month' || state.view === 'week')) {
      const ms = employeeSites(state.viewAs);
      list = list.filter(s => s.site && ms.has(s.site));
    } else {
      list = list.filter(s => s.who === state.viewAs);
    }
  }
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
  const people = [...new Set(shifts().map(s => s.who).filter(Boolean))].sort();
  $('#peopleList').innerHTML = people.map(p => `<option value="${p.replace(/"/g, '&quot;')}">`).join('');
  const poss = [...new Set(base.map(s => s.pos))].sort();
  $('#posList').innerHTML = poss.map(p => `<option value="${p.replace(/"/g, '&quot;')}">`).join('');
  const sites = [...new Set(base.map(s => s.site).filter(Boolean))].sort();
  $('#siteList').innerHTML = sites.map(p => `<option value="${p}">`).join('');
}

/* ---------- week grid view ---------- */

function openShiftFromSchedule(s) {
  if (!state.viewAs) {
    openDialog(s);
    return;
  }
  openPersonDialog(s.who || '', s);
}

function chipFor(s, opts = {}) {
  const b = el('button', 'chip' + (s.who ? '' : ' open') + (s.edited ? ' edited' : ''));
  const isMine = Boolean(state.viewAs && s.who === state.viewAs);
  const role = providerRole(s);
  b.style.setProperty('--site', siteColor(s.site));
  addProviderRoleClass(b, role);
  const t = el('span', 't', `${s.start}–${s.end}`);
  const who = el('span', 'who', isMine ? s.who.replace(/,.*$/, '') : (s.who || 'OPEN'));
  b.append(t, who);
  /* agenda chips carry the position (grid views show it as the row header) */
  const metaParts = [];
  if (opts.showPos) metaParts.push(s.pos);
  if (s.site && (!opts.showPos || !s.pos.includes(s.site))) metaParts.push(s.site);
  if (!isMine) metaParts.push(role);
  const meta = (isMine && !opts.showPos) ? '' : metaParts.filter(Boolean).join(' · ');
  if (meta) b.append(el('span', 'site', meta));
  if (s.note && (!isMine || opts.showPos)) b.append(el('span', 'note', s.note));
  b.title = `${s.start}–${s.end} · ${s.pos} · ${s.who || 'OPEN'}${s.site ? ` · ${siteName(s.site)}` : ''}${s.note ? ` — ${s.note}` : ''}`;
  if (state.search && !matchesSearch(s, state.search.toLowerCase())) b.classList.add('dim');
  if (isMine) b.classList.add('my-shift');
  if (state.viewAs) b.classList.add(s.who && s.who !== state.viewAs ? 'coworker-shift' : 'readonly-shift');
  b.onclick = () => openShiftFromSchedule(s);
  return b;
}

/* ---------- phone agenda (stacked day cards instead of 7-col grids) ---------- */

const AGENDA_COLLAPSED = 4;

function renderAgenda(main, days, byDay, chipFn, opts = {}) {
  const collapse = opts.collapse || AGENDA_COLLAPSED;
  const wrap = el('div', 'agenda');
  const q = state.search.toLowerCase();
  for (const iso of days) {
    const cell = (byDay.get(iso) || []).slice()
      .sort((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    const pref = opts.prefFor ? opts.prefFor(iso) : null;
    if (!cell.length && !pref && opts.skipEmpty) continue;
    const card = el('div', 'aday' + (iso === TODAY ? ' today' : ''));
    const head = el('div', 'adayhead');
    head.append(el('span', 'adayname', fmtDateLong(iso)));
    if (iso === TODAY) head.append(el('span', 'todaytag', 'Today'));
    const openCount = cell.filter(s => !s.who).length;
    if (openCount) head.append(el('span', 'opendot', `${openCount} open`));
    card.append(head);
    if (pref === 'no') card.append(el('span', 'offday off-pending', 'marked off'));
    // with a search active, surface matching shifts instead of the first N
    const ordered = q
      ? [...cell].sort((a, b) => (matchesSearch(b, q) ? 1 : 0) - (matchesSearch(a, q) ? 1 : 0))
      : cell;
    const expanded = state.expandedDays.has(iso);
    const show = expanded ? ordered : ordered.slice(0, collapse);
    for (const s of show) card.append(chipFn(s));
    if (ordered.length > collapse) {
      const more = el('button', 'morebtn', expanded ? 'show less' : `+${ordered.length - collapse} more`);
      more.onclick = () => {
        if (expanded) state.expandedDays.delete(iso); else state.expandedDays.add(iso);
        render();
      };
      card.append(more);
    }
    if (!cell.length && pref !== 'no') card.append(el('div', 'anone', 'No shifts'));
    if (!state.viewAs && opts.addable) {
      const add = el('button', 'addbtn agenda-add', '+ add shift');
      add.onclick = () => openDialog(null, { date: iso, pos: state.pos || '', site: state.site || '' });
      card.append(add);
    }
    wrap.append(card);
  }
  if (!wrap.children.length) {
    main.append(el('div', 'empty', opts.emptyText || 'Nothing in this period.'));
    return;
  }
  main.append(wrap);
}

function monthDays(mo) {
  const [y, m] = mo.split('-').map(Number);
  const daysIn = new Date(y, m, 0).getDate();
  return Array.from({ length: daysIn }, (_, i) => `${mo}-${String(i + 1).padStart(2, '0')}`);
}

function prefMarkerFor(iso) {
  if (!state.viewAs) return null;
  return (overlay.prefs[state.viewAs] || {})[iso] === 'no' ? 'no' : null;
}

function renderWeek(main) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const list = scoped(filtered(shifts())).filter(s => s.date >= days[0] && s.date <= days[6]);

  const open = list.filter(s => !s.who).length;
  $('#weekStats').textContent = !state.viewAs
    ? `${list.length.toLocaleString()} shifts · ${open} open`
    : state.showEveryone
      ? `${list.length.toLocaleString()} shifts at my sites · ${open} open`
      : `${list.length} shifts · ${Math.round(list.reduce((a, s) => a + hours(s), 0))}h`;

  if (!list.length) {
    main.append(el('div', 'empty', 'No shifts match these filters this week.'));
    return;
  }

  if (isPhone()) {
    const byDay = new Map();
    for (const s of list) {
      if (!byDay.has(s.date)) byDay.set(s.date, []);
      byDay.get(s.date).push(s);
    }
    const mineOnly = state.viewAs && !state.showEveryone;
    renderAgenda(main, days, byDay, s => chipFor(s, { showPos: true }), {
      collapse: mineOnly ? Infinity : AGENDA_COLLAPSED,
      prefFor: prefMarkerFor,
      addable: true,
    });
    return;
  }

  const byPos = new Map();
  for (const s of list) {
    if (!byPos.has(s.pos)) byPos.set(s.pos, []);
    byPos.get(s.pos).push(s);
  }
  const positions = [...byPos.keys()].sort();

  const wrap = el('div', 'gridwrap');
  const table = el('table', 'sched');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'poscol', 'Position'));
  for (const d of days) {
    const th = el('th', d === TODAY ? 'today' : '', fmtDateLong(d));
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const pos of positions) {
    const tr = el('tr');
    tr.append(el('th', 'poscol', pos));
    for (const d of days) {
      const td = el('td', 'slot');
      const cell = byPos.get(pos).filter(s => s.date === d)
        .sort((a, b) => a.start.localeCompare(b.start));
      for (const s of cell) td.append(chipFor(s));
      if (!state.viewAs) {
        const add = el('button', 'addbtn', '+ add');
        add.onclick = () => openDialog(null, { date: d, pos, site: cell[0]?.site || state.site || '' });
        td.append(add);
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  main.append(wrap);
}

/* ---------- month view (default) ---------- */

const COLLAPSED_CHIPS = 6;

function matchesSearch(s, q) {
  return s.who.toLowerCase().includes(q) || s.pos.toLowerCase().includes(q) ||
    s.site.toLowerCase().includes(q) || siteName(s.site).toLowerCase().includes(q);
}

function miniChipFor(s) {
  const b = el('button', 'chip mini2' + (s.who ? '' : ' open') + (s.edited ? ' edited' : ''));
  const isMine = Boolean(state.viewAs && s.who === state.viewAs);
  const role = providerRole(s);
  b.style.setProperty('--site', siteColor(s.site));
  addProviderRoleClass(b, role);
  b.append(el('span', 't', `${s.start}–${s.end}`));
  const label = isMine ? s.who.replace(/,.*$/, '') : (s.who ? s.who.replace(/,.*$/, '') : 'OPEN');
  const meta = !isMine ? [s.site, role].filter(Boolean).join(' · ') : '';
  b.append(el('span', 'who', label + (meta ? ` · ${meta}` : '')));
  b.title = `${s.start}–${s.end} · ${s.pos} · ${s.who || 'OPEN'}${s.site ? ` · ${siteName(s.site)}` : ''}${s.note ? ` — ${s.note}` : ''}`;
  if (state.search && !matchesSearch(s, state.search.toLowerCase())) b.classList.add('dim');
  if (isMine) b.classList.add('my-shift');
  if (state.viewAs) b.classList.add(s.who && s.who !== state.viewAs ? 'coworker-shift' : 'readonly-shift');
  b.onclick = () => openShiftFromSchedule(s);
  return b;
}

function renderMonthAll(main) {
  const mo = state.month;
  const list = scoped(filtered(shifts())).filter(s => s.date.startsWith(mo));
  const open = list.filter(s => !s.who).length;
  const h = Math.round(list.reduce((a, s) => a + hours(s), 0));
  $('#weekStats').textContent = !state.viewAs
    ? `${fmtMonth(mo)} · ${list.length.toLocaleString()} shifts · ${open} open`
    : state.showEveryone
      ? `${fmtMonth(mo)} · ${list.length.toLocaleString()} shifts at my sites · ${open} open`
      : `${fmtMonth(mo)} · ${list.length} shifts · ${h}h`;

  const byDay = new Map();
  for (const s of list) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }

  if (isPhone()) {
    const mineOnly = state.viewAs && !state.showEveryone;
    renderAgenda(main, monthDays(mo), byDay, s => chipFor(s, { showPos: true }), {
      collapse: mineOnly ? Infinity : AGENDA_COLLAPSED,
      skipEmpty: mineOnly,
      prefFor: prefMarkerFor,
      addable: true,
      emptyText: `No shifts for this view in ${fmtMonth(mo)}.`,
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
    const td = el('td', iso === TODAY ? 'today' : '');
    const cell = (byDay.get(iso) || []).sort((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    const dn = el('div', 'dn');
    dn.append(el('span', '', String(day)));
    const openCount = cell.filter(s => !s.who).length;
    if (openCount) dn.append(el('span', 'opendot', `${openCount} open`));
    td.append(dn);

    if (state.viewAs) {
      const pref = (overlay.prefs[state.viewAs] || {})[iso];
      if (pref === 'no') td.append(el('span', 'offday off-pending', 'marked off'));
    }

    const expanded = state.expandedDays.has(iso);
    const q = state.search.toLowerCase();
    // with a search active, surface matching shifts instead of the first N
    const ordered = q
      ? [...cell].sort((a, b) => (matchesSearch(b, q) ? 1 : 0) - (matchesSearch(a, q) ? 1 : 0))
      : cell;
    const show = expanded ? ordered : ordered.slice(0, COLLAPSED_CHIPS);
    for (const s of show) td.append(miniChipFor(s));
    if (ordered.length > COLLAPSED_CHIPS) {
      const more = el('button', 'morebtn', expanded ? 'show less' : `+${ordered.length - COLLAPSED_CHIPS} more`);
      more.onclick = () => {
        if (expanded) state.expandedDays.delete(iso); else state.expandedDays.add(iso);
        render();
      };
      td.append(more);
    }
    if (!state.viewAs) {
      const add = el('button', 'addbtn', '+ add');
      add.onclick = () => openDialog(null, { date: iso, pos: state.pos || '', site: state.site || '' });
      td.append(add);
    }

    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  main.append(table);
}

/* ---------- contact view ---------- */

function renderContact(main) {
  const mine = state.viewAs;
  const msgs = overlay.messages.filter(m => !m.to && (!mine || m.who === mine)).slice().sort((a, b) => b.id.localeCompare(a.id));
  const directMsgs = mine
    ? overlay.messages.filter(m => m.to && (m.who === mine || m.to === mine)).slice().sort((a, b) => b.id.localeCompare(a.id))
    : [];
  const totalMessages = msgs.length + directMsgs.length;
  const waiting = msgs.filter(m => !m.replies.length).length + directMsgs.filter(m => {
    const lastFrom = m.replies.length ? m.replies[m.replies.length - 1].from : m.who;
    return lastFrom === mine;
  }).length;
  $('#weekStats').textContent = `${totalMessages} message${totalMessages === 1 ? '' : 's'} · ${waiting} awaiting reply`;

  const wrap = el('div', 'reqwrap');

  /* --- how we reach you --- */
  if (mine) {
    const card = el('form', 'reqform');
    card.append(el('h2', '', `How we reach you — ${mine}`));
    const saved = overlay.contacts[mine] || {};
    const row = el('div', 'reqrow');
    const emailInp = el('input');
    emailInp.type = 'email';
    emailInp.placeholder = 'you@example.com';
    emailInp.value = saved.email || '';
    const phoneInp = el('input');
    phoneInp.type = 'tel';
    phoneInp.placeholder = '(555) 555-5555';
    phoneInp.value = saved.phone || '';
    const prefSel = document.createElement('select');
    for (const p of ['Text', 'Call', 'Email']) {
      const o = el('option', '', p);
      if ((saved.pref || 'Text') === p) o.selected = true;
      prefSel.append(o);
    }
    const lb = (txt, inp) => { const l = el('label', '', txt + ' '); l.append(inp); return l; };
    row.append(lb('Email', emailInp), lb('Phone', phoneInp), lb('Prefer', prefSel));
    const save = el('button', 'primary', 'Save');
    save.type = 'submit';
    row.append(save);
    card.append(row);
    const note = el('div', 'reqhint', saved.email || saved.phone ? 'On file. Update any time.' : 'Nothing on file yet — add how the scheduler should reach you.');
    card.append(note);
    card.onsubmit = e => {
      e.preventDefault();
      overlay.contacts[mine] = { email: emailInp.value.trim(), phone: phoneInp.value.trim(), pref: prefSel.value };
      saveOverlay();
      note.textContent = 'Saved ✓';
    };
    wrap.append(card);
  } else {
    // manager mode: directory of everyone who has shared contact info
    const names = Object.keys(overlay.contacts).filter(n => overlay.contacts[n].email || overlay.contacts[n].phone).sort();
    const card = el('div', 'reqform');
    card.append(el('h2', '', 'Contact directory'));
    if (!names.length) {
      card.append(el('div', 'reqhint', 'No one has shared contact info yet. Each person adds theirs from their own Employee view.'));
    } else {
      const table = el('table', 'flat');
      table.innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Prefers</th></tr></thead>';
      const tb = el('tbody');
      for (const n of names) {
        const c = overlay.contacts[n];
        const tr = el('tr');
        tr.append(el('td', '', n), el('td', '', c.email || '—'), el('td', '', c.phone || '—'), el('td', '', c.pref || '—'));
        tb.append(tr);
      }
      table.append(tb);
      card.append(table);
    }
    wrap.append(card);
  }

  /* --- coworker messages --- */
  if (mine) {
    const coworkerBox = el('div', 'reqform');
    coworkerBox.append(el('h2', '', 'Coworker messages'));
    if (!directMsgs.length) {
      coworkerBox.append(el('div', 'reqhint', 'No coworker messages yet. Click a name in People or a coworker shift to start one.'));
    } else {
      const directList = el('div', 'msglist');
      for (const m of directMsgs) {
        const item = el('div', 'msg');
        const head = el('div', 'msghead');
        const from = m.who === mine ? 'You' : m.who;
        const to = m.to === mine ? 'you' : m.to;
        head.append(el('b', '', `${from} → ${to}`));
        head.append(el('span', '', fmtDateLong(m.created)));
        item.append(head, el('div', 'msgtext', m.text));
        for (const r of m.replies) {
          const rep = el('div', 'msgreply');
          rep.append(el('b', '', (r.from === mine ? 'You' : r.from) + ': '));
          rep.append(document.createTextNode(r.text));
          item.append(rep);
        }
        const lastFrom = m.replies.length ? m.replies[m.replies.length - 1].from : m.who;
        if (lastFrom !== mine) {
          const rform = el('form', 'replyform');
          const rin = el('input');
          rin.placeholder = 'Reply…';
          rin.required = true;
          const rbtn = el('button', 'primary', 'Reply');
          rbtn.type = 'submit';
          rform.append(rin, rbtn);
          rform.onsubmit = e => {
            e.preventDefault();
            m.replies.push({ from: mine, text: rin.value.trim(), created: TODAY });
            const other = m.who === mine ? m.to : m.who;
            pushNotif(other, `${mine} replied to your message`, 'contact');
            saveOverlay();
            render();
          };
          item.append(rform);
        }
        directList.append(item);
      }
      coworkerBox.append(directList);
    }
    wrap.append(coworkerBox);
  }

  /* --- contact us / inbox --- */
  const box = el('div', 'reqform');
  box.append(el('h2', '', mine ? 'Contact the scheduler' : 'Message inbox'));
  if (mine) {
    const form = el('form');
    const ta = document.createElement('textarea');
    ta.className = 'msgbox';
    ta.placeholder = 'Type your message… (schedule questions, availability notes, anything)';
    ta.required = true;
    const send = el('button', 'primary', 'Send message');
    send.type = 'submit';
    form.append(ta, send);
    form.onsubmit = e => {
      e.preventDefault();
      overlay.messages.push({ id: 'm' + Date.now(), who: mine, text: ta.value.trim(), created: TODAY, replies: [] });
      pushNotif('', `New message from ${mine}`, 'contact');
      saveOverlay();
      render();
    };
    box.append(form);
  }

  if (!msgs.length) {
    box.append(el('div', 'reqhint', mine ? 'No messages yet.' : 'No messages from staff yet.'));
  } else {
    const list = el('div', 'msglist');
    for (const m of msgs) {
      const item = el('div', 'msg');
      const head = el('div', 'msghead');
      head.append(el('b', '', mine ? 'You' : m.who));
      head.append(el('span', '', fmtDateLong(m.created)));
      if (!m.replies.length) head.append(el('span', 'req-badge req-pending', 'awaiting reply'));
      item.append(head);
      item.append(el('div', 'msgtext', m.text));
      for (const r of m.replies) {
        const rep = el('div', 'msgreply');
        rep.append(el('b', '', r.from + ': '));
        rep.append(document.createTextNode(r.text));
        item.append(rep);
      }
      if (!mine) {
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
          saveOverlay();
          render();
        };
        item.append(rform);
      }
      list.append(item);
    }
    box.append(list);
  }
  wrap.append(box);
  main.append(wrap);
}

function isOvernight(s) { return s.end <= s.start; }

/* ---------- trade board ---------- */

function shiftById(id) {
  return shifts().find(s => s.id === id) || null;
}

function tradeShiftLabel(s) {
  return s ? `${fmtDateLong(s.date)} · ${s.start}–${s.end} · ${s.pos} (${s.site || '—'})` : '(shift no longer exists)';
}

function renderTrades(main) {
  const mine = state.viewAs;
  const trades = overlay.trades.slice().sort((a, b) => b.id.localeCompare(a.id));
  const open = trades.filter(t => t.status === 'open').length;
  const proposed = trades.filter(t => t.status === 'proposed').length;
  const claimed = trades.filter(t => t.status === 'claimed').length;
  $('#weekStats').textContent = `${open} offered · ${proposed} direct · ${claimed} awaiting approval`;

  const wrap = el('div', 'reqwrap');

  if (mine) {
    /* offer one of my upcoming shifts */
    const form = el('form', 'reqform');
    form.append(el('h2', '', 'Offer a shift for trade'));
    const posted = new Set(trades.filter(t => ['open', 'proposed', 'claimed'].includes(t.status)).map(t => t.shiftId));
    const eligible = shifts().filter(s => s.who === mine && s.date >= TODAY && !posted.has(s.id))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!eligible.length) {
      form.append(el('div', 'reqhint', 'No upcoming shifts available to offer.'));
    } else {
      const row = el('div', 'reqrow');
      const sel = document.createElement('select');
      sel.className = 'growsel';
      for (const s of eligible) {
        const o = el('option', '', tradeShiftLabel(s));
        o.value = s.id;
        sel.append(o);
      }
      const noteInp = el('input');
      noteInp.placeholder = 'Note (optional) — e.g. "can swap for any August night"';
      noteInp.className = 'grow';
      const lb = (txt, inp) => { const l = el('label', '', txt + ' '); l.append(inp); return l; };
      const selLabel = lb('Shift', sel); selLabel.className = 'growlabel';
      const noteLabel = lb('Note', noteInp);
      row.append(selLabel, noteLabel);
      const btn = el('button', 'primary', 'Post to trade board');
      btn.type = 'submit';
      row.append(btn);
      form.append(row);
      form.onsubmit = e => {
        e.preventDefault();
        overlay.trades.push({ id: 't' + Date.now(), shiftId: sel.value, who: mine, note: noteInp.value.trim(), claimedBy: null, status: 'open', created: TODAY });
        pushNotif('', `${mine} offered a shift for trade`, 'requests', 'trades');
        saveOverlay();
        render();
      };
    }
    wrap.append(form);
  }

  const mySites = mine ? employeeSites(mine) : null;
  const visible = trades.filter(t => {
    if (!mine) return true;
    if (t.who === mine || t.claimedBy === mine || t.targetWho === mine) return true;
    if (t.status !== 'open') return false;
    const s = shiftById(t.shiftId);
    return s && (!mySites.size || mySites.has(s.site));
  });

  const box = el('div', 'reqform');
  box.append(el('h2', '', mine ? 'Trade board — my offers & pickups at my sites' : 'Trade board'));
  if (!visible.length) {
    box.append(el('div', 'reqhint', 'Nothing on the trade board right now.'));
  } else {
    const table = el('table', 'flat');
    table.innerHTML = '<thead><tr><th>Offered shift</th><th>Requested shift</th><th>Offered by</th><th>Note</th><th>To / claimed by</th><th>Status</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const t of visible) {
      const s = shiftById(t.shiftId);
      const requested = shiftById(t.requestedShiftId);
      const tr = el('tr');
      tr.append(el('td', '', tradeShiftLabel(s)));
      tr.append(el('td', '', requested ? tradeShiftLabel(requested) : '—'));
      tr.append(el('td', '', t.who));
      tr.append(el('td', '', t.note || '—'));
      tr.append(el('td', '', t.targetWho || t.claimedBy || '—'));
      const tdS = el('td');
      const badgeClass = { open: 'req-pending', proposed: 'req-pending', claimed: 'req-pending', approved: 'req-approved', denied: 'req-denied', cancelled: 'req-denied' }[t.status];
      tdS.append(el('span', 'req-badge ' + badgeClass, t.status));
      tr.append(tdS);
      const tdA = el('td');
      if (mine && t.status === 'open' && t.who !== mine && s) {
        const claim = el('button', 'primary', 'Claim');
        claim.onclick = () => {
          t.claimedBy = mine;
          t.status = 'claimed';
          pushNotif(t.who, `${mine} claimed your ${fmtDate(s.date)} shift — awaiting approval`, 'requests', 'trades');
          pushNotif('', `${mine} claimed ${t.who}'s ${fmtDate(s.date)} shift — needs approval`, 'requests', 'trades');
          saveOverlay(); render();
        };
        tdA.append(claim);
      }
      if (mine && t.who === mine && ['open', 'proposed', 'claimed'].includes(t.status)) {
        const cancel = el('button', 'danger', 'Withdraw');
        cancel.onclick = () => { t.status = 'cancelled'; saveOverlay(); render(); };
        tdA.append(cancel);
      }
      if (!mine && t.status === 'claimed' && s) {
        const ok = el('button', '', 'Approve');
        ok.onclick = () => {
          applyEdit(s, { who: t.targetWho || t.claimedBy });
          if (requested && t.targetWho) applyEdit(requested, { who: t.who });
          t.status = 'approved';
          pushNotif(t.who, `Trade approved: your ${fmtDate(s.date)} swap is complete`, 'requests', 'swap');
          pushNotif(t.targetWho || t.claimedBy, `Trade approved: you now work ${fmtDate(s.date)} ${s.start}–${s.end} at ${s.site}`, 'requests', 'swap');
          saveOverlay(); render();
        };
        const no = el('button', 'danger', 'Deny');
        no.onclick = () => {
          pushNotif(t.targetWho || t.claimedBy, `Trade denied for ${t.who}'s ${fmtDate(s.date)} shift`, 'requests', 'swap');
          t.status = t.targetWho ? 'denied' : 'open';
          t.claimedBy = null;
          saveOverlay(); render();
        };
        tdA.append(ok, no);
      }
      tr.append(tdA);
      tb.append(tr);
    }
    table.append(tb);
    box.append(table);
  }
  wrap.append(box);
  main.append(wrap);
}

/* ---------- work preferences ---------- */

const PREF_CYCLE = [null, 'like', 'dislike', 'no'];
const PREF_LABEL = { like: '✓ prefer', dislike: '~ rather not', no: '✕ unavailable' };

function renderPrefs(main) {
  const mine = state.viewAs;
  const mo = state.month;
  const prefs = overlay.prefs;

  if (mine && !prefs[mine]) prefs[mine] = {};
  const monthPrefs = [];
  for (const [name, days] of Object.entries(prefs)) {
    for (const [iso, v] of Object.entries(days)) {
      if (iso.startsWith(mo) && v) monthPrefs.push({ name, iso, v });
    }
  }
  $('#weekStats').textContent = mine
    ? `${fmtMonth(mo)} · click a day to cycle: prefer → rather not → unavailable → clear`
    : `${fmtMonth(mo)} · ${monthPrefs.length} preference${monthPrefs.length === 1 ? '' : 's'} marked by staff`;

  if (mine) {
    const legend = el('div', 'preflegend');
    legend.append(el('span', 'prefchip pref-like', '✓ prefer to work'));
    legend.append(el('span', 'prefchip pref-dislike', '~ rather not'));
    legend.append(el('span', 'prefchip pref-no', '✕ unavailable'));
    legend.append(el('span', '', 'These are visible to the scheduler before the next schedule is built.'));
    main.append(legend);
  }

  const [y, m] = mo.split('-').map(Number);
  const table = el('table', 'bigcal prefcal');
  const hr = el('tr');
  const dayNames = isPhone()
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const d of dayNames) hr.append(el('th', '', d));
  table.append(hr);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(y, m, 0).getDate();
  let tr = el('tr');
  for (let i = 0; i < first.getUTCDay(); i++) tr.append(el('td', 'off'));
  for (let day = 1; day <= daysIn; day++) {
    const iso = `${mo}-${String(day).padStart(2, '0')}`;
    const td = el('td', iso === TODAY ? 'today' : '');
    td.append(el('div', 'dn', String(day)));
    if (mine) {
      const v = prefs[mine][iso] || null;
      if (v) td.append(el('span', 'prefchip pref-' + v, isPhone() ? PREF_LABEL[v].split(' ')[0] : PREF_LABEL[v]));
      const scheduled = shifts().some(s => s.who === mine && s.date === iso);
      if (scheduled) td.append(el('span', 'prefsched', isPhone() ? 'sched' : 'scheduled'));
      td.classList.add('clickable');
      td.onclick = () => {
        const next = PREF_CYCLE[(PREF_CYCLE.indexOf(v) + 1) % PREF_CYCLE.length];
        if (next) prefs[mine][iso] = next; else delete prefs[mine][iso];
        saveOverlay();
        render();
      };
    } else {
      for (const p of monthPrefs.filter(p => p.iso === iso)) {
        const chip = el('span', 'prefchip pref-' + p.v, `${p.name.replace(/,.*$/, '')} ${PREF_LABEL[p.v].split(' ')[0]}`);
        chip.title = `${p.name} — ${PREF_LABEL[p.v]}`;
        td.append(chip);
      }
    }
    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  main.append(table);

  /* --- submit to scheduler --- */
  const subs = overlay.reqSubmissions.filter(s => !mine || s.who === mine).slice().sort((a, b) => b.id.localeCompare(a.id));
  if (mine) {
    const bar = el('div', 'submitbar');
    const btn = el('button', 'primary', 'Submit requests to scheduler');
    btn.onclick = () => {
      const marks = Object.entries(prefs[mine] || {}).filter(([iso, v]) => iso.startsWith(mo) && v);
      if (!marks.length) { alert(`Nothing marked for ${fmtMonth(mo)} yet — click days on the calendar first.`); return; }
      const count = k => marks.filter(([, v]) => v === k).length;
      const parts = [];
      if (count('no')) parts.push(`${count('no')} unavailable`);
      if (count('dislike')) parts.push(`${count('dislike')} rather not`);
      if (count('like')) parts.push(`${count('like')} prefer to work`);
      overlay.reqSubmissions.push({ id: 's' + Date.now(), who: mine, month: mo, summary: parts.join(', '), created: TODAY });
      pushNotif('', `${mine} submitted ${fmtMonth(mo)} requests: ${parts.join(', ')}`, 'requests', 'prefs');
      saveOverlay();
      render();
    };
    bar.append(btn);
    main.append(bar);
  }
  if (subs.length) {
    const box = el('div', 'reqform');
    box.append(el('h2', '', mine ? 'My submitted requests' : 'Submitted requests from staff'));
    const table2 = el('table', 'flat');
    table2.innerHTML = `<thead><tr>${mine ? '' : '<th>Employee</th>'}<th>Month</th><th>Requests</th><th>Submitted</th></tr></thead>`;
    const tb = el('tbody');
    for (const s of subs.slice(0, 20)) {
      const tr2 = el('tr');
      if (!mine) tr2.append(el('td', '', s.who));
      tr2.append(el('td', '', fmtMonth(s.month)));
      tr2.append(el('td', '', s.summary));
      tr2.append(el('td', '', fmtDateLong(s.created)));
      tb.append(tr2);
    }
    table2.append(tb);
    box.append(table2);
    main.append(box);
  }
}

/* ---------- requests hub (time off · trades · open shifts) ---------- */

const REQ_SECTIONS = [
  ['prefs', 'Request days off / preferences'],
  ['swap', 'Swap / pick up shifts'],
];

function renderRequestsHub(main) {
  if (!['prefs', 'swap'].includes(state.reqSub)) state.reqSub = 'swap';
  const nav = el('div', 'subnav');
  nav.append(el('span', 'todaylabel', 'I want to…'));
  const sel = document.createElement('select');
  for (const [k, label] of REQ_SECTIONS) {
    const o = el('option', '', label);
    o.value = k;
    if (k === state.reqSub) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => { state.reqSub = sel.value; setView('requests'); };
  nav.append(sel);
  main.append(nav);

  const body = el('div');
  main.append(body);
  if (state.reqSub === 'swap') {
    if (state.viewAs) renderSwap(body);
    else {
      // manager mode: approvals table + open-shift list
      renderTrades(body);
      renderOpen(body);
      const pending = overlay.trades.filter(t => t.status === 'claimed').length;
      const opens = filtered(shifts()).filter(s => !s.who && s.date >= TODAY).length;
      $('#weekStats').textContent = `${pending} swap${pending === 1 ? '' : 's'} awaiting approval · ${opens} open shifts`;
    }
  } else {
    renderPrefs(body);
  }
}

/* ---------- swap / pick-up month calendar (employee view) ---------- */

function swapChip(s, trade, mine) {
  const isMine = s.who === mine;
  const isOpen = !s.who;
  const role = providerRole(s);
  const b = el('button', 'chip mini2');
  b.style.setProperty('--site', siteColor(s.site));
  addProviderRoleClass(b, role);
  b.append(el('span', 't', `${s.start}–${s.end}`));
  const label = isMine ? s.who.replace(/,.*$/, '') : (s.who ? s.who.replace(/,.*$/, '') : 'OPEN — click to pick up');
  const meta = !isMine ? [s.site, role].filter(Boolean).join(' · ') : '';
  b.append(el('span', 'who', label + (meta ? ` · ${meta}` : '')));
  if (isPhone()) b.append(el('span', 'site', s.pos));
  const future = s.date >= TODAY;

  if (isOpen) {
    b.classList.add('open');
    if (future) {
      b.classList.add('pickupable');
      b.title = `Open shift: ${s.pos} · click to pick it up`;
      b.onclick = () => {
        if (!confirm(`Pick up this open shift?\n\n${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos} at ${siteName(s.site)}`)) return;
        applyEdit(s, { who: mine });
        pushNotif('', `${mine} picked up the open ${fmtDate(s.date)} ${s.start}–${s.end} ${s.pos} shift`, 'requests', 'swap');
        saveOverlay();
        render();
      };
    } else b.classList.add('inert');
  } else if (isMine) {
    b.classList.add('minechip', 'my-shift');
    if (trade) {
      b.append(el('span', 'swapbadge', trade.status === 'claimed' ? `swap pending: ${trade.claimedBy.replace(/,.*$/, '')}` : 'offered for swap'));
      b.title = 'Click to withdraw this swap offer';
      b.onclick = () => {
        if (!confirm('Withdraw your swap offer for this shift?')) return;
        trade.status = 'cancelled';
        if (trade.claimedBy) pushNotif(trade.claimedBy, `${mine} withdrew the ${fmtDate(s.date)} swap offer`, 'requests', 'swap');
        saveOverlay();
        render();
      };
    } else if (future) {
      b.title = 'Your shift — click to offer it for swap';
      b.onclick = () => {
        if (!confirm(`Offer this shift for swap?\n\n${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos} at ${siteName(s.site)}\n\nCoworkers at your sites can claim it; the scheduler approves the change.`)) return;
        overlay.trades.push({ id: 't' + Date.now(), shiftId: s.id, who: mine, note: '', claimedBy: null, status: 'open', created: TODAY });
        pushNotif('', `${mine} offered their ${fmtDate(s.date)} ${s.start}–${s.end} ${s.pos} shift for swap`, 'requests', 'swap');
        saveOverlay();
        render();
      };
    } else b.classList.add('inert');
  } else if (trade && trade.status === 'open' && future) {
    b.classList.add('swappable');
    b.append(el('span', 'swapbadge', 'offered — click to claim'));
    b.title = `${s.who} offered this shift · click to claim it`;
    b.onclick = () => {
      if (!confirm(`Claim ${s.who}'s shift?\n\n${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos} at ${siteName(s.site)}\n\nThe scheduler still has to approve the swap.`)) return;
      trade.claimedBy = mine;
      trade.status = 'claimed';
      pushNotif(trade.who, `${mine} claimed your ${fmtDate(s.date)} shift — awaiting approval`, 'requests', 'swap');
      pushNotif('', `${mine} claimed ${trade.who}'s ${fmtDate(s.date)} shift — needs approval`, 'requests', 'swap');
      saveOverlay();
      render();
    };
  } else {
    b.classList.add('coworker-shift');
    if (trade && trade.status === 'claimed') b.append(el('span', 'swapbadge', 'swap pending'));
    b.title = `${s.who} · click to offer a swap or contact them`;
    b.onclick = () => openPersonDialog(s.who, s);
  }
  return b;
}

function renderDirectSwapOffers(main, mine) {
  const direct = overlay.trades.filter(t => t.targetWho && (t.who === mine || t.targetWho === mine))
    .slice().sort((a, b) => b.id.localeCompare(a.id));
  if (!direct.length) return;

  const card = el('div', 'reqform direct-swaps');
  card.append(el('h2', '', 'Direct swap offers'));
  const table = el('table', 'flat');
  table.innerHTML = '<thead><tr><th>You offer</th><th>You receive</th><th>With</th><th>Note</th><th>Status</th><th></th></tr></thead>';
  const tb = el('tbody');

  for (const t of direct) {
    const offered = shiftById(t.shiftId);
    const requested = shiftById(t.requestedShiftId);
    const mineIsOfferer = t.who === mine;
    const tr = el('tr');
    tr.append(el('td', '', tradeShiftLabel(mineIsOfferer ? offered : requested)));
    tr.append(el('td', '', tradeShiftLabel(mineIsOfferer ? requested : offered)));
    tr.append(el('td', '', mineIsOfferer ? t.targetWho : t.who));
    tr.append(el('td', '', t.note || '—'));
    const tdStatus = el('td');
    const badgeClass = { proposed: 'req-pending', claimed: 'req-pending', approved: 'req-approved', denied: 'req-denied', cancelled: 'req-denied' }[t.status] || 'req-pending';
    const statusLabel = t.status === 'proposed' ? (mineIsOfferer ? 'awaiting coworker' : 'your response') : t.status;
    tdStatus.append(el('span', 'req-badge ' + badgeClass, statusLabel));
    tr.append(tdStatus);

    const tdActions = el('td');
    if (!mineIsOfferer && t.status === 'proposed') {
      const accept = el('button', 'primary', 'Accept');
      accept.onclick = () => {
        t.status = 'claimed';
        t.claimedBy = mine;
        pushNotif(t.who, `${mine} accepted your swap offer — awaiting scheduler approval`, 'requests', 'swap');
        pushNotif('', `${mine} accepted ${t.who}'s direct swap — needs approval`, 'requests', 'swap');
        saveOverlay();
        render();
      };
      const decline = el('button', 'danger', 'Decline');
      decline.onclick = () => {
        t.status = 'denied';
        pushNotif(t.who, `${mine} declined your swap offer`, 'requests', 'swap');
        saveOverlay();
        render();
      };
      tdActions.append(accept, decline);
    }
    if (mineIsOfferer && ['proposed', 'claimed'].includes(t.status)) {
      const withdraw = el('button', 'danger', 'Withdraw');
      withdraw.onclick = () => {
        t.status = 'cancelled';
        pushNotif(t.targetWho, `${mine} withdrew their swap offer`, 'requests', 'swap');
        saveOverlay();
        render();
      };
      tdActions.append(withdraw);
    }
    tr.append(tdActions);
    tb.append(tr);
  }

  table.append(tb);
  card.append(table);
  main.append(card);
}

function renderSwap(main) {
  const mine = state.viewAs;
  const mo = state.month;
  const mySites = employeeSites(mine);
  let list = filtered(shifts()).filter(s => s.date.startsWith(mo));
  if (mySites.size) list = list.filter(s => s.site && mySites.has(s.site));

  const tradeByShift = new Map();
  for (const t of overlay.trades) if (['open', 'proposed', 'claimed'].includes(t.status)) tradeByShift.set(t.shiftId, t);

  const opens = list.filter(s => !s.who && s.date >= TODAY).length;
  const offered = list.filter(s => s.who && s.who !== mine && tradeByShift.get(s.id)?.status === 'open' && s.date >= TODAY).length;
  const directIncoming = overlay.trades.filter(t => t.targetWho === mine && t.status === 'proposed').length;
  $('#weekStats').textContent = `${fmtMonth(mo)} · ${opens} open to pick up · ${offered} offered for swap${directIncoming ? ` · ${directIncoming} direct offer${directIncoming === 1 ? '' : 's'}` : ''}`;

  const legend = el('div', 'preflegend');
  legend.append(el('span', 'chip mini2 open legendchip', 'OPEN — click to pick up'));
  legend.append(el('span', 'chip mini2 minechip legendchip', 'your shift — click to offer swap'));
  legend.append(el('span', 'chip mini2 swappable legendchip', 'coworker’s offer — click to claim'));
  legend.append(el('span', 'chip mini2 role-phy legendchip', 'PHY'));
  legend.append(el('span', 'chip mini2 role-apc legendchip', 'APC'));
  main.append(legend);
  renderDirectSwapOffers(main, mine);

  const byDay = new Map();
  for (const s of list) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }

  if (isPhone()) {
    renderAgenda(main, monthDays(mo), byDay, s => swapChip(s, tradeByShift.get(s.id), mine), {
      skipEmpty: true,
      emptyText: `Nothing to swap or pick up at your sites in ${fmtMonth(mo)}.`,
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
    const td = el('td', iso === TODAY ? 'today' : '');
    td.append(el('div', 'dn', String(day)));
    const cell = (byDay.get(iso) || []).sort((a, b) => a.start.localeCompare(b.start) || a.pos.localeCompare(b.pos));
    const expanded = state.expandedDays.has(iso);
    const show = expanded ? cell : cell.slice(0, COLLAPSED_CHIPS);
    for (const s of show) td.append(swapChip(s, tradeByShift.get(s.id), mine));
    if (cell.length > COLLAPSED_CHIPS) {
      const more = el('button', 'morebtn', expanded ? 'show less' : `+${cell.length - COLLAPSED_CHIPS} more`);
      more.onclick = () => {
        if (expanded) state.expandedDays.delete(iso); else state.expandedDays.add(iso);
        render();
      };
      td.append(more);
    }
    tr.append(td);
    if ((first.getUTCDay() + day) % 7 === 0) { table.append(tr); tr = el('tr'); }
  }
  if (tr.children.length) { while (tr.children.length < 7) tr.append(el('td', 'off')); table.append(tr); }
  main.append(table);
}

/* ---------- calendar (.ics) export ---------- */

function downloadIcs() {
  if (!state.viewAs) {
    alert('Pick a person in the Employee view dropdown first — the calendar file contains that person’s shifts.');
    return;
  }
  const mine = shifts().filter(s => s.who === state.viewAs)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!mine.length) { alert('No shifts to export.'); return; }
  const esc = t => String(t || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
  const dt = (iso, t) => iso.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Relias Healthcare//ShiftBoard//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:Relias Shifts — ${esc(state.viewAs)}`,
  ];
  for (const s of mine) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@relias-shiftboard`,
      `DTSTAMP:${TODAY.replace(/-/g, '')}T000000Z`,
      `DTSTART:${dt(s.date, s.start)}`,
      `DTEND:${dt(isOvernight(s) ? addDays(s.date, 1) : s.date, s.end)}`,
      `SUMMARY:${esc(s.pos)}${s.site ? ` (${s.site})` : ''}`,
      `LOCATION:${esc(siteName(s.site))}`,
      `DESCRIPTION:${esc(s.note || '')}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  download(`relias-shifts-${state.viewAs.replace(/[^\w]+/g, '-')}.ics`, lines.join('\r\n'), 'text/calendar');
}

/* ---------- open shifts view ---------- */

function renderOpen(main) {
  const mySites = state.viewAs ? employeeSites(state.viewAs) : null;
  const list = filtered(shifts()).filter(s => !s.who && s.date >= TODAY)
    .filter(s => !mySites || mySites.has(s.site))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  $('#weekStats').textContent = mySites
    ? `${list.length} open shifts at my sites from today forward`
    : `${list.length} open shifts from today forward`;

  if (!list.length) {
    main.append(el('div', 'empty', 'No open shifts match these filters. 🎉'));
    return;
  }
  const table = el('table', 'flat');
  table.innerHTML = '<thead><tr><th>Date</th><th>Time</th><th>Position</th><th>Site</th><th>Note</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const s of list) {
    const tr = el('tr');
    tr.append(el('td', '', fmtDateLong(s.date)));
    tr.append(el('td', '', `${s.start}–${s.end}`));
    tr.append(el('td', '', s.pos));
    const tdSite = el('td');
    const tag = el('span', 'sitetag', s.site || '—');
    tag.style.setProperty('--site', siteColor(s.site));
    tdSite.append(tag);
    tr.append(tdSite);
    tr.append(el('td', '', s.note || ''));
    const tdAct = el('td');
    const claim = el('button', '', 'Claim');
    claim.onclick = () => {
      const who = prompt('Assign this shift to:', state.person);
      if (who) { applyEdit(s, { who }); render(); }
    };
    tdAct.append(claim);
    tr.append(tdAct);
    tb.append(tr);
  }
  table.append(tb);
  main.append(table);
}

/* ---------- people view ---------- */

function renderPeople(main) {
  const map = new Map();
  for (const s of filtered(shifts())) {
    if (!s.who) continue;
    if (!map.has(s.who)) map.set(s.who, { n: 0, h: 0, sites: new Set(), pos: new Set(), next: null });
    const p = map.get(s.who);
    p.n++;
    p.h += hours(s);
    if (s.site) p.sites.add(s.site);
    p.pos.add(s.pos);
    if (s.date >= TODAY && (!p.next || s.date < p.next)) p.next = s.date;
  }
  const q = state.search.toLowerCase();
  const names = [...map.keys()].filter(n => !q || n.toLowerCase().includes(q)).sort();
  $('#weekStats').textContent = `${names.length} people`;

  const table = el('table', 'flat');
  table.innerHTML = '<thead><tr><th>Name</th><th>Sites</th><th>Positions</th><th>Shifts</th><th>Hours</th><th>Next shift</th></tr></thead>';
  const tb = el('tbody');
  for (const n of names) {
    const p = map.get(n);
    const tr = el('tr');
    const tdN = el('td');
    const link = el('a', '', n);
    link.href = '#';
    if (state.viewAs && n !== state.viewAs) {
      link.title = `Offer ${n} a swap or contact them`;
      link.onclick = e => { e.preventDefault(); openPersonDialog(n); };
    } else {
      link.title = state.viewAs ? 'Return to your schedule' : 'See the schedule from this person’s view';
      link.onclick = e => { e.preventDefault(); state.viewAs = n; state.person = n; setView('month'); };
    }
    tdN.append(link);
    tr.append(tdN);
    const tdS = el('td');
    for (const s of [...p.sites].sort().slice(0, 5)) {
      const tag = el('span', 'sitetag', s);
      tag.style.setProperty('--site', siteColor(s));
      tag.style.marginRight = '4px';
      tdS.append(tag);
    }
    if (p.sites.size > 5) tdS.append(el('span', '', ` +${p.sites.size - 5}`));
    tr.append(tdS);
    tr.append(el('td', '', [...p.pos].sort().slice(0, 3).join(', ') + (p.pos.size > 3 ? ` +${p.pos.size - 3}` : '')));
    tr.append(el('td', '', String(p.n)));
    tr.append(el('td', '', Math.round(p.h) + 'h'));
    tr.append(el('td', '', p.next ? fmtDateLong(p.next) : '—'));
    tb.append(tr);
  }
  table.append(tb);
  main.append(table);
}

/* ---------- employee coworker actions ---------- */

let personTarget = '';
let personTargetShift = null;

function shiftSummary(s) {
  if (!s) return '';
  return `${fmtDateLong(s.date)} · ${s.start}–${s.end}\n${s.pos}${s.site ? ` · ${siteName(s.site)}` : ''}${s.note ? `\n${s.note}` : ''}`;
}

function activeTradeShiftIds() {
  const ids = new Set();
  for (const t of overlay.trades) {
    if (!['open', 'proposed', 'claimed'].includes(t.status)) continue;
    if (t.shiftId) ids.add(t.shiftId);
    if (t.requestedShiftId) ids.add(t.requestedShiftId);
  }
  return ids;
}

function swapEligible(name) {
  const busy = activeTradeShiftIds();
  return shifts().filter(s => s.who === name && s.date >= TODAY && !busy.has(s.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

function fillShiftSelect(select, list, preferredId) {
  select.innerHTML = '';
  for (const s of list) {
    const o = el('option', '', tradeShiftLabel(s));
    o.value = s.id;
    if (s.id === preferredId) o.selected = true;
    select.append(o);
  }
}

function showPersonPanel(panel) {
  $('#personActions').hidden = Boolean(panel);
  $('#directSwapForm').hidden = panel !== 'swap';
  $('#directContactForm').hidden = panel !== 'contact';
}

function openPersonDialog(person, shift = null) {
  const mine = state.viewAs;
  personTarget = person;
  personTargetShift = shift && shift.who === person ? shift : null;
  showPersonPanel(null);
  $('#directSwapNote').value = '';
  $('#directContactMessage').value = '';

  const summary = $('#personShiftSummary');
  summary.textContent = shiftSummary(shift);
  const actions = $('#personActions');
  const hint = $('#personDialogHint');

  if (!mine || !person || person === mine) {
    $('#personDialogTitle').textContent = person === mine ? 'Your shift' : 'Shift details';
    actions.hidden = true;
    hint.textContent = person === mine
      ? 'Employee schedules are read-only here. Use Requests if you need to offer this shift or contact the scheduler.'
      : 'Employee schedules are read-only here. Open shifts can be requested from Requests.';
    $('#personDialog').showModal();
    return;
  }

  $('#personDialogTitle').textContent = person;
  hint.textContent = personTargetShift
    ? 'You can offer a shift in exchange for this one, or send this coworker a message.'
    : 'Choose whether you want to offer a shift swap or send this coworker a message.';
  actions.hidden = false;
  $('#personContactBtn').textContent = `Contact ${person.replace(/,.*$/, '')}`;
  $('#directContactTitle').textContent = `Contact ${person}`;

  const contact = overlay.contacts[person] || {};
  const details = [contact.pref ? `Prefers ${contact.pref}` : '', contact.email || '', contact.phone || ''].filter(Boolean);
  $('#directContactInfo').textContent = details.length
    ? details.join(' · ')
    : 'No shared contact details yet. You can still send an in-app message.';

  const mineEligible = swapEligible(mine);
  const theirsEligible = swapEligible(person);
  fillShiftSelect($('#mySwapShift'), mineEligible);
  fillShiftSelect($('#theirSwapShift'), theirsEligible, personTargetShift?.id);
  const swapButton = $('#personSwapBtn');
  swapButton.disabled = !mineEligible.length || !theirsEligible.length;
  swapButton.title = !mineEligible.length
    ? 'You do not have an available upcoming shift to offer.'
    : !theirsEligible.length
      ? `${person} does not have an available upcoming shift to request.`
      : '';

  $('#personDialog').showModal();
}

function wirePersonDialog() {
  const dlg = $('#personDialog');
  $('#personCloseBtn').onclick = () => dlg.close();
  $('#personSwapBtn').onclick = () => showPersonPanel('swap');
  $('#personContactBtn').onclick = () => showPersonPanel('contact');
  document.querySelectorAll('.personBackBtn').forEach(b => { b.onclick = () => showPersonPanel(null); });

  $('#directSwapForm').onsubmit = e => {
    e.preventDefault();
    const mine = state.viewAs;
    const mineShift = shiftById($('#mySwapShift').value);
    const theirShift = shiftById($('#theirSwapShift').value);
    if (!mine || !personTarget || !mineShift || !theirShift) return;
    overlay.trades.push({
      id: 't' + Date.now(),
      shiftId: mineShift.id,
      requestedShiftId: theirShift.id,
      who: mine,
      targetWho: personTarget,
      claimedBy: null,
      note: $('#directSwapNote').value.trim(),
      status: 'proposed',
      created: TODAY,
    });
    pushNotif(personTarget, `${mine} offered you a shift swap`, 'requests', 'swap');
    pushNotif('', `${mine} offered ${personTarget} a direct shift swap`, 'requests', 'swap');
    saveOverlay();
    dlg.close();
    state.reqSub = 'swap';
    setView('requests');
  };

  $('#directContactForm').onsubmit = e => {
    e.preventDefault();
    const mine = state.viewAs;
    const text = $('#directContactMessage').value.trim();
    if (!mine || !personTarget || !text) return;
    overlay.messages.push({ id: 'm' + Date.now(), who: mine, to: personTarget, text, created: TODAY, replies: [] });
    pushNotif(personTarget, `${mine} sent you a message`, 'contact');
    saveOverlay();
    dlg.close();
    setView('contact');
  };
}

/* ---------- shift dialog ---------- */

let dialogShift = null;

function openDialog(s, defaults) {
  if (state.viewAs) {
    openPersonDialog(s?.who || '', s || null);
    return;
  }
  dialogShift = s;
  const f = $('#shiftForm');
  $('#dialogTitle').textContent = s ? 'Edit Shift' : 'Add Shift';
  $('#deleteShiftBtn').style.display = s ? '' : 'none';
  const v = s || { date: TODAY, start: '07:00', end: '19:00', who: '', site: '', note: '', pos: '', ...defaults };
  f.date.value = v.date; f.pos.value = v.pos; f.start.value = v.start; f.end.value = v.end;
  f.who.value = v.who; f.site.value = v.site; f.note.value = v.note;
  $('#shiftDialog').showModal();
}

function applyEdit(s, fields) {
  if (String(s.id).startsWith('a')) {
    const a = overlay.added.find(x => x.id === s.id);
    if (a) Object.assign(a, fields);
  } else {
    overlay.edits[s.id] = { ...(overlay.edits[s.id] || {}), ...fields };
  }
  saveOverlay();
}

function wireDialog() {
  const dlg = $('#shiftDialog');
  $('#cancelBtn').onclick = () => dlg.close();
  $('#deleteShiftBtn').onclick = () => {
    if (dialogShift && confirm('Delete this shift?')) {
      overlay.removed.push(dialogShift.id);
      saveOverlay();
      dlg.close();
      render();
    }
  };
  $('#shiftForm').onsubmit = e => {
    const f = e.target;
    const fields = {
      date: f.date.value, pos: f.pos.value.trim(), start: f.start.value, end: f.end.value,
      who: f.who.value.trim(), site: f.site.value.trim(), note: f.note.value.trim(),
    };
    if (dialogShift) applyEdit(dialogShift, fields);
    else {
      overlay.added.push({ id: 'a' + Date.now(), ...fields });
      saveOverlay();
    }
    render();
  };
}

/* ---------- export / import ---------- */

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCsv() {
  let list = filtered(shifts());
  if (state.view === 'month') {
    list = list.filter(s => s.date.startsWith(state.month));
  } else if (state.view === 'week') {
    const end = addDays(state.weekStart, 6);
    list = list.filter(s => s.date >= state.weekStart && s.date <= end);
  } else if (state.view === 'requests' && state.reqSub === 'open') {
    list = list.filter(s => !s.who && s.date >= TODAY);
  }
  const openSub = state.view === 'requests' && state.reqSub === 'open';
  const everyoneScope = state.showEveryone && (state.view === 'month' || state.view === 'week');
  if (state.viewAs && !openSub && state.view !== 'people') {
    if (everyoneScope) {
      const ms = employeeSites(state.viewAs);
      list = list.filter(s => s.site && ms.has(s.site));
    } else {
      list = list.filter(s => s.who === state.viewAs);
    }
  }
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Date', 'Start', 'End', 'Position', 'Site', 'Assigned', 'Note'].join(',')];
  for (const s of list.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))) {
    rows.push([s.date, s.start, s.end, esc(s.pos), esc(s.site), esc(s.who), esc(s.note)].join(','));
  }
  download('shiftboard.csv', rows.join('\n'), 'text/csv');
}

function wireChrome() {
  document.querySelectorAll('#viewTabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#viewAsSelect').onchange = e => {
    state.viewAs = e.target.value;
    if (state.viewAs) state.person = state.viewAs;
    render();
  };
  $('#prevWeek').onclick = () => { shiftPeriod(-1); };
  $('#nextWeek').onclick = () => { shiftPeriod(1); };
  const todayBtn = $('#todayBtn');
  if (todayBtn) {
    todayBtn.onclick = () => {
      state.weekStart = sundayOf(TODAY);
      state.month = TODAY.slice(0, 7);
      render();
    };
  }
  $('#weekSelect').onchange = e => {
    if (state.view === 'month' || state.view === 'requests') state.month = e.target.value;
    else state.weekStart = e.target.value;
    render();
  };
  $('#siteFilter').onchange = e => { state.site = e.target.value; state.pos = ''; render(); };
  $('#posFilter').onchange = e => { state.pos = e.target.value; render(); };
  $('#searchBox').oninput = e => { state.search = e.target.value; render(); };
  $('#exportCsvBtn').onclick = exportCsv;
  $('#printBtn').onclick = () => print();
  $('#icsBtn').onclick = downloadIcs;
  $('#bellBtn').onclick = toggleBell;
  document.addEventListener('click', e => {
    if (notifOpen && !e.target.closest('#notifPanel') && !e.target.closest('#bellBtn')) {
      notifOpen = false;
      renderBell();
    }
  });
  $('#exportJsonBtn').onclick = () => {
    download('shiftboard-data.json', JSON.stringify({ shifts: shifts().map(s => [s.date, s.pos, s.start, s.end, s.who || null, s.site || null, s.note || null, s.id]) }, null, 1), 'application/json');
  };
  $('#importJson').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      base = raw.shifts.map((s, i) => ({
        id: s[7] || 'x' + i,
        date: s[0], pos: s[1], start: s[2], end: s[3],
        who: s[4] || '', site: s[5] || '', note: s[6] || '',
      }));
      overlay = DEFAULT_OVERLAY();
      saveOverlay();
      render();
    } catch (err) { alert('Could not read that file: ' + err.message); }
  };
  $('#resetBtn').onclick = () => {
    if (confirm('Discard all local changes and return to the imported schedule?')) {
      overlay = DEFAULT_OVERLAY();
      saveOverlay();
      render();
    }
  };
}

function shiftPeriod(n) {
  if (state.view === 'month' || state.view === 'requests') {
    const months = monthList();
    const i = months.indexOf(state.month);
    state.month = months[Math.min(Math.max(i + n, 0), months.length - 1)];
  } else {
    const weeks = weekList();
    const i = weeks.indexOf(state.weekStart);
    state.weekStart = weeks[Math.min(Math.max(i + n, 0), weeks.length - 1)];
  }
  render();
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  const periodControls = v === 'week' || v === 'month' || v === 'requests';
  $('#filterBar').querySelector('.weeknav').style.display = periodControls ? '' : 'none';
  render();
}

/* ---------- notification bell ---------- */

let notifOpen = false;

function renderBell() {
  const list = myNotifs();
  const unread = list.filter(n => !n.read).length;
  const badge = $('#bellCount');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  const panel = $('#notifPanel');
  panel.hidden = !notifOpen;
  if (!notifOpen) return;
  panel.innerHTML = '';
  panel.append(el('h3', '', state.viewAs ? `Notifications — ${state.viewAs.replace(/,.*$/, '')}` : 'Notifications — Manager'));
  if (!list.length) {
    panel.append(el('div', 'notifempty', 'Nothing yet. Approvals, replies, and trade activity land here.'));
    return;
  }
  for (const n of list.slice(0, 30)) {
    const item = el('button', 'notifitem' + (n.read ? '' : ' unread'));
    item.append(el('span', 'notiftext', n.text));
    item.append(el('span', 'notifdate', fmtDateLong(n.created)));
    item.onclick = () => {
      notifOpen = false;
      const v = ['trades', 'open', 'prefs'].includes(n.view) ? 'requests' : n.view;
      if (n.sub) state.reqSub = n.sub;
      else if (v === 'requests' && ['trades', 'open', 'prefs'].includes(n.view)) state.reqSub = n.view;
      setView(v);
    };
    panel.append(item);
  }
}

function toggleBell() {
  notifOpen = !notifOpen;
  renderBell();   // panel renders with unread highlights intact
  if (notifOpen) {
    let dirty = false;
    for (const n of overlay.notifs) if (n.to === state.viewAs && !n.read) { n.read = true; dirty = true; }
    if (dirty) saveOverlay();
    $('#bellCount').hidden = true;
  }
}

/* ---------- render root ---------- */

function render() {
  renderFilterBar();
  renderDatalists();
  const main = $('#main');
  main.innerHTML = '';
  if (state.view === 'month') renderMonthAll(main);
  else if (state.view === 'week') renderWeek(main);
  else if (state.view === 'requests') renderRequestsHub(main);
  else if (state.view === 'contact') renderContact(main);
  else renderPeople(main);
  renderBell();
}

(async function init() {
  await unlockData();
  wireChrome();
  wireDialog();
  wirePersonDialog();
  render();
  /* live cross-tab sync: scheduler-console actions appear here without a refresh */
  window.addEventListener('storage', e => {
    if (e.key !== LS_KEY) return;
    try { overlay = { ...DEFAULT_OVERLAY(), ...JSON.parse(e.newValue || '{}') }; } catch { return; }
    render();
  });
})();
