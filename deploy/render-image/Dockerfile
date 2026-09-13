# The render image for this deployment: pandoc/extra plus the fonts a document
# template here may ask for.
#
# pandoc/extra ships a TinyTeX-sized TeX Live. It has everything the built-in
# Eisvogel template needs, but not the display faces a letterhead uses, and a
# build container runs with --network none, so nothing can be fetched at build
# time. Whatever a template wants has to be in the image.
#
#   docker build -t exocortex-render:latest deploy/render-image
#
# Then point the deployment-wide setting `render.image` (and, if the same faces
# should be available to LaTeX projects, `projects.image`) at the tag.
FROM pandoc/extra:latest
USER root
RUN tlmgr update --self \
 && tlmgr install raleway calligra calligra-type1 fundus-calligra fontawesome parskip ragged2e \
 && luaotfload-tool -u -f || true
