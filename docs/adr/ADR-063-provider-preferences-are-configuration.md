# ADR-063: provider preferences are configuration, eligibility stays computed

- Status: accepted
- Date: 2026-09-25
- Amends: ADR-032 ("the plan is a set, never an order")

## Context

ADR-032 decided that this repository only answers which providers _can_ serve
a request and never how to rank them: `provider.only` plus
`allow_fallbacks: true`, no `sort`, no `order`, because ranking inside the
eligible set was OpenRouter's job and a `sort` would bypass its own routing.

Issue #135 is what that costs. `deepseek/deepseek-v4.1-flash` was routed to a
provider writing 32 tokens per second: 9,787 output tokens took 306 seconds,
where a provider at 150 tokens per second would have taken 65. Relace showed
the same before. OpenRouter's default weighs price and stability, not
throughput, and for long agentic answers the throughput is what decides how
long a person waits. Blocking the slow provider of the day one by one treats
the symptom and needs a deployment each time.

## Decision

**How to choose is configuration; who can serve is still computed.** The
setting `ai.providerRouting` holds OpenRouter's `provider` object as the
deployment wants it for every request, and `AiModel.providerRouting` overrides
it per model. What ADR-032 computes is unchanged: the eligibility plan still
runs before every turn, and where there is one it becomes `only`.

**The object is OpenRouter's own vocabulary, not ours.** `sort`, `only`,
`ignore`, `order`, `allow_fallbacks`, `require_parameters` and
`data_collection` are typed because they are read or validated here; every
other key passes through as JSON (`providerRoutingSchema` in
`packages/contracts/src/provider-routing.ts`). A routing option OpenRouter
adds next is a change to the configuration, never to the request code, and no
model or provider has a line of its own anywhere in the code.

**A model overrides keys, not the object.** `mergeProviderRouting` lays the
model's keys over the global ones one at a time: absent inherits, a value
replaces, `null` removes the global key for that model. A list is a value like
any other, so a model's `ignore` replaces the global list rather than
extending it -- a merged allowlist is one nobody wrote down.

**`only` and `ignore` narrow the snapshot before the plan is made.**
`restrictEndpoints` applies them to the endpoint snapshot, and the budget and
every turn's plan are computed from what is left. Sending them only along with
the request would let the plan name a provider the configuration excludes,
compaction would aim at a window nobody may serve, and `only` and `ignore`
could cancel each other out upstream. When a plan exists its list replaces a
configured `only`, which is then the same list minus the providers too small
for this turn; `allow_fallbacks` stays `true` unless the configuration says
otherwise, so failover between the eligible providers keeps working.

**The adapter asks, every caller benefits.** `OpenRouterProvider` takes a
`providerRoutingFor(model)` function and calls it for every request, so a
compaction summary, a memory capture or an automation's answer is routed the
same way as a chat turn, without each call site having to remember it. The
worker and the API each build it with `createProviderRoutingResolver` from
their own settings reader and a one-column read of `ai_model`, cached per
model for fifteen seconds. A lookup that fails costs the request its
preferences, never the request.

**The empty object is the default,** and with it every request goes out
exactly as ADR-032 left it. A `sort` is a decision a person makes, with the
trade-off ADR-032 named: a sorted request no longer gets OpenRouter's own
ranking, including its preference for providers that call tools well.

**The routing a request asked for is logged.** Whenever configured
preferences shape a request, the adapter logs the resulting `provider` object
with the correlation id, so it can be read beside OpenRouter's activity log.

## Consequences

- ADR-032's "a plan is a set, never an order" now describes the plan, not the
  request. The plan still ranks nothing; the configuration may.
- The setting is deployment-wide (`SETTING_SCOPES`): which providers see a
  deployment's data and in which order is decided once, and a workspace's own
  key changes who pays, not how it is routed.
- Both halves stay out of reach of an agent, like the rest of
  `/api/admin/settings` and `/api/admin/ai-models`.
- A configuration that excludes every provider of a model is not caught
  locally: the plan degrades to "no snapshot", the configured `only` and
  `ignore` still go out, and OpenRouter answers for it.
