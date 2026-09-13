# Rendering pages into files

An existing page published as a PDF, without turning it into a LaTeX document
first. Issue #44, and the reasoning is in
[ADR-026](adr/ADR-026-rendering-is-a-derived-view.md).

```text
Document (Yjs)
  → materialized Markdown
    → Pandoc
      → RenderTemplate (Pandoc template)
        → xelatex, in a container
          → PDF, stored as an ordinary attachment
```

The page is never touched. A PDF is a derived view like Markdown or the search
projection, and may be thrown away and rebuilt at any time.

## What the machine needs

One container image, and nothing else installed on the host:

```bash
docker pull pandoc/extra:latest
```

It carries Pandoc, TeX Live, the fonts and the Eisvogel template. The worker
starts it per build with `--network none`, hands it a tar archive on stdin and
reads the PDF back from stdout.

Four settings, all deployment-wide except the first:

| Setting                   | Scope      | Default               | Why                                                                         |
| ------------------------- | ---------- | --------------------- | --------------------------------------------------------------------------- |
| `render.enabled`          | workspace  | `true`                | A workspace may switch it off for itself, never on against the deployment.  |
| `render.image`            | deployment | `pandoc/extra:latest` | Which images exist is a fact about the machine.                             |
| `render.timeoutSeconds`   | deployment | `180`                 | After that the container is killed and the job fails with the log attached. |
| `render.maxArtifactBytes` | deployment | `50000000`            | Larger output fails the build instead of filling the disk.                  |
| `render.jobRetentionDays` | deployment | `30`                  | How long finished builds and their logs are kept. `0` means for ever.       |

Without the image, a build fails with `renderer_unavailable` and says so in the
dialog. Nothing else breaks.

## Publishing a page

In the browser: the page's ⋯ menu, **Als PDF veröffentlichen**. Pick a template,
fill in what it asks for, press the button; the dialog shows the status, the
finished file and, when it failed, the log.

Through an agent, the same loop:

```text
exo_render_template_list    → which templates exist
exo_render_start            → queue a build
exo_render_status           → PENDING | RUNNING | COMPLETED | FAILED | CANCELLED
exo_render_log              → what Pandoc and LaTeX said
exo_render_artifact         → attachment id and download path
exo_attachment_read_text    → read back what the PDF actually says
```

`exo_render_cancel` stops a build; `exo_render_jobs` lists what a workspace has
built.

**Scope.** `DOCUMENT` is the page alone. `SUBTREE` takes the descendants with
it, each one a heading level deeper than its parent, and adds a table of
contents -- that is how a project with sub-pages becomes one PDF with chapters.

**The cache.** Asking twice for the same page, template and values hands back
the PDF that already exists. A page or template that has changed since makes the
old build _stale_, which the dialog shows and which `stale: true` reports.
`force: true` builds anyway -- use it after changing `render.image`, which the
hash cannot see.

## Writing a template

`/arbeitsbereich/<workspaceId>/vorlagen`, or `exo_render_template_create`.
Writing needs **ADMIN**; starting a build needs **MEMBER**.

A template with no source uses Eisvogel and needs no LaTeX at all. A template
with a source is a **Pandoc template**, not a syntax of ours:

```latex
\documentclass[11pt,a4paper]{scrartcl}
\usepackage{fontspec}
\begin{document}
\title{$title$}
\author{$author$}
\date{$date$}
\maketitle

Kunde: $customer$

$body$
\end{document}
```

`$body$` is the page. `$title$`, `$date$` and `$author$` are always provided.
Everything else comes from the template's declared variables.

### Variables

Each variable has a name (what the template says: `$customer$`), a label (what a
person reads in the form) and an origin, which decides where the value comes
from when nobody types one:

| Origin     | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| `MANUAL`   | Typed before the build. The only one that shows a form field. |
| `TITLE`    | The page title.                                               |
| `PATH`     | The page's path, joined with `/`.                             |
| `AUTHOR`   | Whoever started the build.                                    |
| `TODAY`    | Today, `YYYY-MM-DD`.                                          |
| `PROPERTY` | A database property of the page, named in `property`.         |

A `required` variable that ends up empty refuses the build. That is deliberate:
LaTeX does not fail on an unset `$customer$`, it silently prints nothing, and a
letter addressed to nobody is worse than an error message.

Values are resolved by the API when the request is accepted, so the job records
what it was built from and the input hash covers it.

### What a template can rely on

Whatever is in the image. eXocortex validates nothing about the source: a
missing `\usepackage` is a build failure with a log next to it, and a form that
guessed in advance which packages exist would be wrong the first time
`render.image` changes. Read `exo_render_log` and fix the template.

## Adding a renderer

`Renderer` has one member today. A second (Typst, DOCX, EPUB) is:

1. a value in the `Renderer` enum (`packages/database/prisma/schema.prisma`,
   a migration) and in `rendererSchema` (`packages/contracts/src/render.ts`)
2. a runner beside `apps/worker/src/processors/render/latex-runner.ts` with the
   same shape: input on stdin, artifact on stdout, diagnostics on stderr,
   every failure a returned value rather than a throw
3. a branch in `createRenderProcessor` choosing the runner by
   `job.renderer`

Nothing about the job, the template, the cache, the API or the tools is specific
to LaTeX; that is what ADR-026 buys.

## Where the pieces are

| Path                                     | What                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| `packages/contracts/src/render.ts`       | DTOs, variable resolution, the German failure messages  |
| `packages/database/src/render-source.ts` | What goes into a build, and the input hash              |
| `apps/api/src/render/`                   | Templates, jobs, the cache and the staleness comparison |
| `apps/worker/src/processors/render.ts`   | One build, start to terminal status                     |
| `apps/worker/src/processors/render/`     | The container call, the tar writer, the Markdown fixes  |
| `packages/mcp-tools/src/tools/render.ts` | The eleven tools                                        |
| `apps/web/src/components/render/`        | The page dialog and the template page                   |
