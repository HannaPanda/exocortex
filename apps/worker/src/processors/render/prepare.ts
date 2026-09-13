/**
 * Turning eXocortex Markdown into something Pandoc can read (issue #44).
 *
 * Three small transformations, and each of them exists because leaving the text
 * alone produces a visibly wrong PDF rather than an error:
 *
 * - an image points at `/api/attachments/<id>/download`, which means nothing
 *   inside a container with no network
 * - `[[Andere Seite]]` is eXocortex's wiki link, which Pandoc prints verbatim,
 *   brackets and all
 * - `@[[Seite]]` and `@(Person)` mentions are the same problem one level in
 *
 * Everything else -- headings, lists, tables, code, footnotes, quotes -- is
 * Pandoc's job, and deliberately not touched here (ADR-026).
 */

/** How an image reference in the body is written by the editor. */
const ATTACHMENT_IMAGE = /!\[([^\]]*)\]\(\/api\/attachments\/([A-Za-z0-9_-]+)\/download[^)]*\)/g;

/** `[[Ziel]]` or `[[Ziel|Label]]`, including the mention form `@[[Ziel]]`. */
const WIKI_LINK = /@?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface PreparedMarkdown {
  markdown: string;
  /** Attachment ids the document refers to, in order of first appearance. */
  attachmentIds: string[];
}

/**
 * Rewrites attachment images to the local file names the archive will carry.
 *
 * The extension is decided later, from the attachment's MIME type, so the name
 * here is only the id; `--resource-path` inside the container finds it in the
 * `assets` directory. An image whose bytes cannot be fetched is replaced by its
 * alt text in `dropAsset`, because a LaTeX run with a missing `\includegraphics`
 * does not warn, it stops.
 */
export function collectAttachmentImages(markdown: string): PreparedMarkdown {
  const attachmentIds: string[] = [];
  const rewritten = markdown.replace(ATTACHMENT_IMAGE, (_match, alt: string, id: string) => {
    if (!attachmentIds.includes(id)) attachmentIds.push(id);
    return `![${alt}](assets/${id})`;
  });
  return { markdown: rewritten, attachmentIds };
}

/** Points an image at the real file name once its type is known. */
export function bindAssetName(markdown: string, id: string, filename: string): string {
  return markdown.split(`](assets/${id})`).join(`](assets/${filename})`);
}

/**
 * Removes an image whose bytes are not available, keeping its alt text.
 *
 * Silently dropping the picture would be worse: the sentence around it usually
 * refers to it, and a reader of the PDF has no way to find out that something
 * was there.
 */
export function dropAsset(markdown: string, id: string): string {
  return markdown.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(assets/${id}\\)`, 'g'),
    (_match, alt: string) => (alt.length > 0 ? `_[${alt}]_` : ''),
  );
}

/**
 * Flattens wiki links to their label.
 *
 * A PDF cannot follow a link into this deployment, and a printed
 * `[[Architektur]]` is noise. The label survives, so the sentence still names
 * what it was pointing at.
 */
export function flattenWikiLinks(markdown: string): string {
  return markdown.replace(WIKI_LINK, (_match, target: string, label?: string) => label ?? target);
}

/** Escapes one scalar for the YAML metadata file. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * The metadata file handed to Pandoc.
 *
 * Flat by design: every value is a string, because a template variable ends up
 * in a LaTeX document and there is nothing else it could sensibly be. The three
 * keys Pandoc's own templates expect (`title`, `date`, `author`) are written
 * first and can be overridden by a declared variable of the same name, which is
 * how a template that wants its own title page gets one.
 */
export function buildMetadataYaml(input: {
  title: string;
  date: string;
  author: string;
  variables: Readonly<Record<string, string>>;
}): string {
  const merged: Record<string, string> = {
    title: input.title,
    date: input.date,
    ...(input.author.length === 0 ? {} : { author: input.author }),
    ...input.variables,
  };
  const lines = Object.entries(merged).map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  // `lang` last so a template may not override it into something the container
  // has no hyphenation patterns for; German is what the visible text is in.
  lines.push('lang: "de-DE"');
  return `${lines.join('\n')}\n`;
}
