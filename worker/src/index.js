/* MyReliasSchedule — Claude backend (Cloudflare Worker)
 *
 * Two endpoints the scheduler console calls:
 *   POST /api/chat      free-typed command  -> structured schedule ops + a reply
 *   POST /api/generate  site history + reqs -> per-provider targets + rationale
 * Plus GET /api/health for a no-cost connection test.
 *
 * The Anthropic API key is a Worker secret (ANTHROPIC_API_KEY) and never
 * reaches the browser. An optional CONSOLE_TOKEN secret gates the endpoints so
 * a leaked URL can't burn tokens.
 */

const MODEL = 'claude-opus-4-8';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, x-console-token',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...cors(origin) },
  });
}

/* one Messages API call; forces a tool so we get validated structured output */
async function callClaude(env, { system, userText, tool, maxTokens, effort }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens || 1024,
    system,
    messages: [{ role: 'user', content: userText }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  };
  if (effort) body.output_config = { effort };
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!block) throw new Error('Model did not return the expected tool call.');
  return { input: block.input, usage: data.usage };
}

/* ---- /api/chat: natural language -> schedule operations ---- */

const CHAT_TOOL = {
  name: 'emit_schedule_commands',
  description: 'Translate the scheduler\'s request into structured schedule operations and a short confirmation reply.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'ops'],
    properties: {
      reply: { type: 'string', description: 'One or two sentences confirming what you did, in plain English.' },
      ops: {
        type: 'array',
        description: 'The operations to apply. Empty if the request is unclear.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: {
              type: 'string',
              enum: ['addProvider', 'removeProvider', 'addOff', 'addPrefer', 'setCap', 'setTarget', 'setTimeOfDay', 'maxRun', 'move'],
            },
            who: { type: 'string', description: 'Full provider name as it appears in the roster, e.g. "Blake Lovely, MD".' },
            role: { type: 'string', enum: ['PHY', 'APC'], description: 'For addProvider: PHY=physician, APC=nurse practitioner/PA.' },
            target: { type: 'integer', description: 'For addProvider: target shifts per month.' },
            value: { type: 'integer', description: 'For setCap/setTarget: shift count. For maxRun: max consecutive days.' },
            tod: { type: 'string', enum: ['day', 'eve', 'night'], description: 'Time-of-day restriction. day<12:00, eve 12-18, night 18:00+.' },
            dates: { type: 'array', items: { type: 'string' }, description: 'ISO dates (YYYY-MM-DD) for addOff/addPrefer.' },
            toWho: { type: 'string', description: 'For move: the provider receiving the shift.' },
            date: { type: 'string', description: 'For move: ISO date of the shift to move from `who` to `toWho`.' },
          },
        },
      },
    },
  },
};

async function handleChat(env, payload) {
  const { text, site, siteName, month, people, pool } = payload;
  const roster = (pool || []).map(p => `${p.who} (${p.role}${p.tod ? ', ' + p.tod + 's only' : ''}, target ${p.target})`).join('\n');
  const others = (people || []).filter(n => !(pool || []).some(p => p.who === n)).slice(0, 400).join(', ');
  const system = [
    `You are the scheduling assistant for ${siteName || site}, ${month}. Translate the scheduler's plain-English request into structured operations.`,
    `Resolve names to the EXACT full name from the roster or the wider staff list. If a name is ambiguous or not found, return no ops and ask for clarification in the reply.`,
    `Dates must be ISO (YYYY-MM-DD) within ${month}. Understand relative phrasing: "the first week" = days 1-7, "last week" = final 7 days, weekday names, "weekends", ranges like "the 8th to the 12th".`,
    `Operation guide: addProvider (needs role PHY/APC and a monthly target; include tod if they say "nights only" etc.); removeProvider; addOff (hard unavailable days); addPrefer (preferred days); setCap (max shifts); setTarget (monthly target); setTimeOfDay (nights/days/eves only); maxRun (global max consecutive days, no "who"); move (needs who, toWho, date — only if they name a specific shift to move).`,
    `Current roster:\n${roster || '(none)'}`,
    others ? `Other known staff who could be added or referenced: ${others}` : '',
  ].filter(Boolean).join('\n\n');
  const { input, usage } = await callClaude(env, {
    system,
    userText: text,
    tool: CHAT_TOOL,
    maxTokens: 1536,
    effort: 'medium',
  });
  return { reply: input.reply, ops: input.ops || [], usage };
}

/* ---- /api/generate: history + requests -> plan ---- */

const GEN_TOOL = {
  name: 'emit_schedule_plan',
  description: 'Analyze the provider history and requests, then set each provider\'s monthly target and write a short rationale.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['analysis', 'notes', 'targets'],
    properties: {
      analysis: { type: 'string', description: '2-4 sentence plain-English summary of the staffing picture and how you balanced it.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Short bullet observations a scheduler would want (coverage gaps, fairness, staffing recommendations).' },
      targets: {
        type: 'array',
        description: 'Per-provider monthly target the deterministic engine should aim for.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['who', 'target'],
          properties: {
            who: { type: 'string' },
            target: { type: 'integer' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

async function handleGenerate(env, payload) {
  const { site, siteName, month, historyMonths, openSlots, providers, requests, rules } = payload;
  const provLines = (providers || []).map(p =>
    `${p.who} — ${p.role}; avg ${p.avg?.toFixed ? p.avg.toFixed(1) : p.avg} days/mo over ${historyMonths || '3'} months; usual shift ${p.usual || 'mixed'}`).join('\n');
  const reqLines = (requests || []).map(r => {
    const bits = [];
    if (r.off?.length) bits.push(`off ${r.off.join(',')}`);
    if (r.prefer?.length) bits.push(`prefers ${r.prefer.join(',')}`);
    if (r.cap) bits.push(`max ${r.cap}`);
    if (r.note) bits.push(`"${r.note}"`);
    return `${r.who}: ${bits.join('; ') || '—'}`;
  }).join('\n');
  const system = [
    `You are a physician scheduler building the ${month} schedule for ${siteName || site}.`,
    `There are ${openSlots} open shifts to fill. Set each provider's monthly target so the schedule is fair and covers as much as possible.`,
    `Each provider's target MUST equal their recent average days worked (rounded), or exceed it by one or two when a request or shortage warrants. A target below a provider's average is INVALID OUTPUT — the only legitimate ways someone works less are their own stated cap or days off. Honor stated caps. Keep night people on nights.`,
    `Write 6-12 specific notes: coverage gaps with numbers, fairness calls you made, requests you honored or couldn't, recruiting needs, and anything a scheduler would double-check.`,
    `If the site is understaffed, say so plainly and estimate how many more providers are needed rather than overloading people. Write for a scheduler, not an executive.`,
    rules ? `Standing rules: ${rules}` : '',
  ].filter(Boolean).join('\n\n');
  const userText = `Providers (name — role; recent average; usual time of day):\n${provLines}\n\nRequests on file:\n${reqLines || '(none)'}\n\nProduce the plan.`;
  const { input, usage } = await callClaude(env, {
    system,
    userText,
    tool: GEN_TOOL,
    maxTokens: 3072,
    effort: 'high',
  });
  const notes = Array.isArray(input.notes)
    ? input.notes
    : (input.notes ? String(input.notes).split('\n').map(s => s.replace(/^[-•*]\s*/, '').trim()).filter(Boolean) : []);
  const targets = Array.isArray(input.targets) ? input.targets : [];
  return { analysis: input.analysis || '', notes, targets, usage };
}

/* ---- /api/review: adversarial review of a proposed schedule ---- */

const REVIEW_TOOL = {
  name: 'emit_schedule_review',
  description: 'Adversarially review the proposed schedule and report concrete, data-verifiable problems with fixes.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'summary', 'flags', 'fixes'],
    properties: {
      verdict: { type: 'string', enum: ['clean', 'issues'] },
      summary: { type: 'string', description: 'One or two sentences: overall judgment of this schedule.' },
      flags: {
        type: 'array',
        description: 'Concrete problems found. Empty if the schedule is clean.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'issue'],
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            issue: { type: 'string', description: 'The specific problem, with names/dates/numbers from the data.' },
            who: { type: 'string' },
            date: { type: 'string' },
          },
        },
      },
      fixes: {
        type: 'array',
        description: 'Operations that would fix the flags. Same schema as the chat ops.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['addProvider', 'removeProvider', 'addOff', 'addPrefer', 'setCap', 'setTarget', 'setTimeOfDay', 'maxRun', 'move'] },
            who: { type: 'string' },
            role: { type: 'string', enum: ['PHY', 'APC'] },
            target: { type: 'integer' },
            value: { type: 'integer' },
            tod: { type: 'string', enum: ['day', 'eve', 'night'] },
            dates: { type: 'array', items: { type: 'string' } },
            toWho: { type: 'string' },
            date: { type: 'string' },
          },
        },
      },
    },
  },
};

async function handleReview(env, payload) {
  const { site, siteName, month, round, rules, providers, assignments, unfilled, priorFlags } = payload;
  const system = [
    `You are an ADVERSARIAL schedule reviewer for ${siteName || site}, ${month} (review round ${round}). Your job is to find real problems in this proposed schedule, not to praise it.`,
    `Hunt specifically for: providers ending below their average minus one (floor violations); anyone above target+1; shifts with under 10 hours rest between them (a shift's end to the next day's start, overnights end next morning); night-pattern people given day shifts or vice versa; runs longer than the max consecutive rule; unfair spreads between similar providers; preferred days that were skipped while that day's shift went to someone with no preference; open shifts a listed provider could legally take.`,
    `Every flag must cite names, dates, or numbers VERIFIABLE from the data given. Do not invent issues; do not pad. If the schedule genuinely holds up, return verdict "clean" with zero flags — a clean verdict from a hostile reviewer is meaningful. Your summary MUST agree with your flags: zero flags means the summary says the schedule held up; never describe problems you did not flag.`,
    `For each flag propose the smallest concrete fix as an operation (move a specific shift, adjust a target/cap, set time-of-day). Use exact full provider names. Only propose moves to providers who are eligible (right role, not on an off day, respects rest). NEVER fix a problem by cutting a provider's target or cap below their current target minus one — nobody may end below their normal load; fix overloads by MOVING specific shifts to under-loaded eligible providers instead. Such lowering fixes will be rejected.`,
    priorFlags && priorFlags.length ? `Flags from the previous round (verify they are actually resolved; re-flag if not): ${priorFlags.join(' | ')}` : '',
    `Rules in force: ${rules}`,
  ].filter(Boolean).join('\n\n');
  const userText = [
    `Providers (name — role; target; days assigned incl. existing; floor=target-1; usual time of day; off days; preferred days; cap):`,
    ...(providers || []),
    ``,
    `Assignments (date start–end position → provider):`,
    ...(assignments || []),
    ``,
    unfilled && unfilled.length ? `Still open: ${unfilled.join(', ')}` : 'No open slots remain.',
  ].join('\n');
  const { input, usage } = await callClaude(env, {
    system,
    userText,
    tool: REVIEW_TOOL,
    maxTokens: 4096,
    effort: 'max',
  });
  return {
    verdict: input.verdict || 'issues',
    summary: input.summary || '',
    flags: Array.isArray(input.flags) ? input.flags : [],
    fixes: Array.isArray(input.fixes) ? input.fixes : [],
    usage,
  };
}

/* ---- router ---- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        model: MODEL,
        hasKey: Boolean(env.ANTHROPIC_API_KEY),
        tokenRequired: Boolean(env.CONSOLE_TOKEN),
      }, 200, origin);
    }

    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404, origin);
    }

    // optional shared-secret gate
    if (env.CONSOLE_TOKEN && request.headers.get('x-console-token') !== env.CONSOLE_TOKEN) {
      return json({ error: 'unauthorized', message: 'Missing or wrong console token.' }, 401, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'not_configured', message: 'Set the ANTHROPIC_API_KEY secret on this Worker (wrangler secret put ANTHROPIC_API_KEY).' }, 503, origin);
    }

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400, origin); }

    try {
      if (url.pathname === '/api/chat') return json(await handleChat(env, payload), 200, origin);
      if (url.pathname === '/api/generate') return json(await handleGenerate(env, payload), 200, origin);
      if (url.pathname === '/api/review') return json(await handleReview(env, payload), 200, origin);
      return json({ error: 'not_found' }, 404, origin);
    } catch (err) {
      return json({ error: 'upstream', message: String(err.message || err) }, 502, origin);
    }
  },
};
