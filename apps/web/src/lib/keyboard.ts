/**
 * Whether a keystroke happened somewhere that takes text.
 *
 * A global `keydown` listener on `window` sees every keystroke in the
 * application, including the ones the editor has already acted on: the editor's
 * ProseMirror keymap runs first and this listener runs afterwards, so a late
 * `preventDefault()` cancels nothing. A shortcut the editor also binds can
 * therefore only ever *add* a second action to the same key, which is how
 * `Strg+B` came to make text bold and collapse the navigation at once
 * (issue #81).
 *
 * So a shell shortcut that collides with a text shortcut asks this first, and
 * yields where somebody is writing. `contentEditable` covers the editor, every
 * inline title field and every comment box; `input`, `textarea` and `select`
 * cover the rest.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
