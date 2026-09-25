import { type EditorWords } from './editor-words';
import {
  describeCorrectionAndTruncation,
  describeDocument,
  describeTextError,
} from './media-describe';
import { type MediaDocumentInfo, type MediaInfoResolver } from './media-info';
import { createTextDialog, type TextDialogController } from './media-text-dialog';

/**
 * The live half of a media block that has a text layer: the line under it
 * saying what was read out of the file, the actions on that line, and the
 * polling while an extraction runs (issue #97 split it out of `media.ts`).
 */

/** The two media kinds that carry a text layer; video and audio never do. */
export type DocumentMediaName = 'pdf' | 'fileAttachment';

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

/** Replaces a placeholder label once the real file name is known. */
function applyLabel(kind: DocumentMediaName, element: HTMLElement, label: string): void {
  if (kind !== 'pdf') {
    element.textContent = label;
    return;
  }
  const title = element.querySelector('.exocortex-pdf-name');
  if (title !== null) title.textContent = label;
}

/**
 * The line under a media block describing what was read out of the file.
 *
 * Returns null when there is nothing to resolve, so the caller has nothing to
 * clean up either.
 */
export function attachDocumentDetails(
  kind: DocumentMediaName,
  element: HTMLElement,
  file: { src: string; name: string },
  resolver: MediaInfoResolver | null,
  words: EditorWords['media'],
): { cancel: () => void } | null {
  const { src, name } = file;
  if (resolver === null || src.length === 0) return null;

  const bar = window.document.createElement('div');
  bar.className = 'exocortex-media-meta';
  bar.hidden = true;
  // Inside the PDF frame it belongs under the header; a file block is a single
  // link, so the line goes after it rather than into it.
  if (kind === 'pdf') element.querySelector('.exocortex-pdf-header')?.after(bar);
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

    for (const chip of describeDocument(info.metadata, words)) bar.append(buildChip(chip));

    // `not_applicable` only ever reaches this point for a file that *could* be
    // read, because the silent case returned above: it means nobody has asked
    // yet. `ready` says so too, which is what gives "Ansehen" somewhere to sit
    // (issue #2).
    const noteChip = buildChip(words.status[info.status]);
    noteChip.classList.add(`exocortex-media-chip-${info.status}`);
    // The reason a document could not be read is worth having, but not worth
    // a second line in a header.
    const reason = describeTextError(info, words);
    if (reason !== null) noteChip.title = reason;
    bar.append(noteChip);

    for (const chip of describeCorrectionAndTruncation(info, words)) bar.append(buildChip(chip));

    // Both offer the same action, but they are not the same situation: one
    // failed, the other was never asked.
    const retryAction =
      info.status === 'failed'
        ? buildActionButton(words.retry, 'exocortex-media-retry', resolver.request)
        : info.status === 'not_applicable'
          ? buildActionButton(words.extract, 'exocortex-media-retry', resolver.request)
          : null;
    if (retryAction !== null) bar.append(retryAction);

    // Separate from the retry above: `request` never re-runs a `ready`
    // attachment, so a successful-but-wrong extraction needed its own explicit
    // "no, really, again" (issue #2).
    const forceAction =
      info.status === 'ready'
        ? buildActionButton(words.reextract, 'exocortex-media-force', resolver.forceReextract)
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
    button.textContent = words.view;
    button.addEventListener('click', () => {
      if (resolver.readText === undefined) return;
      button.disabled = true;
      void resolver.readText(src).then(
        (detail) => {
          button.disabled = false;
          if (detail === null) return;
          dialog ??= createTextDialog(resolver, src, name.length > 0 ? name : src, render, words);
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
