# ADR-033: Web research is two REST calls, and the address check is ours

- Status: accepted
- Date: 2026-09-18

## Context

The built-in AI could read everything in this deployment and nothing outside
it. Forty-six tools, all `exo_`, all behind `/api/…`. That is not a gap in the
coverage of a capability; the capability did not exist.

Two things had to be decided to change that, and both are the kind that are
cheap now and expensive later.

**How the browser is reached.** Steel runs on this host already. The obvious
route is [`steel-dev/steel-mcp-server`](https://github.com/steel-dev/steel-mcp-server),
which would make the worker an MCP _client_ for the first time. That server is
built on the Web-Voyager pattern: click, scroll, type, screenshot with numbered
marks. Every step is a round through the model loop and every screenshot is a
vision call, so the driver model must have vision and "read me this page" costs
a dozen images for something that is text.

The round count is not the argument -- a cheap model may take twenty rounds. The
shape is. Agentic clicking answers "operate this interface"; it does not answer
"read this".

**Where search comes from.** Steel fetches a page it is handed. It has no index.
Without a search source, a run needs an address it already knows, which is
looking something up rather than researching. DuckDuckGo has no web-search API:
`api.duckduckgo.com` returns instant answers, and everything calling itself a
"DuckDuckGo API" scrapes `html.duckduckgo.com` against the terms of service,
gets rate-limited hard, and breaks regularly -- worse from a datacentre address
than from a home line. Brave's free tier ended in February 2026.

## Decision

**1. Steel is reached over its REST API, from `apps/api`.**

`POST /v1/scrape` renders a page and returns it cleaned up in one call.
`packages/ai/src/steel.ts` is a typed client over it, built like `docling.ts`:
zod-parsed answer, unknown keys dropped, and no client at all without a base
URL, so an unconfigured deployment says "not set up" instead of failing at
request time.

The architectural half matters more than the protocol half. Going through REST
is what keeps rule 11 and ADR-014 true: the catalogue reaches the domain through
the API, authorization stays in `apps/api`, and external MCP clients get the
capability for free. An MCP client inside the worker would have given the
built-in AI something Hermes and Claude Code never see -- the first drift
between the two surfaces that one catalogue exists to prevent.

**2. Search is a self-hosted SearXNG, and it is a second client.**

`packages/ai/src/searxng.ts`, behind `SEARXNG_BASE_URL`, container in
`docker-compose.yml`. Metasearch means DuckDuckGo's results without us scraping
DuckDuckGo, and it means every query stays on this host instead of handing a
search vendor the full record of what this deployment wondered about.

The honest cost is written into the code rather than discovered later: SearXNG
scrapes the engines itself, and from this address some of them answer with a
CAPTCHA (DuckDuckGo does, measured 2026-09-18). So `unresponsiveEngines` travels
all the way to the caller. Without it, a throttled engine and a genuinely rare
topic produce the same short list.

**3. Two tools, not one.** `exo_web_search` finds addresses, `exo_web_fetch`
reads one. A merged "research this" would fetch every hit it found. Split, the
model reads eight snippets and fetches the two that look like answers, and that
decision is most of what research costs.

**4. The address check is ours, it runs before the browser, and it judges the
resolved address.**

Steel sits in this host's Docker network. A fetch it performs starts _inside_
the perimeter: nginx never sees it, fail2ban never sees it. `http://grafana:3000/`
is answered (measured). So `apps/api/src/research/public-address.ts` refuses
anything that is not `http`/`https`, and anything whose **resolved** addresses
are not globally routable -- including a name that does not resolve out here at
all, which is the ordinary shape of an internal one. The check runs again on the
address Steel says it ended up at, because a redirect is the cheapest way past a
check that only reads what was typed.

Two limits are stated rather than implied. DNS rebinding is not covered: we
resolve, approve, and Steel resolves again. Closing it needs an egress firewall
around the container, which is host configuration. And our own back ends are
deliberately outside this rule -- SearXNG and Steel are on loopback and would
fail every part of it. The check guards a parameter a model supplied, not the
outgoing HTTP layer; putting it in the HTTP layer would make the feature block
itself.

**5. The budget is a per-run count in the worker, and the switch defaults to
off.** `ai.webResearchEnabled` is `false` because outgoing traffic to addresses
a model chooses is not something an update may quietly start doing on somebody's
server. `ai.webResearchMaxFetchesPerRun` is counted in `tool-runner.ts` and
nowhere else, because only the loop knows what a run is; at zero the fetch tool
leaves the catalogue rather than refusing every call. The count is spent on the
attempt, not on the page, so a run cannot retry a broken address for ever.

## Consequences

- A fetched page is foreign text. ADR-030 already named `web` as an origin, so
  `untrustedOutput: 'web'` on both tools fences the result as data and closes
  mutating tools for the rest of that run. Turning research on does not widen
  what a poisoned page can ask for.
- `steel-mcp-server` stays possible later as a second, explicitly agentic mode
  for "fill in this form". That needs the worker as an MCP client and is its own
  decision, not this one.
- An engine SearXNG cannot reach is maintenance, not a bug. The repair is the
  engine list in `deploy/searxng/settings.yml` or Steel's proxy support, and the
  symptom is visible in `unresponsiveEngines` rather than silent.
