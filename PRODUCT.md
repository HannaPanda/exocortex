# Product

## Register

product

## Users

Two overlapping groups, in this order of priority:

1. **The daily solo user.** Johanna, using eXocortex every day as a personal
   external brain. Long sessions, deep page hierarchies, high tolerance for
   information density. She knows the tool by heart, so speed and keyboard
   access matter more than discoverability. She is not exploring; she is
   working.
2. **A small team alongside her.** A handful of people editing the same pages,
   with presence, remote cursors and shared structure. Collaboration is real,
   not theoretical, but it is a second layer on top of a tool that must already
   be excellent for one person.

The job to be done splits evenly between two tasks that must both work on any
screen:

- **Writing without friction.** Get a thought into a page and keep going. The
  editor is where the time is spent.
- **Finding it again.** Search, navigation and hierarchy. A note that cannot be
  retrieved was never worth writing.

Neither task outranks the other. A design decision that speeds up writing at the
cost of retrieval is not an improvement.

## Product Purpose

eXocortex is a self-hostable, collaborative workspace and external brain:
hierarchical pages, real-time collaborative editing, full-text search, Markdown
interchange, background automation and an AI side panel, in one deployment the
user controls.

It exists because the alternatives force a trade: hosted tools own your data,
and local tools do not collaborate. eXocortex refuses both. Self-hosting is not
a feature flag here, it is the premise.

Success looks like: the daily user stops thinking about the tool. Pages are
created, linked, found and edited without the interface asking for attention.
The team layer works when needed and is invisible when not.

## Brand Personality

**Precise. Fast. A spark of cyberpunk.**

- **Precise** — the interface behaves exactly as expected, every time. Nothing
  approximate, nothing decorative pretending to be functional. Labels say what
  they mean. State is always legible.
- **Fast** — speed is the product's personality, not just its performance
  budget. Keyboard first. No waiting states where an optimistic one would do.
  Density over padding when the two conflict.
- **A spark of cyberpunk** — this is a tool with a point of view, not neutral
  infrastructure. It should read as an instrument: engineered, slightly severe,
  built for someone who knows what they are doing. The spark is a _spark_, not a
  theme. It shows up in restraint and edge, not in neon signage.

Voice: German for everything the user reads, direct and warm, second person
informal (du). Short sentences. No corporate hedging, no exclamation marks, no
apologising interfaces. English for code, logs, identifiers and API error codes.

## Anti-references

- **Hacker-terminal green.** Saturated green on near-black reads as Matrix
  cosplay. It is the first reflex for any "second brain" tool and it is not what
  this is. The current palette falls into this trap and is being replaced.
- **Neon-on-black cyberpunk.** The obvious escape from the point above is
  cyan-and-magenta glow, scanlines and glassmorphism. That is the same reflex one
  tier deeper. Cyberpunk here means precision instrument, not arcade cabinet.
- **Notion beige.** Soft, generic documentation-tool look: emoji icons,
  undifferentiated whitespace, no stance. Friendly to the point of having no
  opinion.
- **Enterprise SaaS.** Cards everywhere, dashboard grids of identical tiles,
  gradient hero metrics, corporate blue, feature-tour modals on first login.

## Design Principles

1. **Speed is a design decision, not an optimisation.** If an interaction can be
   done with the keyboard, it must be. If a result can be shown optimistically,
   show it. Perceived latency is a design bug and gets fixed in design.
2. **One clear next action per screen.** The daily user has ADHD. Competing
   calls to attention are a defect. Every screen answers "what do I do here"
   without being read twice, and never asks the user to hold state in their head
   that the interface could show.
3. **Retrieval is a first-class surface.** Search, navigation and hierarchy get
   the same design investment as the editor. Finding is not a support feature.
4. **A stance, not a style.** The interface commits to a look and holds it.
   Neutrality is not safety, it is the absence of a decision. Every element
   should be defensible as intentional, including the restrained ones.
5. **Collaboration is visible, never loud.** Presence, cursors and remote
   changes are legible at a glance and never steal focus from the writer. Other
   people in the document are information, not interruption.

## Accessibility & Inclusion

- **WCAG 2.2 AA is the floor**, not the goal. Contrast, focus rings, keyboard
  operability and screen-reader labels are assumed, not celebrated.
- **ADHD-friendly is the sharpened requirement.** Few competing stimuli, calm
  motion, an obvious next action, no attention noise, no interfaces that require
  remembering where you were. This constraint outranks visual ambition when the
  two conflict.
- **Colour is never the only carrier of meaning.** Status, validation, diff
  state and presence must all be readable without colour perception. Presence
  colours stay distinguishable under the common forms of colour vision
  deficiency.
- **Motion respects `prefers-reduced-motion`.** Every animation has a reduced
  variant, and the reduced variant is a complete experience, not a degraded one.
