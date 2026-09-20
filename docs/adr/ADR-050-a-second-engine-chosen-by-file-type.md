# ADR-050: a second extraction engine, chosen by file type, and the text goes into the index

- Status: accepted
- Date: 2026-09-20

## Context

Issue #38 proposed the anydoc library in two parts. The first was speed: put it
in front of the PDF chain, because a text PDF takes milliseconds there and
seconds in Docling. The second was reach:
`apps/worker/src/processors/attachment-text.ts` stopped at anything that was
not `application/pdf`, so a Word document uploaded here was a file you could
download and nothing else.

The issue asked for a measurement before any wiring. Three facts came out of
it, and one of them was not about anydoc at all.

**anydoc is faster and reads worse.** Measured against the PDFs this
deployment holds, it is 30 to 100 times faster than Docling. On the two that
are this deployment's own xelatex output (ADR-026) it came back with 689
line-break hyphens left in place and twice as many run-together words:
`DamitkanndiesesTokenimBrainphysischnichtsverändern` where Docling spaces the
words. That text is what the search index and the embeddings are built from, so
the trade is milliseconds against findability, on exactly the documents
eXocortex produces itself. The numbers are in `docs/ai-architecture.md`.

**Its refusal is precise.** A scan does not come back as empty text: it rejects
with `needsOcr` naming the pages, having classified them without rendering
anything. That answers the issue's open question and is worth writing down even
though nothing uses it yet.

**The text was never searchable — not for office documents, and not for PDFs
either.** `index-document.ts` projected only the page's own `plainText`. Ten
attachments on this deployment contained the word "HessenLand" and not one
search index row did. The feature registry had said, since 2026-08-06, that
"der Text ist Teil der Suche". So "make office documents findable" was not an
extension of something that worked; it was the missing half of something that
never had (issue #101).

## Decision

**One job, two engines, chosen by MIME type — and the choice is one predicate.**
`attachmentTextEngine` in `@exocortex/contracts` answers `'pdf' | 'office' |
null`, and it is what the upload, the read that starts an extraction, the forced
re-extraction, the human correction, the worker and the editor's file bar all
ask. Five places used to spell `=== 'application/pdf'` themselves; a docx
offering a text bar it could never fill is what their disagreeing would look
like.

**PDF keeps its chain and anydoc stays out of it.** The measurement is the
reason, not a preference: `ai.pdfExtractor` still chooses between Docling and
OpenRouter, and the local converter never sees a PDF. Part one of issue #38 is
declined, with the numbers attached.

**The office converter gets no chain, no fallback and no timeout.** It is the
only engine that reads these twelve formats, so there is nothing to fall back
to; it is an in-process library call, so there is nothing to wait on. What it
does have is the same split the PDF chain already makes between a settled
answer and a retry: a refusal that names the document (`encrypted`,
`malformed`, `unsupported`, `missingPart`, `resourceLimit`) is written to the
row as the sentence a reader sees, and anything else is rethrown so BullMQ
tries again.

**It never sends a document anywhere.** The library offers a `hosted` OCR mode
that uploads to Firecrawl's API. It is not used, and the reason is in the file:
a local extractor that quietly ships a file off the machine is not a local
extractor. Scans are Docling's job, and Docling runs in a container on this
host.

**Detection looks inside the container, or the whole feature is unreachable.**
Every OOXML and OpenDocument file is a ZIP archive; the legacy trio is an OLE
compound file. The existing signature table would have matched `PK\x03\x04`
first and stored every docx as `application/zip`, which is not a type any engine
reads — the feature would have shipped and done nothing. So `detectMimeType`
resolves the container: OpenDocument and EPUB by the stored first entry their
specifications require, OOXML by the part only its own kind has, the legacy
formats by their OLE stream name. An OLE file that is none of the three
resolves to a type the upload allow list does not contain, so an Outlook
message is refused rather than stored.

**An attachment's text belongs to its page's search projection.** The
extraction enqueues a re-index of the page it hangs under, and so does a human
correction, because the correction is what a reader searches. The projection
takes the correction over the machine result — the same order every other
reader of this text already uses — and spends one shared budget of 200 000
characters oldest first, rather than a share per attachment: a page carrying
five long PDFs would otherwise build a `tsvector` past PostgreSQL's one
megabyte limit and fail to index at all, and a per-attachment share would cut a
lone long PDF to a quarter for the sake of symmetry.

**The catching up is a sweep that stops.**
`backfill-attachment-search-text` re-indexes the pages whose projection is
older than the attachment text under it. That comparison is what makes it a
no-op once it has run, rather than a periodic reindex of everything, and it is
what carries the PDFs read between 2026-08-06 and 2026-09-20 into the index
they were always said to be in.

## Consequences

Twelve more formats are readable, findable and available to the built-in AI
without a container, a key or a per-document cost. The size limit for them is
its own setting (`ai.officeMaxBytes`, 25 MB) and larger than the PDF one,
because a compressed XML package of a given size is far more text than a PDF of
that size.

PDF extraction is unchanged, which is the point of declining part one.

Semantic search is deliberately not part of this. `document_embedding` is built
from the same `plainText` the projection now carries, so a re-indexed page will
pick up its attachment text on its next embedding pass, but nothing here
chunks or embeds an attachment on its own; whether a 400 000-character PDF
should be a page's passages is a separate question to ADR-034.

The native binding is a new kind of dependency for this repository: a prebuilt
`.node` per platform. It is imported at call time rather than at module load,
so a platform without a binary fails one extraction instead of the worker's
boot, and `packages/ai/src/anydoc.test.ts` converts a real Word document and a
real CSV rather than only a stub, because a mock passes just as happily with a
binding that never loaded.
