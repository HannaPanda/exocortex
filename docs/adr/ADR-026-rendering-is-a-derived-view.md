# ADR-026: A rendered file is a derived view, built in a container

- Status: accepted
- Date: 2026-09-13

## Context

eXocortex can already hand a page out as Markdown. What it could not do is hand
it out as something a person prints, signs or sends: an offer, a report, a
protocol, a piece of technical documentation with a title page and a table of
contents. The pages exist and are well structured; what is missing is the last
step, and outside the system that step is somebody copying Markdown into a
LaTeX project by hand.

Issue #44 asks for that step and is explicit about two things it must not
become: a second canonical state, and a Markdown-to-LaTeX translator of our own.

## Decision

### A PDF is derived, exactly like Markdown and the search projection

The canonical state of a document is the binary Yjs update (ADR-004/005).
Markdown is derived from it by materialization (ADR-007), and a rendered file is
derived from that Markdown, a template and a set of resolved variables. It can
be thrown away and rebuilt at any time, and nothing reads it back into a page.

`RenderTemplate` and `RenderJob` are therefore ordinary rows beside the
document, never inside it. The page keeps no pointer to "its PDF": the newest
build of a page is a query, and a column would be one more thing to invalidate
when somebody deletes the file.

### Pandoc translates, we do not

The pipeline is `materialized Markdown → Pandoc → LaTeX template → xelatex →
PDF`. Headings, lists, tables, code, quotes, footnotes and images are Pandoc's
job, and it is better at them than a renderer we would maintain. Three small
transformations happen on our side because leaving them alone produces a
visibly wrong PDF rather than an error:

- an attachment image points at `/api/attachments/:id/download`, which means
  nothing inside a container with no network, so the bytes travel in the archive
  and the link is rewritten
- `[[Andere Seite]]` is our wiki link and Pandoc prints it verbatim, brackets
  and all, so it is flattened to its label; a PDF cannot follow a link into this
  deployment anyway
- a subtree render shifts each descendant's headings one level per step down the
  tree, because otherwise a project with sub-pages becomes a PDF with a dozen
  competing top-level headings

The template language is Pandoc's own (`$title$`, `$body$`, `$for(...)$`). We
own no template syntax, so a template written here can be pasted into a Pandoc
invocation anywhere else and still work. A template with no source at all uses
Eisvogel, which ships in the image: the first PDF of a deployment needs nobody
to write LaTeX first.

### The build runs in a container, fed through a pipe

`apps/worker` shells out to `docker run --rm -i --network none`. The input is a
tar archive on stdin, the output is the PDF on stdout and everything else is
stderr. There are no bind mounts and no temporary directories.

That shape is a decision, not a convenience. A mounted directory would have to
exist at the same path for the worker and for the Docker daemon, and under the
unit's `PrivateTmp` it does not -- the failure would be an empty directory
rather than an error. The pipe has no such ambiguity, nothing to clean up, and
no path to get wrong.

`--network none` matters for a second reason: a LaTeX document is a program, and
this one runs a template somebody in the workspace wrote. It reads what it was
handed and cannot reach anything else on this host.

The image is `render.image`, deployment-wide (ADR-023): which images exist is a
fact about the machine, the same reason `ai.pdfExtractor` sits there.

### The artifact is an ordinary attachment

A finished PDF is uploaded through `POST /api/workspaces/:id/attachments` with a
service token for whoever asked for it (ADR-014). It is downloadable, deletable
and quota-counted exactly like a file somebody dragged in -- and the PDF text
extraction (D6) runs over it.

That last part is the answer to the hardest requirement in ADR-025: a feature
whose result is visual has to be inspectable by a machine. It is, without a
single line written for it: `exo_render_artifact` names the attachment and
`exo_attachment_read_text` reads back what the build actually produced. A
parallel artifact store would have had to grow downloads, deletion, quota and
extraction again, and would have been the one place where the extraction does
not run.

`onDelete: SetNull` on the artifact, not cascade: deleting the file leaves a job
that says it succeeded and has nothing to show, which is the truth. Deleting the
job instead would take the build log with it.

### The input hash is the cache and the staleness flag

Every build records a SHA-256 over the source text, the template, the renderer
and the resolved variables. Two consequences, both of which would otherwise need
machinery of their own:

- asking for the same page, template and values again hands back the PDF that
  already exists instead of building it twice
- a finished build is "out of date" when the same inputs hash differently now,
  which is a comparison rather than a flag somebody has to remember to clear
  when a page, a template or a variable changes

Variables are resolved by the API when the request is accepted, not by the
worker, so the values a build used are written on the job and can be read
afterwards. A value resolved in the worker would be one nobody can see and
nobody can reproduce.

The container image is deliberately **not** in the hash: it is not read at
request time, and a hash that changed under every deployment would make the
cache useless. Changing the image is what `force` on a render request is for.

### The whole loop reaches all three clients

Per ADR-025 the browser, the built-in AI and MCP get the same capability, and
for an asynchronous feature that means the whole loop: create and read a
template, start a build, read its status, read the diagnostics, fetch the
artifact, cancel. `exo_render_log` exists as its own tool and its own route
because a LaTeX log is tens of kilobytes and is the only place a broken template
explains itself -- an agent that could start a render but not read why it failed
could begin something it can never finish.

### What is deliberately left out

- **A database query as a source.** The `source` column carries an enum so
  adding it later is a value rather than a model, but a value every caller has to
  be told not to use is worse than one that is not there yet.
- **A `RenderArtifact` table.** See above: the artifact is an attachment.
- **A separate template editor.** A template is a text field; when `Project`
  exists (#43) a complex template becomes a project and is edited with the
  generic project tools, which is why `RenderTemplate.source` is nullable and
  small rather than a structure.
- **Retrying a failed build automatically.** The queue gets `attempts: 1`: a
  template that does not compile does not compile the second time either, and
  the processor writes a terminal status with the log itself.

## Consequences

- A deployment without the image renders nothing, and says so: the job fails
  with `renderer_unavailable` and an admin reads it in the dialog.
- The build is CPU-bound and the queue's concurrency is 1. Two builds at once
  would not finish a single PDF any sooner on this host.
- A build can outlive its worker. `render_job.heartbeatAt` plus
  `reap-render-jobs` (every two minutes) is what closes such a row instead of
  leaving a dialog spinning for ever.
- The second renderer -- Typst, DOCX, EPUB -- is a `Renderer` value and a second
  runner behind the same job, template and artifact shape. Nothing above is
  specific to LaTeX except the runner itself.
