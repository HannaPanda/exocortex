/**
 * What arrives at `/teilen` (issue #72).
 *
 * Two senders, one route: the PWA share target, which the operating system
 * fills, and the bookmarklet, which fills itself. Neither is reliable in the
 * same way. Android hands a shared link over in `text` rather than in `url`
 * often enough that treating the two as separate fields loses the address
 * about half the time, so the address is read out of whatever came.
 */
export interface SharedContent {
  /** The page that was shared, when one can be made out. */
  url: string | null;
  /** Its title, as the sender knew it. */
  title: string | null;
  /** What is left over: the selection, a remark, or nothing. */
  text: string | null;
}

const WEB_ADDRESS = /https?:\/\/\S+/;

export function readShare(params: {
  url?: string | null;
  title?: string | null;
  text?: string | null;
}): SharedContent {
  const title = clean(params.title);
  const given = clean(params.url);
  const text = clean(params.text);

  if (given !== null) return { url: given, title, text };
  if (text === null) return { url: null, title, text: null };

  const found = WEB_ADDRESS.exec(text);
  if (found === null) return { url: null, title, text };

  // The address is lifted out of the text rather than left in it. A shared
  // link that stays in the body is written on the page twice: once as the
  // provenance line the clip builds, once as a stray line above it.
  const rest = clean(text.replace(found[0], ''));
  return { url: found[0], title, text: rest };
}

function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The bookmarklet, for every browser that will never have a share target.
 * It opens `/teilen` in a small window rather than navigating, because a
 * clipper that throws away the page being clipped is not one anybody uses
 * twice, and it cuts the selection at 5000 characters, because an address bar
 * is not a place to put an article.
 */
export function bookmarkletFor(origin: string): string {
  return (
    `javascript:(function(){var s=String(getSelection()||'').slice(0,5000);` +
    `window.open('${origin}/teilen?url='+encodeURIComponent(location.href)` +
    `+'&title='+encodeURIComponent(document.title)+'&text='+encodeURIComponent(s),` +
    `'exocortex-clip','width=540,height=720');})()`
  );
}
