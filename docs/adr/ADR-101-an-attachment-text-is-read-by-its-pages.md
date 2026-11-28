# ADR-101: an attachment's text is read by its pages, and a long one answers with its map

- Status: accepted
- Date: 2026-11-28

## Context

`exo_attachment_read_text` answered with the whole extracted text of a file,
up to `ATTACHMENT_TEXT_MAX_CHARS` (400,000 characters). Pages have been read
within a budget since ADR-056; attachments had nothing of the kind, no budget,
no outline, no way to ask for a part. On the day this was decided the largest
stored PDF text was 141,919 characters (49 pages), thirteen were above 10,000
and the worker cuts every tool result at 30,000. So a question about page 40
of a report either filled most of an agent's context or arrived as the first
30,000 characters with a note that the rest was gone, which is the shape of
the failure ADR-056 was written against.

Johanna decided the direction on 2026-11-28 (issue #326, point 5): reading
with an outline, the way pages are read. Passages with vectors and attachment
passages in `exo_context_compile` (ADR-061) were considered in issue #133 and
are deliberately not part of this.

For a PDF the natural unit of that outline is the page. The extraction did not
keep pages. Docling's Markdown has no page boundaries, and its
`md_page_break_placeholder` does not supply them: it is written only between
two items on different pages, while a paragraph running from one page onto
the next is one item. Measured on a twelve-page PDF: three placeholders. The
JSON that Docling already returns beside the Markdown does know: every item
carries one provenance per page it touches, with the character span of that
page's share of the item's text.

## Decision

**Page starts are stored beside the text, as offsets into it.**
`Attachment.textPageStarts` is an integer array: entry `i` is the UTF-16
offset in `extractedText` where page `i + 1` begins, `-1` for a page whose
start could not be placed, empty when nothing is known. It is written in the
same update as `extractedText`, so a re-extraction can never leave the starts
of an earlier text behind, and cut with it at `ATTACHMENT_TEXT_MAX_CHARS`.

Three other shapes were considered.

- **A marker in the text** (a form feed, as pdftotext writes it). Rejected:
  the text is read by the search projection, the chat prompt, the correction
  dialog and the screening, and each of them would have to learn to ignore a
  character it never asked for. A person correcting a scan would edit the
  markers too.
- **Pages as rows.** Rejected: nothing queries a page on its own, and a row
  per page multiplies writes for a value that is only ever read with its text.
- **Recomputing on read** from Docling's JSON. Rejected: the JSON is not
  stored, and storing it to save an integer array would be the wrong trade.

Offsets are UTF-16 code units because every reader indexes a JavaScript
string with them. (The search block map of ADR-100 counts code points because
its reader is PostgreSQL; this one has none.)

**Docling's pages are placed by finding text, in order.** `locateDoclingPages`
walks the document's items in reading order, furniture left out as the
Markdown leaves it out, and finds a short stretch of each item's text in the
Markdown after the item before it, allowing for the serializer's escapes
(`\_`, `&amp;`). A page begins where its first share was found; inside an
item when a paragraph runs on, at the start of the line when the item begins
there. A page that cannot be placed (a picture alone, an empty page, an
escape this does not know) is `-1`, never a guess, and a reader joins it to
the page before it: "pages 4 to 5" is honest where "page 4" with page 5's
text in it is not. On a 19-page specification with tables and escaped
identifiers every page was placed. OpenRouter's fallback engine writes
`### Page N` into its answer; those headings are its page starts. Office
formats have no pages, because nothing in a docx says where Word would break
it.

**A correction has no pages.** It is a person's text, and may have moved a
paragraph across a page boundary. The starts describe `extractedText` only and
are ignored whenever `correctedText` is the effective text.

**The read takes a budget and answers with a map over it** (ADR-056, for text
without blocks). `GET /api/attachments/:id/text` accepts `maxChars`,
`maxEntries` and a stretch, `fromPage`/`toPage` or `fromChar`/`toChar`.
Without any of them it answers exactly as before. With them, a stretch that
fits the budget comes back as content with its position; one that does not
comes back as a map, and `text` is empty: never a prefix. The map is built by
one rule at every depth, in `packages/contracts/src/attachment-text-map.ts`:

    pages -> headings -> paragraph windows -> content

A stretch covering two or more pages is mapped by its pages (size and first
line). One that does not is cut at the shallowest Markdown heading level that
divides it into two or more parts, fenced code excepted. One without dividing
headings is cut into windows of whole paragraphs no larger than the budget,
splitting a paragraph at line breaks and then at spaces only when it alone
exceeds it. So the floor is always content, every character is reachable,
and no map can contain only itself. Over `maxEntries` neighbours are merged,
never dropped, and opening a merged entry maps it finer.

**The tool sends the page read's budget.** `exo_attachment_read_text` sends
`PAGE_CONTENT_BUDGET_CHARS` (10,000) and `PAGE_MAP_MAX_ENTRIES` (40) on every
call, the numbers `exo_page_read` sends, on both agent surfaces. A read never
starts new work beyond what it started before (an extraction a missing text
is owed); no summary is computed to fill a map.

**The fence and the trust answer are unchanged.** The map's titles are the
document's own first lines, so a map is fenced as attachment content exactly
like the text (ADR-030), and `trust` (ADR-096) is computed and passed on as
before.

## Consequences

An agent reads a 49-page report in two calls of a few thousand characters
instead of one of 140,000: the map, then the pages that answer the question.
The chat note for a document cut at the 24,000-character prompt budget
(ADR-095) now says to read the needed stretch through the map rather than
"the rest".

Every PDF extracted before this has no page starts and is mapped by headings
and paragraph windows, which works but is coarser. It gains pages on its next
extraction (`exo_attachment_reextract_text`, or the button in the file bar).
There is deliberately no sweep re-extracting every stored PDF: it would cost
CPU minutes per document and a screening call each, for an outline that is
already usable without it.

What this does not do: no passages and no vectors for attachment text, no
attachment passages in `exo_context_compile`, and a keyword hit in an
attachment still names the file and not the page (ADR-100), which would need
the page starts carried into the search block map.
