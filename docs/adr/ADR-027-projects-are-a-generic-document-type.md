# ADR-027: A project is a generic document type, and its compiler runs on the server

- Status: accepted
- Date: 2026-09-13

## Context

Issue #43 asks for a LaTeX workspace inside eXocortex: a project with several
`.tex` files, a bibliography, images, real-time editing, a PDF and, above all,
an agent that can read the project, change it, build it and repair its own build
errors. The issue names TeXlyre as the preferred integration candidate and
requires a spike (AP0) before anything is modelled, with a licence check that is
explicitly not to be guessed at.

The spike was run against TeXlyre `0.12.1` (commit `421c1fd`, 2026-09-08).

## What the spike found

**There is no package to integrate.** `texlyre` is `private: true`, a Vite
single-page application with `src/main.tsx` and no library entry point, no
`exports` field and no published artifact. `direct package` does not exist as an
option; every form of reuse starts with a fork.

**The licence is AGPL-3.0-or-later, and so are the parts.** Not only the
application: `texlyre-busytex` (the in-browser TeX Live 2026 compiler),
`codemirror-lang-latex` and `wasm-latex-tools` are all AGPL-3.0-or-later on npm.
Only the peripheral packages (`codemirror-lang-bib`, `bib-editor`) are MIT.
eXocortex is a private repository served over the network at `exocortex.app`.
AGPL §13 gives every user who interacts with a combined work over a network the
right to its corresponding source, so bundling any of those packages into
`apps/web` would put that obligation on eXocortex itself. That is a decision
about this deployment, not a technical detail, and it was taken deliberately:
**no AGPL code is linked into eXocortex.** (Noted in passing: `busytex/busytex`
upstream carries no LICENSE file at all, which makes the provenance of the
compiler bundle harder to reason about, not easier.)

**Update 2026-09-16: the reason changed, the decision did not.** eXocortex now
carries a licence of its own, PolyForm Noncommercial 1.0.0, and the argument
above no longer rests on the repository being private. It rests on something
harder: AGPL requires the combined work to be AGPL, and a licence that restricts
commercial use cannot be that. A copyleft dependency in `apps/` or `packages/`
would not merely add an obligation, it would make the project's own licence
unusable. Running such a helper as a separate process in a container, which is
what this ADR already chose, stays the way out.

**The two layers we would have to replace are the two that are wired shut.**
TeXlyre's plugin system has categories for viewers, collaborative viewers,
renderers, loggers, bibliography, LSP, backup and themes. It has none for
storage, for authentication or for the source of a project. `FileStoreService`
opens one IndexedDB per project and keeps file rows and their binary content
there; `ProjectDataService`, `SearchService` and `QuotaService` sit on the same
store; `AuthService` maintains local browser accounts with its own password
hash. Every acceptance criterion in the issue that begins "project access runs
through eXocortex" collides with a layer that has no seam.

**Yjs is the one thing that would have worked.** `CollabService` already chooses
between `y-webrtc` and `y-websocket` at connect time, and Hocuspocus speaks the
`y-websocket` protocol, so the transport is genuinely swappable (room naming and
our ticket authentication would need work). But that moves the collaborative
text only. The file tree, the assets, the project list and the accounts stay in
the browser, which is precisely TeXlyre's design premise: it is a local-first
application, and eXocortex needs a server-owned one.

**A fork is not small.** 107,000 lines of TypeScript across 443 files in `src`
alone, 30 commits in the last 90 days, version 0.12.1, one principal author, and
the layers we would have to replace are among the ones that move.

## Decision

### TeXlyre is not suitable as an embedded engine

The AP0 outcome is `not suitable`, on three independent grounds, any one of
which would be sufficient: there is no library surface to consume, the licence
is incompatible with a private network-served application, and the storage and
identity layers that the requirements replace are not extensible.

This is a judgement about _embedding_, not about the project. Running TeXlyre
beside eXocortex as its own unmodified deployment stays possible at any time and
carries no obligation for us; what it cannot be is the inside of this feature.

### A project is a `Document` with `type: PROJECT`

The issue asks for a generic project domain rather than a LaTeX special case,
and it gets one. It does not get a second tree.

A project is a document row like a database is a document row (ADR-011): it
lives in the workspace tree, it has a title, an icon, a parent, an order key, a
trash state, snapshots, comments and the workspace's permissions, and none of
that had to be built again. `Project` is a sidecar row on that document holding
what a project has and a page does not: its type, its root file, its engine, its
bibliography mode.

`Project.type` is what makes the domain generic. `LATEX` is the first value;
`TYPST`, `QUARTO` and the rest are values, not models. Nothing above the runner
knows what a `.tex` file is.

The files are emphatically _not_ pages. A project is one collaboration and
permission boundary, which is exactly what one document row and one Hocuspocus
room give it -- and a project with forty chapters does not put forty entries in
somebody's sidebar.

### The project's file tree is the project document's Yjs state

The canonical state of a project is the binary Yjs update in
`DocumentContent.yjsState` of its project document -- the same column, the same
persistence, the same snapshots and the same collaboration server as a page
(ADR-004/005). What differs is the shape inside: a page holds a ProseMirror
document, a project holds a `Y.Map` of paths, each entry either a `Y.Text` with
the file's source or a reference to an attachment.

One document, therefore one room, therefore one ticket, one authorization
decision and one snapshot per project. Opening a project connects once; opening
the tenth file in it connects no further times.

Binary files are never in Yjs. An image, a font or a PDF is an ordinary
`Attachment` in MinIO, and the tree entry holds its id and the path it appears
under. The bytes belong to the attachment, the path belongs to the project.

`ProjectFile` rows are derived, in the ADR-007 sense: a projection of the tree
that the materialization job rebuilds, so that reading a project does not mean
loading and decoding a Yjs document, and so that a path can be indexed and
queried. Anything a `ProjectFile` row says can be thrown away and rebuilt. A
write goes to the Yjs state through the collaboration server (ADR-016) and the
row follows; a write to the row would be a lie the next materialization erases.

### There is one compiler, and it is on the server

TeXlyre's browser compiler is what we cannot have -- there is no permissively
licensed in-browser TeX. So a build happens in `apps/worker`, in a container, and
the browser asks for one like everything else does.

The mechanics are ADR-026's, because ADR-026 already built them: a container
started with `--network none`, a tar archive on stdin, artifacts read back from
stdout, a heartbeat, a cancel flag, a capped log, the artifact stored as an
ordinary `Attachment`, and an input hash that is both the build cache and the
staleness comparison. What is new is the script inside the container --
`latexmk` over a multi-file project instead of Pandoc over one Markdown file --
and that the archive coming back holds several files rather than one: the PDF,
the log and the SyncTeX map.

Running unmodified `latexmk`, `pdflatex`, `biber` and TeX Live as processes in a
container is not linking, and it is what ADR-026 already does. The licence
problem disappears entirely by moving the compiler to the place where it was
always going to be reproducible.

This has a price and it is worth naming: no offline build, and no free
keystroke-latency preview. Every build costs the server a second or three, and
the queue's concurrency is 1. In exchange, a build is the _same_ build for the
person and for the agent -- one implementation, one log, one set of diagnostics,
one artifact -- where a WASM compiler in the browser plus a container on the
server would have been two compilers with two failure modes, and the agent's one
would have been the less exercised of the two.

### Diagnostics are structured, and the PDF is inspectable

A build writes `diagnostics`: a list of `{ severity, file, line, message }`
parsed from the TeX log, alongside the raw log. That list is the thing an agent
acts on; the log is the thing it falls back to. The same list drives the error
panel in the browser, so a diagnostic nobody can act on in the UI is a
diagnostic that is missing from the API too.

The PDF is an attachment, which means the text extraction (D6) runs over it and
`exo_attachment_read_text` reads back what the build actually produced. The
SyncTeX map is stored as an attachment beside it, which is what lets a position
in the PDF be resolved back to a file and a line -- for the person clicking in
the viewer and for the agent asking where page 17 comes from, through the same
route. That route is now built (issue #53): the map is parsed in the API and
served by two read endpoints, and the browser calls them like any other client.
The pages themselves are drawn by pdf.js, because the click is what the feature
rests on and the browser's own viewer will not say where it happened.

### Capability parity is the definition of done

Per ADR-025 and the issue's own comment: everything the project UI can do is a
tool. Creating a project, reading and writing and moving and deleting files,
adding and removing assets, changing the build configuration, starting,
cancelling and inspecting a build. The UI holds no business logic of its own; it
calls the same REST endpoints the catalogue calls.

## Consequences

- Nothing under `apps/` or `packages/` may depend on an AGPL package. If a
  future LaTeX helper is AGPL, it runs in the build container as a process or it
  does not run here.
- The materialization job has to branch on `Document.type`: a `PROJECT`
  document's Yjs state is not a ProseMirror document and reading it as one would
  fail. The branch is in the processor, and the project half writes
  `ProjectFile` rows instead of Markdown.
- A project document is excluded from the page search index and from embeddings
  for now. Indexing LaTeX source as prose would fill semantic search with
  `\begin{itemize}`; the title still matches.
- The interactive loop is as fast as the queue. If that turns out to be too slow
  in daily writing, the answer is a warm container or a build cache on the
  intermediate files, not a second compiler in the browser.
- A second project type is a `ProjectType` value, a runner and a set of defaults.
  The domain, the files, the assets, the builds, the tools and the UI do not
  know about LaTeX.
