# MyReliasSchedule — Relias Healthcare feasibility prototype

Static scheduling site seeded with real schedule data pulled from WhenToWork
(Everyone's Schedule, May 31 – Aug 29, 2026 · 13,846 shifts · ~300 people ·
108+ positions · 28 sites). Branded to match reliashealthcare.com — Figtree font,
navy `#033059` header gradient, cyan `#00bedd` primary, provider-blue `#0378a6`
accents, and the official logo (hotlinked from the company site).

## Run

Any static server works — no build step:

    npx http-server . -p 8460 -c-1

Then open http://localhost:8460. (Also registered as the `shiftboard` config in
`~/.claude/launch.json`.)

The published app loads an AES-GCM encrypted schedule after the shared PIN is
entered. The four-digit PIN is a lightweight prototype deterrent, not production
authentication. Raw schedule imports are intentionally excluded from Git.

Two surfaces, two PINs:

- `index.html` — **employee prototype** (shared staff PIN)
- `admin.html` — **scheduler console** (separate scheduler PIN; amber-accented).
  Approvals inbox with conflict checks, a coverage/gaps board with fair-fill
  suggestions, a schedule builder with a draft → publish workflow (staff are
  notified on publish), fairness/wellness reports, and an audit trail. Both
  surfaces share the same browser-local overlay, so employee submissions land
  in the console live (open them side-by-side in two windows for the full demo).

To (re)encrypt after changing data or PINs:

    $env:MY_RELIAS_PIN='<employee pin>'; node scripts/encrypt-data.mjs
    $env:MY_RELIAS_PIN='<scheduler pin>'; node scripts/encrypt-data.mjs data/schedule-data.admin.enc.json

## What's here

- `index.html` / `styles.css` / `app.js` — the employee app (vanilla JS, no dependencies)
- `admin.html` / `admin.css` / `admin.js` — the scheduler console (same stack)
- `data/schedule-data.json` — combined import; rows are
  `[date, position, start, end, name, site, note, w2wShiftId]`
- `data/week-*.json` — raw per-week pulls from WhenToWork
- `data/save-week.ps1` — decodes a saved browser-tool result file into a week JSON
  (used when re-pulling fresh data from WhenToWork)

## Features

- **Month** (default) — full-month calendar of everyone's shifts, open-shift
  counts per day, +N-more expansion, search floats matches to the top of each day
- **Week** — W2W-style grid, positions × days, color-coded by site, site/position
  filters, and search highlights. Manager mode can edit shifts and add new ones;
  employee mode is read-only
- **My Schedule** — per-person shift list, hours totals, month calendars
- Employee-owned shifts use a dedicated cyan/blue treatment and show the employee
  name instead of repeating the position and site
- Coworker physician shifts are green and APC shifts are purple, with `PHY` or
  `APC` shown beside the site code on each shift
- **Show Everyone Working ⇄ Show My Schedule Only** — filterbar toggle on Month/Week
  (employee view): flip between just your shifts and every shift at your sites,
  APCs and physicians alike, open shifts included
- **People** — roster derived from shifts: sites, positions, hours, next shift;
  employee mode opens coworker actions for a directed swap offer or message
- **Requests** — one hub with an "I want to…" dropdown:
  - *Request days off / preferences* — click-to-cycle month calendar (prefer / rather
    not / unavailable) + Submit button that sends the month's marks to the scheduler
  - *Swap / pick up shifts* — a clickable month calendar of your sites: open
    shifts glow amber (click to pick up), your shifts are cyan (click to offer
    for swap), coworker offers are purple (click to claim; scheduler approves),
    and other coworker shifts open the same directed-swap/contact actions as People
- **Contact** — your contact card + message thread with the scheduler
- 🔔 in-app notifications (approvals, replies, trade activity) per identity
- 📅 .ics calendar export of your shifts, CSV export, print styles, JSON download/import
- Employee view selector scopes everything to one person; "Everyone" = manager mode
- Dark theme only, per owner preference

Edits are a localStorage overlay on top of the imported data — per-browser only.
"Discard my changes" in the footer restores the pristine import. To share edits,
use "Download data + changes" and have the other person Import it.

## Not built yet (needs a backend)

Real logins, multi-user live edits, availability/preferences, time-off requests,
trade approvals, notifications. A Cloudflare Worker + D1 would cover it if this
becomes the real thing.
