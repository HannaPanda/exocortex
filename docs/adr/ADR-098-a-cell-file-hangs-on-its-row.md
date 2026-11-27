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
held may stay, which is what a row made from a template holds. Before this a
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
- A row made from a template names the template row's files. A reader of the
  copy who cannot read the template cannot download them, the same limit the
  copied page text already has.
- Removing a file from a cell does not delete it at once. For a day it can be
  written back by id, then it is gone from storage too.
