# Project workspaces

A LaTeX project inside eXocortex: several source files, a bibliography, images,
real-time editing, a PDF, and an agent that can read the project, change it,
build it and repair its own build errors. Issue #43; the reasoning, including
why TeXlyre is not embedded, is in
[ADR-027](adr/ADR-027-projects-are-a-generic-document-type.md).

```text
Document (type: PROJECT)
  └── Yjs state: a map of paths
        ├── main.tex              -> Y.Text, collaboratively editable
        ├── chapters/intro.tex    -> Y.Text
        ├── bibliography.bib      -> Y.Text
        └── images/plot.png       -> a reference to an Attachment
              ↓ materialization
        ProjectFile rows (derived)
              ↓ a build
        latexmk in a container -> PDF + SyncTeX map, as Attachments
```

A project is a document, so its place in the tree, its title, its permissions,
its trash and its snapshots are a page's. Its files are not pages.

## What the machine needs

One container image, and nothing else installed on the host:

```bash
docker pull pandoc/extra:latest
```

The same image the page renderer uses (ADR-026): it carries a full TeX Live with
`latexmk`, `pdflatex`, `xelatex`, `lualatex` and `biber`, so a deployment that
can already publish a page as a PDF needs nothing further. `texlive/texlive` is
a fine value for `projects.image` too, for somebody who wants the distribution
without Pandoc.

The worker starts the container per build with `--network none`, hands it a tar
archive on stdin and reads an archive with the PDF, the log and the SyncTeX map
back from stdout.

Seven settings, all deployment-wide except the first:

| Setting                       | Scope      | Default               | Why                                                             |
| ----------------------------- | ---------- | --------------------- | --------------------------------------------------------------- |
| `projects.enabled`            | workspace  | `true`                | A workspace may switch building off; editing keeps working.     |
| `projects.image`              | deployment | `pandoc/extra:latest` | Which images exist is a fact about the machine.                 |
| `projects.timeoutSeconds`     | deployment | `300`                 | After that the container is killed and the build fails.         |
| `projects.maxArtifactBytes`   | deployment | `100000000`           | A larger PDF fails the build instead of filling the disk.       |
| `projects.maxFileChars`       | deployment | `2000000`             | Per text file, not per project.                                 |
| `projects.maxFiles`           | deployment | `500`                 | Paths per project, attachments included.                        |
| `projects.buildRetentionDays` | deployment | `30`                  | How long finished builds and their logs are kept. `0` for ever. |

Without the image, a build fails with `builder_unavailable` and says so.
Nothing else breaks: editing a project needs no container at all.

## Using one

In the browser: the sidebar's ⋯ menu or the workspace's **+**, then **LaTeX-Projekt
anlegen**. The project opens with a compilable `main.tex`, so the first build
succeeds before anybody writes a line of LaTeX.

The screen is three columns: the file tree, the source, the result. There is no
save button, because there is nothing to save -- the editor writes into the
project's Yjs document over the same socket a page uses, so two people typing in
`chapters/intro.tex` see each other's cursors.

**Bauen** starts a build. When it fails, the **Fehler** tab lists what LaTeX
objected to with the file and line; clicking one opens that file at that line.

**Datei hochladen** puts an image, a font or a PDF into the project. The bytes
become an ordinary attachment and the tree gets the path.

## Through an agent

The same loop, whole:

```text
exo_project_create              → a project with a compilable main.tex
exo_project_list_files          → what is in it
exo_project_read_file           → one file's source
exo_project_write_file          → replace a file
exo_project_patch_file          → change one anchored piece of it
exo_project_move_file           → rename, or move a whole folder
exo_project_delete_file         → remove a path
exo_project_add_asset           → bind an uploaded attachment to a path

exo_project_build               → queue a build
exo_project_build_status        → PENDING | RUNNING | COMPLETED | FAILED | CANCELLED
exo_project_build_diagnostics   → the errors, with file and line
exo_project_build_log           → everything LaTeX said
exo_project_build_artifacts     → the PDF and the SyncTeX map, as attachments
exo_project_build_cancel        → stop a build
exo_attachment_read_text        → read back what the PDF actually printed
```

Two things are deliberately not tools of their own. **Deleting a project** is
deleting its document: `exo_page_trash` and `exo_page_delete` already do that.
**Uploading bytes** is `exo_attachment_upload`, which owns the magic-byte sniff
and the quota; `exo_project_add_asset` then binds the id to a path.

`exo_project_patch_file` refuses an anchor that occurs more than once, and that
refusal is the point: patching the wrong one of three identical lines produces a
build that succeeds and a document that is wrong.

## Paths

Relative, `/`-separated, no leading slash and no `..`. Directories are not
entries: a directory is the prefix of the paths under it, which is why an empty
directory cannot exist and why renaming `chapters` to `teile` is one move.

`.git` and `.exocortex` are reserved -- the build directory owns the second one.

A file is **text** when its extension says so (`PROJECT_TEXT_EXTENSIONS` in
`@exocortex/contracts`, plus `latexmkrc`). A text file lives in the Yjs state and
is collaboratively editable; anything else is an attachment and only its path is
in the tree.

## The build

`latexmk` decides how many passes are needed, so a table of contents and a
bibliography resolve without anybody counting runs. The working directory is the
project root, not the root file's folder, so `\input{chapters/intro}` resolves the
way the file tree reads.

| Engine     | latexmk flag |
| ---------- | ------------ |
| `PDFLATEX` | `-pdf`       |
| `XELATEX`  | `-pdfxe`     |
| `LUALATEX` | `-pdflua`    |

`bibliography: AUTO` lets latexmk decide from what the document loads, which is
right nearly always; `BIBTEX` and `BIBER` force a run, which is what a first
build with no `.aux` yet needs; `NONE` switches it off.

`-shell-escape` is never passed, and the container has no network. A LaTeX
document is a program, and this one is somebody's whole project.

**The cache.** Every build records a SHA-256 over each path with its content or
its attachment's checksum, plus the root file, the engine and the bibliography
mode. Asking again for an unchanged project hands back the PDF that already
exists; a finished build is _stale_ when the same inputs hash differently now.
The container image is not in the hash, which is what `force: true` is for.

## What is not there yet

**SyncTeX in the viewer.** The build produces the SyncTeX map and hands it out
through `exo_project_build_artifacts` -- stored uncompressed as `text/plain`, so
`exo_attachment_read_text` reads the mapping itself rather than a blob. What is
missing is the other half: the PDF is shown in the browser's own viewer, which
cannot be asked where a click landed, so clicking a place in the PDF to jump to
its source line needs pdf.js rendering the pages. Until then the error list is
what navigates from the result back to the source.

**Git and ZIP import/export.** A project can be filled through the tools, one
file at a time. A `.zip` of an existing thesis has to be unpacked by hand.

## Extending it

A second project type -- Typst, Quarto -- is:

1. a value in `ProjectType` (`packages/contracts/src/projects.ts`, plus the
   Prisma enum and a migration),
2. a runner beside `apps/worker/src/processors/project/latexmk-runner.ts`,
3. a scaffold beside `latexScaffold`,
4. a diagnostics parser beside `parseLatexLog`.

Nothing above the runner knows what a `.tex` file is: the domain, the files, the
assets, the builds, the tools and the UI are already generic.
