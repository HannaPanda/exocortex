import { formatDay } from './media-describe';
import {
  type MediaDocumentDetail,
  type MediaDocumentInfo,
  type MediaInfoResolver,
} from './media-info';

export interface TextDialogController {
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
export function createTextDialog(
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
