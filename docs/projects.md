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

**The PDF is drawn by pdf.js**, page by page, with zoom and fit-to-width. That
is what makes both directions of SyncTeX possible (issue #53): a click anywhere
in the result opens the source line that produced it, and the caret in the
source marks its place in the PDF and scrolls it into view. A build whose engine
wrote no map, or whose map was too large to keep, still shows its pages; only
the jumping is gone.

**Verlauf** is every build this project has had, newest first: status, root
file, page count, size, the PDF, and the SyncTeX map of whichever one is
selected. Picking a row brings that build back into the panel, which is how a
finished PDF stays reachable after a reload -- before that tab existed the id
lived in React state only, so the file was there and the way to it was not
(ADR-025 counts that as a missing capability). **Löschen** takes a build out
along with its PDF and its map; a running one is cancelled first.

**Datei hochladen** puts an image, a font or a PDF into the project. The bytes
become an ordinary attachment and the tree gets the path.

**ZIP importieren** reads a whole archive in, and **Als ZIP** writes one out.
Both are described under [Archives](#archives) below.

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
exo_project_import              → read an uploaded .zip into the tree
exo_project_export              → pack the project into a .zip attachment

exo_project_build               → queue a build
exo_project_build_status        → PENDING | RUNNING | COMPLETED | FAILED | CANCELLED
exo_project_build_diagnostics   → the errors, with file and line
exo_project_build_log           → everything LaTeX said
exo_project_build_artifacts     → the PDF and the SyncTeX map, as attachments
exo_project_build_source_at     → which source line produced a place on a page
exo_project_build_position_of   → where a source line ended up in the PDF
exo_project_build_cancel        → stop a build
exo_project_builds              → every build of a project, newest first
exo_project_build_delete        → remove a finished build, its PDF and its map
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

## Archives

A project goes in and comes out as a `.zip` (issue #54). Filling one file by
file is fine for a project that starts here; an existing thesis with thirty
files and twenty figures is the reason the import exists, and the export is not
only convenience -- what goes in has to come out again, or the project workspace
is a silo.

```text
exo_attachment_upload  →  exo_project_import   (attachmentId, overwrite?)
exo_project_export     →  an Attachment, downloadable like any other
```

The bytes travel as an attachment in both directions rather than through the
call, for the reason `exo_project_add_asset` does: the upload route owns the
size limit, the magic-byte sniff and the quota, and the browser and an agent
take the same two steps instead of two different ones.

**What an import does with each entry.** A path that `checkProjectPath` refuses
-- absolute, containing `..`, with a control character, shadowing `.git` -- is
skipped, which is what makes zip slip a non-event here rather than a patch
later. An entry whose extension says text becomes a file in the Yjs tree; the
rest become attachments bound to their paths. A single shared top-level folder
is dropped, because nearly every archive of a thesis has one and keeping it
would leave every path one level below where the `\input` lines look.

**What it refuses.** `overwrite` is off by default, so files already in the
project stay as they are. The response names every entry that did not come in,
with the reason, and the dialog offers to repeat the import with `overwrite`
set -- which is the answer to the common first case, a fresh project whose
scaffolded `main.tex` is in the way of the archive's own.

**Limits.** `projects.maxFiles` and `projects.maxFileChars` are checked before
anything is written, never after. The uncompressed total is capped at
`PROJECT_MAX_ARCHIVE_BYTES` (64 MB) and read out of the central directory
before a byte is inflated, with `maxOutputLength` on each inflate as the second
guard for when the central directory is the thing that lied. The archive itself
arrives as an attachment, so `MAX_UPLOAD_BYTES` bounds it too.

**The export** writes every path in the tree, text and attachments alike, and
nothing else: a built PDF is derived and hangs off its build, so an archive
carrying one would be an archive that imports a stale result back in. The
result is an ordinary `Attachment` -- downloadable, deletable, listable -- for
the reason a rendered PDF is one (ADR-026): it is the one answer the browser,
the built-in AI and MCP can all use.

Not implemented, and deliberately: Git. Cloning and pushing means credentials
and network access out of a worker, which is a decision to take on its own
rather than as a side effect of an import (issue #54, AP3).

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

## SyncTeX

The build asks `latexmk` for `-synctex=1` and stores the map uncompressed as
`text/plain`, so it is an ordinary attachment whose _content_
`exo_attachment_read_text` can read rather than a blob (issue #43). Two routes
turn it into answers, and both are `GET` because both are questions:

```text
GET /api/project-builds/:id/source-map/source?page=&x=&y=   → file and line
GET /api/project-builds/:id/source-map/position?file=&line= → pages and rectangles
```

Coordinates are PDF points measured from the top left of the page, which is what
pdf.js hands out and what an agent means by "page 17". The parser is
`apps/api/src/projects/synctex.ts`: our own, because the `synctex` program is
not in the TeX Live image and the JavaScript packages that read the format are
unmaintained or carry a licence this repository cannot take (rule 14).

Two things about the answers are worth knowing before reading them. A reverse
lookup does not stop at the box it landed in: one paragraph is one box carrying
the line it _started_ on, and often holds glyphs from two different files, so
the answer comes from the nearest record inside that box. And a forward lookup
answers with the line it found rather than the line asked for: most lines of a
LaTeX file print nothing, so the search falls forward to the next one that did.

**Git.** A project comes in and goes out as a `.zip`; a remote repository is a
question about credentials and network access from a worker, not a feature that
follows from the import.

## Extending it

A second project type -- Typst, Quarto -- is:

1. a value in `ProjectType` (`packages/contracts/src/projects.ts`, plus the
   Prisma enum and a migration),
2. a runner beside `apps/worker/src/processors/project/latexmk-runner.ts`,
3. a scaffold beside `latexScaffold`,
4. a diagnostics parser beside `parseLatexLog`.

Nothing above the runner knows what a `.tex` file is: the domain, the files, the
assets, the builds, the tools and the UI are already generic.
