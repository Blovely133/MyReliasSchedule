var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var MODEL = "claude-opus-4-8";
var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
function cors(origin) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-console-token",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}
__name(cors, "cors");
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", ...cors(origin) }
  });
}
__name(json, "json");
async function callClaude(env, { system, userText, tool, maxTokens, effort }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens || 1024,
    system,
    messages: [{ role: "user", content: userText }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name }
  };
  if (effort) body.output_config = { effort };
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!block) throw new Error("Model did not return the expected tool call.");
  return { input: block.input, usage: data.usage };
}
__name(callClaude, "callClaude");
var CHAT_TOOL = {
  name: "emit_schedule_commands",
  description: "Translate the scheduler's request into structured schedule operations and a short confirmation reply.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "ops"],
    properties: {
      reply: { type: "string", description: "One or two sentences confirming what you did, in plain English." },
      ops: {
        type: "array",
        description: "The operations to apply. Empty if the request is unclear.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: ["addProvider", "removeProvider", "addOff", "addPrefer", "setCap", "setTarget", "setTimeOfDay", "maxRun", "move"]
            },
            who: { type: "string", description: 'Full provider name as it appears in the roster, e.g. "Blake Lovely, MD".' },
            role: { type: "string", enum: ["PHY", "APC"], description: "For addProvider: PHY=physician, APC=nurse practitioner/PA." },
            target: { type: "integer", description: "For addProvider: target shifts per month." },
            value: { type: "integer", description: "For setCap/setTarget: shift count. For maxRun: max consecutive days." },
            tod: { type: "string", enum: ["day", "eve", "night"], description: "Time-of-day restriction. day<12:00, eve 12-18, night 18:00+." },
            dates: { type: "array", items: { type: "string" }, description: "ISO dates (YYYY-MM-DD) for addOff/addPrefer." },
            toWho: { type: "string", description: "For move: the provider receiving the shift." },
            date: { type: "string", description: "For move: ISO date of the shift to move from `who` to `toWho`." }
          }
        }
      }
    }
  }
};
async function handleChat(env, payload) {
  const { text, site, siteName, month, people, pool } = payload;
  const roster = (pool || []).map((p) => `${p.who} (${p.role}${p.tod ? ", " + p.tod + "s only" : ""}, target ${p.target})`).join("\n");
  const others = (people || []).filter((n) => !(pool || []).some((p) => p.who === n)).slice(0, 400).join(", ");
  const system = [
    `You are the scheduling assistant for ${siteName || site}, ${month}. Translate the scheduler's plain-English request into structured operations.`,
    `Resolve names to the EXACT full name from the roster or the wider staff list. If a name is ambiguous or not found, return no ops and ask for clarification in the reply.`,
    `Dates must be ISO (YYYY-MM-DD) within ${month}. Understand relative phrasing: "the first week" = days 1-7, "last week" = final 7 days, weekday names, "weekends", ranges like "the 8th to the 12th".`,
    `Operation guide: addProvider (needs role PHY/APC and a monthly target; include tod if they say "nights only" etc.); removeProvider; addOff (hard unavailable days); addPrefer (preferred days); setCap (max shifts); setTarget (monthly target); setTimeOfDay (nights/days/eves only); maxRun (global max consecutive days, no "who"); move (needs who, toWho, date \u2014 only if they name a specific shift to move).`,
    `Current roster:
${roster || "(none)"}`,
    others ? `Other known staff who could be added or referenced: ${others}` : ""
  ].filter(Boolean).join("\n\n");
  const { input, usage } = await callClaude(env, {
    system,
    userText: text,
    tool: CHAT_TOOL,
    maxTokens: 1024,
    effort: "low"
  });
  return { reply: input.reply, ops: input.ops || [], usage };
}
__name(handleChat, "handleChat");
var GEN_TOOL = {
  name: "emit_schedule_plan",
  description: "Analyze the provider history and requests, then set each provider's monthly target and write a short rationale.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["analysis", "notes", "targets"],
    properties: {
      analysis: { type: "string", description: "2-4 sentence plain-English summary of the staffing picture and how you balanced it." },
      notes: { type: "array", items: { type: "string" }, description: "Short bullet observations a scheduler would want (coverage gaps, fairness, staffing recommendations)." },
      targets: {
        type: "array",
        description: "Per-provider monthly target the deterministic engine should aim for.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["who", "target"],
          properties: {
            who: { type: "string" },
            target: { type: "integer" },
            reason: { type: "string" }
          }
        }
      }
    }
  }
};
async function handleGenerate(env, payload) {
  const { site, siteName, month, historyMonths, openSlots, providers, requests, rules } = payload;
  const provLines = (providers || []).map((p) => `${p.who} \u2014 ${p.role}; avg ${p.avg?.toFixed ? p.avg.toFixed(1) : p.avg} days/mo over ${historyMonths || "3"} months; usual shift ${p.usual || "mixed"}`).join("\n");
  const reqLines = (requests || []).map((r) => {
    const bits = [];
    if (r.off?.length) bits.push(`off ${r.off.join(",")}`);
    if (r.prefer?.length) bits.push(`prefers ${r.prefer.join(",")}`);
    if (r.cap) bits.push(`max ${r.cap}`);
    if (r.note) bits.push(`"${r.note}"`);
    return `${r.who}: ${bits.join("; ") || "\u2014"}`;
  }).join("\n");
  const system = [
    `You are a physician scheduler building the ${month} schedule for ${siteName || site}.`,
    `There are ${openSlots} open shifts to fill. Set each provider's monthly target so the schedule is fair and covers as much as possible.`,
    `Anchor each target to the provider's own recent average days worked (their normal load) \u2014 do not exceed it by more than one or two unless a request or shortage clearly warrants it. Honor stated caps. Keep night people on nights.`,
    `If the site is understaffed, say so plainly and estimate how many more providers are needed rather than overloading people. Write for a scheduler, not an executive.`,
    rules ? `Standing rules: ${rules}` : ""
  ].filter(Boolean).join("\n\n");
  const userText = `Providers (name \u2014 role; recent average; usual time of day):
${provLines}

Requests on file:
${reqLines || "(none)"}

Produce the plan.`;
  const { input, usage } = await callClaude(env, {
    system,
    userText,
    tool: GEN_TOOL,
    maxTokens: 2048,
    effort: "medium"
  });
  return { analysis: input.analysis, notes: input.notes || [], targets: input.targets || [], usage };
}
__name(handleGenerate, "handleGenerate");
var src_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        model: MODEL,
        hasKey: Boolean(env.ANTHROPIC_API_KEY),
        tokenRequired: Boolean(env.CONSOLE_TOKEN)
      }, 200, origin);
    }
    if (request.method !== "POST" || !url.pathname.startsWith("/api/")) {
      return json({ error: "not_found" }, 404, origin);
    }
    if (env.CONSOLE_TOKEN && request.headers.get("x-console-token") !== env.CONSOLE_TOKEN) {
      return json({ error: "unauthorized", message: "Missing or wrong console token." }, 401, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "not_configured", message: "Set the ANTHROPIC_API_KEY secret on this Worker (wrangler secret put ANTHROPIC_API_KEY)." }, 503, origin);
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "bad_request", message: "Body must be JSON." }, 400, origin);
    }
    try {
      if (url.pathname === "/api/chat") return json(await handleChat(env, payload), 200, origin);
      if (url.pathname === "/api/generate") return json(await handleGenerate(env, payload), 200, origin);
      return json({ error: "not_found" }, 404, origin);
    } catch (err) {
      return json({ error: "upstream", message: String(err.message || err) }, 502, origin);
    }
  }
};

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-F2Zifm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-F2Zifm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
