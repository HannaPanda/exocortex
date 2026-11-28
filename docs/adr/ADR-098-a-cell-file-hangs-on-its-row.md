# ADR-098: A file in a database cell hangs on its row and is marked as the cell's

- Status: accepted
- Date: 2026-11-27
- Relates to: ADR-011 (a row is a page), ADR-039 (a template copies row
  values), ADR-064 and ADR-095 (a file always has an owner that collects it),
  ADR-010 (a value change carries its outbox row), issue #245

## Context

A FILES column stored a list of attachment ids, and the only editor for it was
a text field that took those ids comma-separated. Nobody could find a way to
put a file into the cell, and the one upload a row page offered, dropping a
file onto the page, put it into the page's text instead. Two targets that look
alike on screen (the row's cell and the row's page) had one way in, and it was
the wrong one for the cell.

Before a file could go into a cell, three things had to be decided: which
record owns it, who removes it when the cell stops naming it, and how the
upload and the value write stay one act.

## Decision

**The file hangs on the row's page and carries the column as a mark.** The
upload is the ordinary one with `documentId` set to the row, so the row's
permissions, the size limit, the magic-byte check and the preview apply
unchanged, and deleting the row for good deletes the file with it, exactly as
for a picture in the row's text. `Attachment.propertyId` says the file was
uploaded for that column and is not part of the page's text. It is a plain
column rather than a foreign key, like `outbox_event.automationRuleId`: the
mark has to outlive the column, because a deleted column is exactly when its
files have to go. A check constraint keeps a chat file out of every cell.

**The upload writes the cell, not the browser.** Every upload path (the
multipart route, the URL upload, the upload ticket) takes an optional
`propertyId`. The server checks that it names a FILES column of the row's
database and that the caller may edit the row, stores the file, and appends its
id to the value under a transaction-scoped advisory lock on the cell, with the
`database.row.updated` outbox row and realtime event any value write carries.
The browser does not write the list afterwards, so two files dropped at once
both arrive, and an agent needs one call, not two.

**A value may only add files of its own row.** Writing the list is how a file
is removed or reordered. An id the cell does not hold yet must be a live,
non-chat attachment hanging on that row (`database_files_foreign`); ids already
held may stay, which is what a row made from a template held before issue #316. Before this a
FILES value took any string; no deployment had a FILES column with values, so
nothing had to be migrated.

**A file no value names is collected after a day.** `collect-orphaned-covers`
deletes a marked file once no FILES value of its column names it and it is
older than a day: removed from the cell, left by a deleted column, or uploaded
by a request whose value write failed. "Any value of the column" rather than
only the row it hangs on, so a template's file survives while a copy still
names it. A file without the mark (one on the page, or one an agent put into
the cell after uploading it onto the row's page) belongs to the page and is
never collected.

## Consequences

- A cell's files are part of the row's page as far as search is concerned:
  their extracted text joins the page's search projection like any
  attachment's (ADR-050), so a PDF in a cell finds its row.
- Every row answer carries `files` (name, type, size) for the ids its FILES
  values name, so a person and a model read names rather than ids. A missing
  entry is a file that is gone, shown as such.
- Until issue #316, a row made from a template named the template row's files.
  Since then it holds copies of its own; see the addendum.
- Removing a file from a cell does not delete it at once. For a day it can be
  written back by id, then it is gone from storage too.

## Addendum (issue #316, 2026-11-28)

A row made from a template (ADR-039) or duplicated (issue #244) gets copies of
the source's cell files, not the source's ids. A shared id broke the rule this
decision rests on: the sweep collects a file once its column stops naming it,
and "its column" was the template's, so taking a file out of the template
emptied every cell made from it as soon as the copies stopped naming it too, and
deleting the template for good took the files along at once.

- **A copy is a file of the new row.** `CellFileCopyService`
  (`apps/api/src/attachments`) creates an `Attachment` per file on the new row
  with the same `propertyId`, and the value names the copies, in the source's
  order. A file that is already gone is left out; nothing is invented back.
- **The storage copies the bytes.** `ObjectStorage.copyObject` is S3
  `CopyObject` inside the bucket, so a 40 MB scan does not pass through the API.
  The preview is copied the same way, best effort like the one an upload makes.
- **What was read from the file comes along.** Extracted text, page starts,
  metadata, the correction and the screening all describe the same bytes, so a
  copied PDF is not read again by the extraction engine. A file still being
  read (`PENDING`) is read again for its copy, because the running job writes
  only the source's row. The new row is re-indexed once its files exist, since
  their text is part of its search projection (ADR-050).
- **The uploader stays the uploader.** `createdById`, `fetchedFromUrl` and who
  corrected the text are the source's. ADR-096 trusts a file for the person
  whose words it is, and copying a row does not make them the copier's: the
  copy is trusted for exactly the reader the original is trusted for. Taking
  the copier as uploader would let anybody turn a colleague's screened file
  into their own by duplicating a row, and screening the copy again would not
  change whose text it is. The one side effect is that the original uploader
  may also delete the copy (`canDeleteAttachment`), which every editor of the
  new row may anyway.
- **Both answers name the copies.** `POST /api/templates/:id/pages` and
  `POST /api/documents/:id/rows/duplicate` carry `copiedFiles` (row, column,
  source id, new id), and `exo_template_use` and `exo_database_rows_duplicate`
  print them.
- The sweep still asks "any value of the column", which keeps a value written
  before this addendum from losing its files.
- Files shown in a copied page's text, and the cover, are still references to
  the source's attachments, as ADR-039 decided for every outward reference.
