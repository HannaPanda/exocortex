# Brand assets

Four files, and none of them is imported by the application at runtime. The
components in `../components/logo.tsx` carry the same geometry inline, because a
logo that arrives as a second network request is a logo that is missing during
the first paint.

| File                        | What it is                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| `exocortex-mark.svg`        | The mark alone, centred in a square box. For anything that is not the product UI. |
| `exocortex-lockup.svg`      | Mark, rule, wordmark.                                                             |
| `Neuropol.otf`              | The typeface the wordmark was set in, kept so it can be reset.                    |
| `exocortex-mark-source.svg` | The mark as delivered, before the transform was flattened.                        |

## The wordmark

Set in **Neuropol**, Ray Larabie, 1996, released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) in 2024. The
font's own `license` name record states it: "This font has been released under a
no rights reserved Creative Commons Zero license." No attribution is required
and none is owed; it is recorded here so a later session does not have to
re-establish that the file is safe to ship.

Do not confuse it with **Neuropol X**, the commercial expansion Typodermic still
sells. That one is not in this repository and must not be added to it.

The wordmark was set at 940 units with 20/1000 em of extra tracking and
converted to outlines. To reset it, lay the glyphs out by hand rather than
calling `getPath` on the whole string, so the tracking is ours and not the
font's:

```js
const font = opentype.parse(readFileSync('Neuropol.otf').buffer);
let pen = 0;
const parts = [];
for (const g of font.stringToGlyphs('eXocortex')) {
  parts.push(g.getPath(pen, 0, 940).toPathData(1));
  pen += (g.advanceWidth / font.unitsPerEm) * 940 + 0.02 * 940;
}
```

`exocortex-mark.svg` is `exocortex-mark-source.svg` cleaned up: a potrace output whose
`translate(0,1254) scale(0.1,-0.1)` wrapper has been flattened into the path
data, re-origined to the ink and scaled to 1000 units tall. Its counters are
wound against their outlines, so it needs the default non-zero fill rule;
`fill-rule="evenodd"` fills the brain solid.

## The colours

Amber `#F9AA33` for the mark and the wordmark, light `#E7E9EB` for the rule
between them. These two are the only hardcoded colours in the design system, and
the reason is in the header comment of `logo.tsx`.
