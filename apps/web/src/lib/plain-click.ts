/**
 * Whether a click on a link is an ordinary one, the kind the application may
 * take over (open a dialog in place, switch a group) instead of navigating.
 * A modified click keeps the browser's meaning: a new tab, a new window, a
 * download.
 */
export function isPlainClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
