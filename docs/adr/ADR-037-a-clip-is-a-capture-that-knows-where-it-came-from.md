# ADR-037: a clip is a capture that knows where it came from

- Status: accepted
- Date: 2026-09-18

## Context

Issue #72 asks for two ways into this system from outside a page: a clipper in
the browser and a share target on the phone. The parts each of them needs were
already built for other reasons. ADR-036 put quick capture and the inbox in
place, so there is somewhere for an arriving thing to land and a way to file it
afterwards. ADR-033 put a browser and an address check in place, so a page can
be read at all, and read safely.

What was open was the shape of the arriving thing. A clipper invites a second
content type: an object with a URL, a fetch date, an article body, maybe the
original HTML. Notion, Obsidian and Readwise all have one, and each of them has
the follow-on problem that goes with it, where search, references, exports and
backlinks have to learn about a kind of content that behaves almost but not
quite like a page.

Three smaller questions came with it. Where does provenance go on the page?
Which of the two senders gets the route? And what happens when the built-in AI
does the clipping rather than a person.

## Decision

**A clip is a capture with a provenance line, and nothing else is new.** The
API call builds Markdown and hands it to the capture path, which creates an
ordinary page through the ordinary services. No property schema, no frontmatter
block, no `Clip` model. The issue asks for properties carrying source, URL and
time; a page outside a collection has no property schema to carry them (ADR-011
puts properties on rows of a database), so an invented one would be a private
format that only the clipper writes and only the clipper reads. The provenance
is a sentence instead, in the text, where search finds it and a human reads it.

**Provenance stands at the top, the selection is a quote, the article follows a
rule.** Capture puts its source line at the end, which is right for three lines
of text and wrong for twenty thousand characters of article. The order on a clip
is: where this came from and when, then what the person had selected, as a
blockquote, then a horizontal rule, then whatever the browser read. The rule is
worth its line: it is visible on the page where this deployment's words end and
the web's begin.

**Reading the page is opt-in, and it is the only part that touches the
network.** A clip with `fetchPage: false` writes down an address and a
selection and makes no request at all, which is what a share from a phone on
mobile data should cost. With `fetchPage: true` the request goes through
`ResearchService.fetch`, so the address check of ADR-033 applies unchanged,
including the second check after a redirect. The clip path adds one rule of its
own, about the string rather than the network: a `javascript:` or `data:`
address is refused even when nothing is fetched, because it would be written
into the page as a link for somebody to click later.

**One route serves the share target and the bookmarklet.** `/teilen` takes
`url`, `title` and `text` as query parameters. The share target is declared as a
GET in the manifest for that reason: a POST target would have to be intercepted
by the service worker, and that worker exists to make the app installable and
answers nothing else on purpose (it caches nothing, because the canonical state
of a page is a Yjs update). The bookmarklet fills the same three parameters from
`location`, `document.title` and the selection, so every browser that will never
have a share target still has a clipper. Since a shared link arrives in `text`
rather than `url` on a good share of Android targets, the page reads the address
out of whatever came instead of trusting the field.

**`exo_clip` carries the web fence although it returns no web text.** The tool
answers with where the clip landed, never with what the page said, so nothing
foreign enters the run's context through it. That is not enough: a run could
clip a hostile page and then read it back as an ordinary workspace page, which
is exactly the route ADR-030 closes for `exo_web_fetch`. So the fence follows
the browser rather than the text, and after a clip the run writes nothing more.
The tool's description says so and names `exo_capture` with `sourceUrl` as the
call to use when only the address is wanted, which keeps a run writing.

## Consequences

- A clip is searchable, linkable, embeddable, archivable and movable on the day
  it is written, because there is nothing about it that is not a page.
- A clipped article is the web's text in this workspace, and reading it later
  is reading a page. The fence on `exo_clip` stops the run that made the clip;
  it does not mark the page. A general answer would be provenance on the page
  itself, which is a larger change than this issue, and which a human clipping
  a hostile page would need just as much.
- Filing a clip is the existing `suggest-parent` plus `move`, reached from the
  page's own header, because the page sits in the inbox like every other
  capture. The share form deliberately has no place picker.
- `fetchPage` costs a Steel render and is clamped at 60000 characters, which
  leaves room under the capture path's 100000 for a long selection beside it.
  A cut article says so in the answer rather than pretending to be whole.
- The bookmarklet is built from `window.location.origin` at click time, so a
  self-hosted deployment gets a bookmarklet pointing at itself without anybody
  configuring anything.
- An article that opens with its own headline loses it when the headline is the
  page's title, so the title is not on the page twice.
