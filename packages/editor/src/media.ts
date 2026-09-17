import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry, type BlockIconName } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

/**
 * File, video, audio and PDF blocks.
 *
 * All four are the same shape — a URL, a display name and a caption — so they are
 * generated from one description instead of four near-identical node modules. What
 * differs is the tag they render and how a reader is meant to consume them, which
 * is exactly what a block type is for.
 *
 * The URL always points at the attachment download endpoint of the API; the
 * editor never talks to object storage (see scripts/dependency-graph.mjs).
 */
interface MediaKind {
  /** ProseMirror node name. */
  name: 'fileAttachment' | 'video' | 'audio' | 'pdf';
  /** Container name in the Markdown syntax (`:::video …`). */
  container: string;
  label: string;
  description: string;
  keywords: readonly string[];
  icon: BlockIconName;
}

const MEDIA_KINDS: readonly MediaKind[] = [
  {
    name: 'fileAttachment',
    container: 'file',
    label: 'Datei',
    description: 'Datei zum Herunterladen',
    keywords: ['datei', 'file', 'anhang', 'attachment', 'download'],
    icon: 'Paperclip',
  },
  {
    name: 'video',
    container: 'video',
    label: 'Video',
    description: 'Video im Player abspielen',
    keywords: ['video', 'film', 'mp4', 'webm', 'abspielen'],
    icon: 'Video',
  },
  {
    name: 'audio',
    container: 'audio',
    label: 'Audio',
    description: 'Audiodatei abspielen',
    keywords: ['audio', 'ton', 'musik', 'mp3', 'sprachnotiz'],
    icon: 'AudioLines',
  },
  {
    name: 'pdf',
    container: 'pdf',
    label: 'PDF',
    description: 'PDF eingebettet anzeigen',
    keywords: ['pdf', 'dokument', 'vorschau'],
    icon: 'FileText',
  },
];

/**
 * What an extraction knows about a document, as the block needs it.
 *
 * Structurally identical to the relevant part of `PdfMetadata` in
 * `@exocortex/contracts`, but declared here rather than imported: this package
 * is a leaf and depends on no other Exocortex package (see
 * `scripts/dependency-graph.mjs`). The host passes its contract object straight
 * in; TypeScript accepts it because the shapes line up.
 */
export interface MediaDocumentMetadata {
  title: string | null;
  author: string | null;
  creator: string | null;
  createdAt: string | null;
  pageCount: number | null;
  tableCount: number | null;
  pictureCount: number | null;
  ocrUsed: boolean | null;
}

/**
 * Records that a person edited the extracted text by hand (issue #2).
 *
 * Metadata only, no text: this rides along on every `read()`, so the meta bar
 * can show "von Hand korrigiert" without pulling the correction itself.
 */
export interface MediaDocumentCorrection {
  editedAt: string;
  editedById: string;
}

export interface MediaDocumentInfo {
  status: 'not_applicable' | 'pending' | 'ready' | 'failed';
  metadata: MediaDocumentMetadata | null;
  error: string | null;
  /**
   * The stored file name, used when the block has none of its own.
   *
   * The slash menu inserts a media block with only a `src` (see `mediaBlocks`
   * in this file: the file prompt resolves to a URL and nothing else), so those
   * blocks would otherwise show the download URL where the file name belongs.
   * Documents written that way are already out there, so the label is repaired
   * from the resolved answer rather than only at insertion time.
   */
  filename: string | null;
  /**
   * Whether this file has a text layer worth chasing at all.
   *
   * `not_applicable` means two different things depending on it. For an image
   * or a zip it is the final answer and the block stays silent. For a PDF it
   * means nobody ever asked -- true of every PDF uploaded before extraction
   * existed -- and staying silent there would leave the reader with a block
   * that shows nothing and offers nothing.
   */
  extractable: boolean;
  /** Present once a person has corrected the extracted text; absent otherwise. */
  correction: MediaDocumentCorrection | null;
  /** True when the extracted text was cut off at the server's character cap. */
  truncated: boolean;
}

/**
 * `MediaDocumentInfo` plus the two fields that can be 400,000 characters long
 * (issue #2). Loaded only when a reader actually asks to see the text, through
 * `MediaInfoResolver.readText`, never as part of the render-time `read`.
 */
export interface MediaDocumentDetail extends MediaDocumentInfo {
  /** The version to show and to edit: the correction if there is one. */
  text: string | null;
  /** The raw machine result, regardless of whether a correction exists. */
  machineText: string | null;
}

/**
 * How a block learns what a file contains.
 *
 * The editor never talks to the API itself -- it does not know the route shape
 * and must not -- so the host injects this through
 * `buildEditorExtensions({ mediaInfo })`. Without it the blocks render exactly
 * as before, which is what keeps server-side rendering and the tests unchanged.
 */
export interface MediaInfoResolver {
  /**
   * Reads the current state for a media `src`. Must be free of side effects: it
   * runs on every render, so it may not start an extraction.
   *
   * Null when `src` is nothing the host can describe.
   */
  read(src: string): Promise<MediaDocumentInfo | null>;
  /** Asks for an extraction to (re-)run. Absent when the reader may not. */
  request?(src: string): Promise<MediaDocumentInfo | null>;
  /**
   * Loads the full text for the "Ansehen" dialog (issue #2). Absent when the
   * reader may not view it -- which never happens today, but keeps the same
   * "absent means not offered" shape as `request`.
   */
  readText?(src: string): Promise<MediaDocumentDetail | null>;
  /**
   * Forces a fresh extraction even though the current one is already `ready`
   * (issue #2). Distinct from `request`, which never re-runs a `ready` one.
   * Absent when the reader may not.
   */
  forceReextract?(src: string): Promise<MediaDocumentInfo | null>;
  /**
   * Writes a human correction of the extracted text, or with `text: null`
   * clears one (issue #2). Absent when the reader may not edit.
   */
  correctText?(src: string, text: string | null): Promise<MediaDocumentDetail | null>;
  /**
   * Draws the PDF itself into `container`, and returns how to take it down
   * again (issue #70).
   *
   * Injected rather than done here, and that is the whole point of it being on
   * this interface. Showing a PDF means pdf.js, and this package is also read
   * by the server -- materialization, Markdown, HTML export -- so a browser
   * renderer inside it would travel into bundles that never draw anything. The
   * host has one already; this is how it reaches the block.
   *
   * Absent on the server and in the tests, and then the block renders exactly
   * as it did before: the file's name, the two actions, and no preview.
   */
  renderPdf?(container: HTMLElement, src: string): () => void;
}

export interface MediaNodeOptions {
  mediaInfo: MediaInfoResolver | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    exocortexMedia: {
      /** Inserts a media block of `type` pointing at `src`. */
      insertMedia: (
        type: 'fileAttachment' | 'video' | 'audio' | 'pdf',
        attributes: { src: string; name?: string },
      ) => ReturnType;
    };
  }
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Builds one media node. */
function createMediaNode(kind: MediaKind) {
  return Node.create<MediaNodeOptions>({
    name: kind.name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addOptions() {
      return { mediaInfo: null };
    },

    addAttributes() {
      return {
        src: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-src') ?? '',
          renderHTML: (attributes) => ({ 'data-src': stringAttribute(attributes.src) }),
        },
        name: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-name') ?? '',
          renderHTML: (attributes) => ({ 'data-name': stringAttribute(attributes.name) }),
        },
      };
    },

    parseHTML() {
      return [{ tag: `figure[data-media='${kind.name}']` }];
    },

    renderHTML({ HTMLAttributes, node }) {
      const src = stringAttribute(node.attrs.src);
      const name = stringAttribute(node.attrs.name);
      return [
        'figure',
        mergeAttributes(HTMLAttributes, {
          'data-media': kind.name,
          class: `exocortex-media exocortex-media-${kind.name}`,
        }),
        ...renderMediaBody(kind, src, name),
      ];
    },

    addNodeView() {
      const resolver: MediaInfoResolver | null = this.options.mediaInfo;

      return ({ node }) => {
        const dom = window.document.createElement('figure');
        dom.className = `exocortex-media exocortex-media-${kind.name}`;
        dom.dataset.media = kind.name;
        // The player and the download link are controls, not editable text.
        dom.contentEditable = 'false';

        const src = stringAttribute(node.attrs.src);
        const name = stringAttribute(node.attrs.name);
        const element = buildMediaElement(kind, src, name);
        dom.append(element);

        // A video does not have a text layer, and nothing is resolved without a
        // host resolver, so both cases skip straight past this.
        if (kind.name !== 'pdf' && kind.name !== 'fileAttachment') {
          return { dom, ignoreMutation: () => true };
        }

        // The pages themselves, from the host (issue #70). Mounted here rather
        // than in `buildMediaElement`, which knows nothing about the resolver
        // and is also what renders a block with no host at all.
        let unmountPdf: (() => void) | null = null;
        if (kind.name === 'pdf' && resolver?.renderPdf !== undefined && src.length > 0) {
          const viewport = buildPdfViewport();
          element.append(viewport);
          unmountPdf = resolver.renderPdf(viewport, src);
        }

        const details = attachDocumentDetails(kind, element, src, name, resolver);

        return {
          dom,
          ignoreMutation: () => true,
          // A node view is rebuilt whenever its attributes change, so a
          // response still in flight belongs to a block that no longer exists.
          destroy: () => {
            details?.cancel();
            unmountPdf?.();
          },
        };
      };
    },
  });
}

/** Static markup for server-side rendering and HTML export. */
function renderMediaBody(
  kind: MediaKind,
  src: string,
  name: string,
): [string, Record<string, string>, ...string[]][] {
  const label = name.length > 0 ? name : src;
  switch (kind.name) {
    case 'video':
      return [['video', { src, controls: 'true', preload: 'metadata' }]];
    case 'audio':
      return [['audio', { src, controls: 'true', preload: 'metadata' }]];
    case 'pdf':
      return [['a', { href: src, rel: 'noopener noreferrer' }, label]];
    case 'fileAttachment':
      return [['a', { href: src, rel: 'noopener noreferrer', download: '' }, label]];
  }
}

/** Header link, used for both PDF actions. */
function buildPdfAction(src: string, text: string, download: boolean): HTMLAnchorElement {
  const anchor = window.document.createElement('a');
  anchor.href = src;
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = text;
  if (download) anchor.download = '';
  else anchor.target = '_blank';
  return anchor;
}

/**
 * Preview of a PDF plus the actions a reader actually has.
 *
 * The preview is an empty box the host fills through
 * `MediaInfoResolver.renderPdf` (issue #70). It used to be an `<object>`, and
 * that never once worked: the application's own Content-Security-Policy sets
 * `object-src 'none'`, so every browser refused it silently and fell back to
 * the download link inside it. The block looked like a deliberately plain link
 * for as long as the feature existed. `<iframe>` is refused by the same policy
 * under `frame-src`, which leaves drawing the pages -- and the host is the only
 * side of this seam that may load a renderer.
 *
 * With no host renderer the box is left out entirely rather than left empty: an
 * exported document and a server-rendered page still say what the file is and
 * link to it.
 */
function buildPdfElement(src: string, label: string): HTMLElement {
  const container = window.document.createElement('div');
  container.className = 'exocortex-pdf';

  const header = window.document.createElement('div');
  header.className = 'exocortex-pdf-header';
  const title = window.document.createElement('span');
  title.className = 'exocortex-pdf-name';
  title.textContent = label;
  header.append(
    title,
    buildPdfAction(src, 'Öffnen', false),
    buildPdfAction(src, 'Herunterladen', true),
  );

  container.append(header);
  return container;
}

/** Where the host's renderer draws, once there is one. */
function buildPdfViewport(): HTMLElement {
  const viewport = window.document.createElement('div');
  viewport.className = 'exocortex-pdf-viewport';
  return viewport;
}

/** `2026-04-26T11:56:10.000Z` as `26.04.2026`, without depending on a locale. */
function formatDay(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${parsed.getUTCFullYear()}`;
}

/**
 * The document's facts as short German labels.
 *
 * Only what is actually known is listed. A null means no source could tell, not
 * zero, so "0 Tabellen" would be a claim nobody made -- and a row of "unbekannt"
 * would be noise in a header that has to stay one line.
 */
function describeDocument(metadata: MediaDocumentMetadata | null): string[] {
  if (metadata === null) return [];

  const chips: string[] = [];
  if (metadata.title !== null) chips.push(metadata.title);
  if (metadata.author !== null) chips.push(metadata.author);
  // A scan usually carries neither a title nor an author, and then the software
  // that produced it ("PFU ScanSnap Home 3.6.1") is the only thing identifying
  // where the document came from. Next to a real title it would just be noise,
  // so it fills in rather than adding on.
  if (metadata.title === null && metadata.author === null && metadata.creator !== null) {
    chips.push(metadata.creator);
  }
  if (metadata.pageCount !== null) {
    chips.push(metadata.pageCount === 1 ? '1 Seite' : `${metadata.pageCount} Seiten`);
  }
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    chips.push(metadata.tableCount === 1 ? '1 Tabelle' : `${metadata.tableCount} Tabellen`);
  }
  if (metadata.pictureCount !== null && metadata.pictureCount > 0) {
    chips.push(metadata.pictureCount === 1 ? '1 Bild' : `${metadata.pictureCount} Bilder`);
  }
  if (metadata.createdAt !== null) {
    const day = formatDay(metadata.createdAt);
    if (day !== null) chips.push(day);
  }
  if (metadata.ocrUsed === true) chips.push('per Texterkennung gelesen');
  return chips;
}

/**
 * `not_applicable` only ever reaches this point for a file that *could* be
 * read, because the silent case returns earlier: it means nobody has asked yet.
 *
 * `ready` used to be `null`, i.e. silent: a successfully read PDF said nothing
 * at all, which left no visible way to get to the text (issue #2). Saying so
 * is also what gives the "Ansehen" action somewhere to sit.
 */
const STATUS_NOTES: Record<MediaDocumentInfo['status'], string | null> = {
  not_applicable: 'Noch nicht ausgelesen',
  pending: 'Text wird ausgelesen …',
  ready: 'Text gelesen',
  failed: 'Kein Text lesbar',
};

/**
 * Independent of `status`: a correction can exist on a `failed` or even a
 * `not_applicable` attachment (a person can describe a scan by hand when
 * automatic extraction is switched off), and a truncation is a fact about the
 * last successful read, not about the current one.
 */
function describeCorrectionAndTruncation(info: MediaDocumentInfo): string[] {
  const chips: string[] = [];
  if (info.correction !== null) chips.push('Von Hand korrigiert');
  if (info.truncated) chips.push('Gekürzt');
  return chips;
}

/**
 * How long to wait before asking again while an extraction runs.
 *
 * Extraction is a background job of very uneven length: a text-layer PDF is
 * done in seconds, a scanned one takes about one and a half seconds per page.
 * The delays grow so that the common case updates quickly without the slow case
 * turning into a stream of requests, and the list ends, so a job that never
 * finishes cannot leave a tab polling forever.
 */
const POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000, 15_000, 15_000, 15_000, 15_000];

function buildChip(label: string): HTMLElement {
  const chip = window.document.createElement('span');
  chip.className = 'exocortex-media-chip';
  chip.textContent = label;
  return chip;
}

/**
 * The line under a media block describing what was read out of the file.
 *
 * Returns null when there is nothing to resolve, so the caller has nothing to
 * clean up either.
 */
/** Replaces a placeholder label once the real file name is known. */
function applyLabel(kind: MediaKind, element: HTMLElement, label: string): void {
  if (kind.name !== 'pdf') {
    element.textContent = label;
    return;
  }
  const title = element.querySelector('.exocortex-pdf-name');
  if (title !== null) title.textContent = label;
  // The `<object>` fallback link carries the same label.
  const fallback = element.querySelector('object > a');
  if (fallback !== null) fallback.textContent = label;
}

function attachDocumentDetails(
  kind: MediaKind,
  element: HTMLElement,
  src: string,
  name: string,
  resolver: MediaInfoResolver | null,
): { cancel: () => void } | null {
  if (resolver === null || src.length === 0) return null;

  const bar = window.document.createElement('div');
  bar.className = 'exocortex-media-meta';
  bar.hidden = true;
  // Inside the PDF frame it belongs under the header; a file block is a single
  // link, so the line goes after it rather than into it.
  if (kind.name === 'pdf') element.querySelector('.exocortex-pdf-header')?.after(bar);
  else element.after(bar);

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;
  let dialog: TextDialogController | null = null;

  const render = (info: MediaDocumentInfo | null): void => {
    if (cancelled) return;
    bar.replaceChildren();
    if (info === null) {
      bar.hidden = true;
      return;
    }

    // A block inserted through the slash menu has no name of its own, so it is
    // showing its download URL until this arrives.
    if (name.length === 0 && info.filename !== null) applyLabel(kind, element, info.filename);

    // For an image or a zip this is the final answer, so the line stays away
    // rather than announcing that a picture has no text.
    if (info.status === 'not_applicable' && !info.extractable) {
      bar.hidden = true;
      return;
    }

    for (const chip of describeDocument(info.metadata)) bar.append(buildChip(chip));

    const note = STATUS_NOTES[info.status];
    if (note !== null) {
      const noteChip = buildChip(note);
      noteChip.classList.add(`exocortex-media-chip-${info.status}`);
      // The reason a document could not be read is worth having, but not worth
      // a second line in a header.
      if (info.error !== null) noteChip.title = info.error;
      bar.append(noteChip);
    }

    for (const chip of describeCorrectionAndTruncation(info)) bar.append(buildChip(chip));

    // Both offer the same action, but they are not the same situation: one
    // failed, the other was never asked.
    const retryAction =
      info.status === 'failed'
        ? buildActionButton('Erneut versuchen', 'exocortex-media-retry', resolver.request)
        : info.status === 'not_applicable'
          ? buildActionButton('Text auslesen', 'exocortex-media-retry', resolver.request)
          : null;
    if (retryAction !== null) bar.append(retryAction);

    // Separate from the retry above: `request` never re-runs a `ready`
    // attachment, so a successful-but-wrong extraction needed its own explicit
    // "no, really, again" (issue #2).
    const forceAction =
      info.status === 'ready'
        ? buildActionButton('Erneut auslesen', 'exocortex-media-force', resolver.forceReextract)
        : null;
    if (forceAction !== null) bar.append(forceAction);

    // Offered whenever there is something to show: a completed or failed
    // extraction, or a correction written by hand while automatic extraction
    // stayed `not_applicable` (issue #2).
    const canView = info.status !== 'not_applicable' || info.correction !== null;
    if (canView && resolver.readText !== undefined) bar.append(buildViewButton());

    bar.hidden = bar.childElementCount === 0;

    // Keep watching only while something is actually running.
    if (info.status === 'pending') schedulePoll();
  };

  // Arrow function expressions, not declarations: they are defined textually
  // after the early `resolver === null` return above, which is what lets
  // TypeScript's control-flow analysis carry the "resolver is not null"
  // narrowing into them. A hoisted `function` declaration here would not get it.
  /** Null when the reader may not perform `run` at all. */
  const buildActionButton = (
    label: string,
    className: string,
    run: ((src: string) => Promise<MediaDocumentInfo | null>) | undefined,
  ): HTMLElement | null => {
    if (run === undefined) return null;
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => {
      polls = 0;
      button.disabled = true;
      void run(src).then(render, () => render(null));
    });
    return button;
  };

  const buildViewButton = (): HTMLElement => {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = 'exocortex-media-view';
    button.textContent = 'Ansehen';
    button.addEventListener('click', () => {
      if (resolver.readText === undefined) return;
      button.disabled = true;
      void resolver.readText(src).then(
        (detail) => {
          button.disabled = false;
          if (detail === null) return;
          dialog ??= createTextDialog(resolver, src, name.length > 0 ? name : src, render);
          dialog.open(detail);
        },
        () => {
          button.disabled = false;
        },
      );
    });
    return button;
  };

  const schedulePoll = (): void => {
    const delay = POLL_DELAYS_MS[polls];
    if (delay === undefined) return;
    polls += 1;
    timer = setTimeout(() => {
      void resolver.read(src).then(render, () => render(null));
    }, delay);
  };

  void resolver.read(src).then(render, () => render(null));

  return {
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      dialog?.dispose();
    },
  };
}

interface TextDialogController {
  open: (detail: MediaDocumentDetail) => void;
  dispose: () => void;
}

/**
 * The "Ansehen" dialog: shows the extracted text and, when the resolver
 * allows it, lets a person correct it or discard an existing correction
 * (issue #2).
 *
 * Built lazily, once per block, the first time "Ansehen" is clicked, and
 * removed from `document.body` again when the node view is destroyed. A
 * native `<dialog>` rather than a hand-rolled overlay: `showModal()` gives it
 * a11y-correct focus trapping and Escape-to-close for free, which this
 * package -- a Tiptap leaf with no UI framework of its own -- would otherwise
 * have to rebuild from scratch.
 */
function createTextDialog(
  resolver: MediaInfoResolver,
  src: string,
  fallbackTitle: string,
  onChange: (info: MediaDocumentInfo) => void,
): TextDialogController {
  const dialog = window.document.createElement('dialog');
  dialog.className = 'exocortex-media-text-dialog';

  const heading = window.document.createElement('h2');
  heading.className = 'exocortex-media-text-dialog-title';
  const notice = window.document.createElement('p');
  notice.className = 'exocortex-media-text-dialog-notice';
  notice.hidden = true;
  const textarea = window.document.createElement('textarea');
  textarea.className = 'exocortex-media-text-dialog-textarea';
  const errorLine = window.document.createElement('p');
  errorLine.className = 'exocortex-media-text-dialog-error';
  errorLine.hidden = true;

  const discardButton = window.document.createElement('button');
  discardButton.type = 'button';
  discardButton.className = 'exocortex-media-text-dialog-discard';
  discardButton.textContent = 'Korrektur verwerfen';
  discardButton.hidden = true;

  const saveButton = window.document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'exocortex-media-text-dialog-save';
  saveButton.textContent = 'Speichern';
  saveButton.hidden = resolver.correctText === undefined;

  const closeButton = window.document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'exocortex-media-text-dialog-close';
  closeButton.textContent = 'Schließen';
  closeButton.addEventListener('click', () => closeDialog(dialog));

  const actions = window.document.createElement('div');
  actions.className = 'exocortex-media-text-dialog-actions';
  actions.append(discardButton, saveButton, closeButton);

  dialog.append(heading, notice, textarea, errorLine, actions);
  window.document.body.append(dialog);

  function renderDetail(detail: MediaDocumentDetail): void {
    heading.textContent = detail.filename ?? fallbackTitle;
    textarea.value = detail.text ?? '';
    textarea.readOnly = resolver.correctText === undefined;

    const notices: string[] = [];
    if (detail.correction !== null) {
      const day = formatDay(detail.correction.editedAt);
      notices.push(day === null ? 'Von Hand korrigiert.' : `Von Hand korrigiert am ${day}.`);
    }
    if (detail.truncated) {
      notices.push('Der ausgelesene Text wurde gekürzt und ist nicht vollständig.');
    }
    if (detail.error !== null) notices.push(`Fehler bei der letzten Auslesung: ${detail.error}`);
    notice.textContent = notices.join(' ');
    notice.hidden = notices.length === 0;

    discardButton.hidden = detail.correction === null || resolver.correctText === undefined;
    errorLine.hidden = true;
  }

  function runCorrection(text: string | null, button: HTMLButtonElement): void {
    if (resolver.correctText === undefined) return;
    button.disabled = true;
    errorLine.hidden = true;
    void resolver.correctText(src, text).then(
      (detail) => {
        button.disabled = false;
        if (detail === null) return;
        renderDetail(detail);
        onChange(detail);
      },
      () => {
        button.disabled = false;
        errorLine.textContent = 'Das hat nicht geklappt. Bitte erneut versuchen.';
        errorLine.hidden = false;
      },
    );
  }

  saveButton.addEventListener('click', () => runCorrection(textarea.value, saveButton));
  discardButton.addEventListener('click', () => runCorrection(null, discardButton));

  return {
    open: (detail) => {
      renderDetail(detail);
      openDialog(dialog);
    },
    dispose: () => dialog.remove(),
  };
}

/**
 * `showModal`/`close` give correct focus trapping and Escape-to-close in
 * every real browser, but are unimplemented in the jsdom environment the unit
 * tests run under, so both fall back to toggling the `open` attribute
 * directly rather than throwing.
 */
function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/** Live DOM for the node view. */
function buildMediaElement(kind: MediaKind, src: string, name: string): HTMLElement {
  const label = name.length > 0 ? name : src;

  if (kind.name === 'video' || kind.name === 'audio') {
    const player = window.document.createElement(kind.name);
    player.src = src;
    player.controls = true;
    player.preload = 'metadata';
    return player;
  }

  if (kind.name === 'pdf') return buildPdfElement(src, label);

  const anchor = window.document.createElement('a');
  anchor.href = src;
  anchor.rel = 'noopener noreferrer';
  anchor.download = '';
  anchor.textContent = label;
  return anchor;
}

export const MEDIA_EXTENSIONS = MEDIA_KINDS.map(createMediaNode).map((node, index) =>
  index === 0
    ? node.extend({
        // The shared command lives on the first node so it is registered once.
        addCommands() {
          return {
            insertMedia:
              (type, attributes) =>
              ({ commands }) =>
                commands.insertContent({
                  type,
                  attrs: { src: attributes.src, name: attributes.name ?? '' },
                }),
          };
        },
      })
    : node,
);

/** Node names contributed here, for tests and for the addressable-block list. */
export const MEDIA_NODE_NAMES = MEDIA_KINDS.map((kind) => kind.name);

export const mediaMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.name,
      (node, context) => {
        const src = stringAttribute(node.attrs?.src);
        const name = stringAttribute(node.attrs?.name);
        const params = name.length > 0 ? `${src} ${name}` : src;
        return `:::${kind.container} ${params}${context.blockIdSuffix(node)}\n:::\n\n`;
      },
    ]),
  ),
  containers: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.container,
      (params, context) => {
        // The URL cannot contain a space, so the first one separates it from the
        // display name.
        const separator = params.indexOf(' ');
        const src = separator === -1 ? params : params.slice(0, separator);
        const name = separator === -1 ? '' : params.slice(separator + 1).trim();
        context.addNode(kind.name, { src, name });
        return 0;
      },
    ]),
  ),
};

/** Search projection: the file name is the searchable part, the URL is not. */
export const mediaPlainTextAdapter: PlainTextAdapter = {
  blocks: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.name,
      (node) => {
        const name = stringAttribute(node.attrs?.name);
        return name.length > 0 ? `${name}\n` : '';
      },
    ]),
  ),
};

export const mediaBlocks: readonly BlockCatalogEntry[] = MEDIA_KINDS.map((kind) => ({
  id: kind.container,
  label: kind.label,
  description: kind.description,
  keywords: kind.keywords,
  group: 'media' as const,
  icon: kind.icon,
  prompt: 'file' as const,
  turnInto: false,
  run: (editor, value) => {
    if (value === undefined || value.length === 0) return false;
    return editor.chain().focus().insertMedia(kind.name, { src: value }).run();
  },
  isActive: (editor) => editor.isActive(kind.name),
}));
