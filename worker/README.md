# MyReliasSchedule — Claude backend

A tiny Cloudflare Worker that turns the scheduler console's **✨ Generate** tab
and **💬 Talk to the schedule** box into genuinely Opus-4.8-powered features.
The Anthropic API key lives here as a Worker secret and never reaches the
browser (a static GitHub Pages site can't safely hold one).

## Endpoints

- `GET  /api/health` — no-cost connection test. Returns `{ok, model, hasKey, tokenRequired}`.
- `POST /api/chat` — free-typed text → structured schedule operations + a reply.
- `POST /api/generate` — provider history + requests → per-provider targets + a written rationale.

The deterministic reconciliation engine still runs in the browser (so every
hard rule — days off, caps, 10-hour rest, time-of-day, ±1 fairness — is
guaranteed and auditable). Opus reads the history and requests and sets the
plan; the engine places the shifts.

## Deploy

From this `worker/` folder:

```sh
npm run deploy                      # publishes to shiftboard-claude.<subdomain>.workers.dev
npx wrangler secret put ANTHROPIC_API_KEY    # paste your Anthropic API key when prompted
npx wrangler secret put CONSOLE_TOKEN        # optional: a shared password so a leaked URL can't burn tokens
```

Until `ANTHROPIC_API_KEY` is set, the endpoints return `503 not_configured`
(the Worker is live and healthy, it just has no key yet).

## Connect the console

In the scheduler console → **✨ Generate** tab → **🔌 Connect Claude**, paste:

- **Backend URL**: `https://shiftboard-claude.<subdomain>.workers.dev`
- **Console token**: whatever you set for `CONSOLE_TOKEN` (leave blank if you didn't set one)

Click **Test** — it hits `/api/health`. Once connected, the chat box and the
Generate button route through Opus 4.8, with an automatic fall back to the
in-browser logic if the backend is unreachable.

## Local dev

```sh
npx wrangler dev            # http://localhost:8787
# health works with no key; /api/chat and /api/generate need a key in .dev.vars:
#   ANTHROPIC_API_KEY = "sk-ant-..."
```

## Cost

Opus 4.8 is $5/$25 per million tokens. A chat command is ~1-2K tokens (well
under a cent); a generate call is a few thousand. The `CONSOLE_TOKEN` gate
keeps random traffic off your key.
