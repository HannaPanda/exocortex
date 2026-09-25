# ADR-032: A request is routed to the providers that can serve it

- Status: accepted, amended by ADR-063 (configured provider preferences)
- Date: 2026-09-16

## Context

A model on OpenRouter is not one endpoint. GLM 5.3 is served by twenty-nine
providers at once, and they disagree about the model: one offers a 262,144-token
window, most offer 1,048,576, one offers 1,310,720, and the price per million
input tokens ranges from $0.88 to $2.10. The router picks one of them per
request, weighting stable providers by the inverse square of their price, so the
cheap small one is a likely destination. Nothing in OpenRouter's documentation
promises that a provider too small for the prompt is skipped.

The registry stored a single `contextWindowTokens` per model, which forced a
choice between two wrong answers (issue #68):

- the smallest window, and a conversation compacts at a quarter of the capacity
  it actually has;
- the largest, and a long conversation is routed to the 262k provider and
  refused.

The `~vendor/model-latest` aliases make it sharper. Their catalogue row carries
the figures of the _cheapest_ endpoint rather than of the model, and the
endpoints route does not resolve an alias at all, so reading an alias' own row
understated GLM's window by a factor of four while the alias kept pointing at a
model that changes under it.

## Decision

### The registry remembers every provider, not a summary of them

`AiModelEndpoint` holds one row per provider per model: the routing key, the
context window, the separate input cap where there is one, the output limit, the
prices, and whether that provider supports tools and effort levels. It is a
snapshot, refreshed on a schedule and by the admin sync, never read live in the
request path.

The routing key is `endpoints[].tag` from the provider's own answer
(`reka/fp8`), verbatim. Its value and its part before the slash are both
accepted by `provider.only`, and the set of tag prefixes matches the provider
slugs OpenRouter names in its error messages one for one. `provider_name` is a
display string and is never sent back.

For an alias, the snapshot describes the alias' current target and the row
records which model that is (`AiModel.aliasTargetSlug`). The registry's slug
stays the alias, because the whole point of an alias is that it keeps moving.

### The model-level window is the largest a provider offers

`AiModel.contextWindowTokens` becomes the upper bound: the largest window any
provider of this model serves. It is what compaction aims at and what the
context meter shows. Safety does not come from this number being small; it comes
from the request-time filter below. The prices stay pessimistic (the highest any
eligible provider charges), because an estimate that is too high is the harmless
direction and the router genuinely may pick the expensive one.

A model with no snapshot keeps the old arithmetic on its catalogue figures. A
refresh that fails keeps the snapshot it has: a coherent old picture beats no
picture, and beats half of a new one.

The same degradation covers a disagreement between the two sources. When no
provider in the snapshot can do what a run needs -- the registry says the model
thinks, its only provider says otherwise -- the request goes out with no
preference at all rather than with an empty allowlist. The snapshot is the
younger and narrower source, and a model that worked yesterday must not stop
working because two pieces of provider metadata disagree.

### Eligibility is decided per turn, and only eligibility

`planRoute` (`packages/ai/src/route-planner.ts`) answers one question: which
providers _can_ serve this request. An endpoint is eligible when its usable
window takes the estimated prompt plus the reserved answer, when its own input
cap is not exceeded, when its output limit is at least the requested answer
length, and when it supports what the run needs (tools, effort levels). The
usable share is `ai.compactionThresholdPercent`, the same number compaction
triggers at, because token counts are estimates and the last few percent of a
window are not worth planning for.

The plan is a set, never an order. No price, latency or uptime scoring happens
in this repository: `provider.only` plus `allow_fallbacks: true` hands the
choice inside the eligible set back to OpenRouter, including its failover. A
`sort` or a fixed `order` would replace its routing with ours and, for tool
calls, bypass its own tool-quality routing.

It is re-planned before every turn rather than once per run. A tool result is
part of the next prompt, and fifty thousand tokens of search output can put a
turn beyond the provider that served the one before it.

### Compaction is a response to nothing fitting, not to a provider being small

The old question was "does this conversation still fit the model's window". The
new one is "can any provider still serve it". When the answer is no, the run
compacts and re-plans -- but only when making the prompt smaller would change
the answer. A request no provider can serve because it needs tools, or because
the answer is capped too high, is not a size problem, and summarising away a
piece of the transcript for it would cost a model call and buy nothing. That is
what `couldCompactionHelp` compares the conversation's floor (system prompt,
kept tail, room for the summary) against.

When nothing is eligible and compaction cannot help, the run fails locally with
`ai_no_eligible_provider` instead of paying for a request that would come back 404. By then it is always a size problem: the capability case degraded to no
preference above.

### The snapshot keeps itself current

`sync-ai-model-routes` runs hourly, refreshes the registered OpenRouter models
stale-marked-first, resolves aliases again, and replaces each snapshot in one
transaction. A run that sees an alias answer as a different model than the
snapshot describes marks the row and asks for that refresh immediately, so a
`latest` that moves is followed without a deployment and without a human.

## Consequences

- The registry has a second table that is derived data, and a model can be
  registered without it: routing then falls back to letting OpenRouter choose
  freely, which is what every request did before this.
- `AiModel.contextWindowTokens` no longer describes "the" context window of a
  model, because there is no such number. It is an upper bound, and the context
  meter is an upper bound with it.
- The worker makes no extra request per turn: the plan is computed from the
  snapshot the run already loaded with the model row.
- An alias is now a reasonable thing to register. Its figures describe the model
  it points at, and both follow when it moves.
