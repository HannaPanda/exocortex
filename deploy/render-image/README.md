# Render image

`pandoc/extra:latest` is the default for `render.image` and `projects.image`.
It carries Pandoc, a TinyTeX-sized TeX Live, `latexmk` and the Eisvogel
template, which is enough for every template that does not name a font.

A template that does name one needs the font inside the image: the build
container has no network. `Dockerfile` derives an image for this deployment.

```bash
docker build -t exocortex-render:latest deploy/render-image
```

Afterwards set `render.image` to `exocortex-render:latest` under
`/admin/einstellungen`. Existing builds do not notice a changed image -- the
input hash cannot see it -- so rebuild the first one with `force: true`.

| Added                                           | Why                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raleway`                                       | The body face of the letter template and the CV it matches.                                                                                                                         |
| `fundus-calligra`, `calligra`, `calligra-type1` | The script face in the letterhead. `calligra.sty` lives in `fundus-calligra`, the font itself in the other two.                                                                     |
| `fontawesome`                                   | The phone and envelope glyphs. `fontawesome5` is already in the base image and is what the templates try first; this is the fallback for sources written against the older package. |
| `parskip`, `ragged2e`                           | Small typesetting helpers a template may reach for.                                                                                                                                 |
