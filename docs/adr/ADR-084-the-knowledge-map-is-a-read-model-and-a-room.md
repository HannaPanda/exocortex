# ADR-084: the knowledge map is a read model, and a room of its own

- Status: accepted
- Date: 2026-10-12
- Relates to: ADR-020 and ADR-034 (the vectors it reuses), ADR-025 (parity), ADR-044 (confined credentials), ADR-065 (edit notices), issue #189

## Context

Johanna asked for the "Jarvis" view that second-brain tools show: the whole
brain as a graph, every relation visible, and flashy rather than sober. A
second wish came with it: give the assistant a task without a page open and
watch the pages light up, appear and disappear while it works.

Everything the picture needs already exists, in four places. References are
the link index materialization keeps. Similarity is the search vectors, which
"Verwandte Notizen" (issue #33) already asks one page at a time. Entity
mentions are the entity layer's rows. The hierarchy is the tree. What did not
exist was one answer holding all of them, and a signal saying which page a
run is touching while it reads, because `ai.run.tool_call` named only the page
a call changes.

Two constraints shaped the rest. The design system forbids motion that does
not report a state (`DESIGN.md`, the Motion-Is-State Rule), and the map is
exactly a surface that moves to look alive. And the API runs on one event
loop: asking pgvector for every page's neighbours took 5.7 s for the 770
pages of the Second Brain, and the same matrix in process 0.7 s, both too long
to spend every time a run re-embeds the page it just wrote.

## Decision

- **A read model, nothing stored.** `GET /api/workspaces/:x/map` answers every
  page that is not in the trash as a node, and four kinds of line: `link`,
  `similar`, `entity`, `tree`. A transclusion is no kind of its own, because
  it lives only in page content and no index holds it. A node carries enough
  to draw and label a point, never the page's text. The route takes the whole
  workspace or nothing: `requireRole` refuses a credential confined to some
  pages (ADR-044), since which pages exist around a branch is what a
  confinement withholds.
- **A similarity line is the connection nobody drew.** Each page keeps its
  three nearest neighbours from a cosine of 0.55 (higher than the panel's
  0.35, because the map draws every page's lines at once), and a pair already
  joined by a reference, a mention or the tree is left out. The tree counts as
  a connection even when it is hidden, so hiding it does not turn parents and
  children into similar pairs.
- **The similarity index lives in the API's memory and is incremental.**
  `SimilarityIndex` keeps every pair above the floor (a few thousand) and the
  vector version of each page. Each request reads ids and stamps, fetches only
  vectors whose stamp changed, and recomputes one matrix row per changed page,
  about 2 ms. The first build yields to the event loop every 40 rows. Updates
  of one workspace are serialized. Losing the index on a restart costs one
  build.
- **A tool call names its subject.** `ai.run.tool_call` gained `subject`: the
  page the call is about, the target when it names a page, otherwise the
  call's `documentId` argument. Still an id and never the payload, refused
  when the argument is not shaped like an id. A write from an external agent
  already arrives as `document.content.replaced`; creation, archiving and
  deletion have their own events.
- **An external agent's read is announced.** An agent over MCP reaches the
  API directly, so its reads left no trace while its writes lit up. The page
  read and the fragment read send `agent.page.read` (page id and client label,
  nothing else) when the request named an agent session (ADR-022) and no run
  of the built-in AI made it, so a person in the browser is never announced
  and a run's read is not announced twice. Sent after the read answered,
  never awaited, never stored.
- **Names follow activity, and the screensaver plays it.** No point carries
  its title permanently any more; a name appears while a point is lit,
  hovered, selected or found, and the light lasts half as long again so it can
  be read. The screensaver (`map-screensaver.ts`) lets five imaginary walkers
  loose: one follows references, one similarity, one the page tree depth
  first, one reads around a page and then writes it, one looks anywhere. Each
  step goes through the same `pulse` a real event does, and nothing reaches
  the server, the live feed or the memory. A lit point gives off a light,
  capped spark of motes.
- **The browser merges, it does not reload.** A fresh answer is merged into
  the graph on screen, keeping the objects (and with them the positions) of
  points that stay, so only the new parts arrive and flash. The map refetches,
  debounced, on the events that change points or lines, and never on a timer.
- **A room of its own.** `/arbeitsbereich/:x/karte` is the one route the shell
  draws without its page tree; the context panel stays, and without an open
  page it is the assistant alone. It opens once on arrival, and closing it on
  the map stays closed.
- **An exception to the motion rule, bounded by name.** The Map-Is-A-Room Rule
  in `DESIGN.md` lets the canvas turn slowly while idle, carry light along its
  lines and glow on a new token, `map-space`. Inside it the rest of the system
  holds: amber means a run is touching that page now and fades; a new page is
  `success`, a removed one `destructive`, a read `info`; every one of them is
  also a line of text in the live feed; there is a calm switch; and
  `prefers-reduced-motion` stops the room, the light and the camera flights
  without losing anything else. Every colour on the canvas is read from the
  tokens at runtime, because WebGL knows no CSS variable.
- **The tool says what the picture shows.** `exo_knowledge_map` returns the
  whole graph as structured data and, as text, what a model can use: hubs
  without the tree, the biggest branches, pages standing alone, and the
  strongest similar pairs nobody linked, which is the work of linking.
- **A point is a star, and its look is the viewer's.** Every point is a small
  core in the page's shape with a soft halo that faces the camera; the halo
  carries the colour, so branches stay apart where the bloom alone washed them
  towards white. It was chosen from six styles side by side. Bloom, halo,
  saturation, an optional sRGB output pass and a glow and lightness per colour
  are tuned in a panel on the map with the canvas as its preview, stored on
  the account (`User.knowledgeMapAppearance`, `NULL` is the defaults) under
  `/api/me/knowledge-map-appearance`, and read back over the defaults, so a
  key added later needs no migration. Taste follows the person, not a
  workspace. The colours stay the tokens; only how they become light is
  stored. `exo_knowledge_map_appearance` and `_set` reach the same.

## Consequences

- A map of the Second Brain is one request of about 1 MB and no model call.
  A workspace an order of magnitude larger will want a level of detail; the
  route's shape allows it (a branch filter) without changing a node.
- The library is `3d-force-graph` on `three`, both MIT, loaded only on this
  screen. Its constructor is declared for its bare defaults; the map narrows
  it once, in `map-engine.ts`, with the reason beside it.
- Reads lighting up depends on a tool naming its page `documentId`. A tool
  that reads through another argument stays dark until it does, which is
  visible and harmless.
- The slider the timeline needed is a new primitive in `@exocortex/ui`,
  installed through shadcn and moved onto Base UI like every other.
