/**
 * What a template hands the layout: words and links, no markup (issue #109).
 *
 * A template decides what a mail says and in which order; the layout decides
 * what that looks like, in HTML and in plain text, from the same values. That
 * split is the reason the blocks are a closed union and carry strings only:
 * there is no block that accepts markup, so a page title, a comment preview,
 * an automation's output or a person's name can never become a tag, however it
 * was written. A mail that ever needs rich content gets a new block kind here,
 * decided on purpose, rather than a string that happens to be trusted.
 */

/** A line of a digest: who said what, or anything else short. */
export interface MailListItem {
  /** Shown bold in HTML and before a colon in text, e.g. the author. */
  label?: string;
  text: string;
  /** Whether the text is a quotation, which puts it in the reader's quotation marks. */
  quoted?: boolean;
}

export type MailBlock =
  /** A paragraph of running text. Line breaks in it are kept. */
  | { kind: 'paragraph'; text: string }
  /** The one thing the mail wants the reader to do: a button in HTML. */
  | { kind: 'action'; label: string; url: string }
  /** A plain link, for anything that is not the main action. */
  | { kind: 'link'; label: string; url: string }
  /** Label and value pairs, such as what a share allows and until when. */
  | { kind: 'facts'; rows: readonly { label: string; value: string }[] }
  /** A remark that should stand out: a status, a warning, a consequence. */
  | { kind: 'notice'; text: string }
  /** One group of a digest: a heading, its lines, a link to where it happens. */
  | {
      kind: 'section';
      title: string;
      items: readonly MailListItem[];
      /** A last, muted line such as „und 3 weitere“. */
      more?: string;
      link?: { label: string; url: string };
    }
  /**
   * Text that is shown as written, keeping its line breaks and spacing: the
   * page an `EMAIL_SELF` rule sends. Escaped like everything else; Markdown in
   * it stays Markdown.
   */
  | { kind: 'excerpt'; text: string };

export interface MailContent {
  subject: string;
  /**
   * The line an inbox shows beside the subject. Invisible in the mail itself;
   * without it most clients show whatever the first text node is, which for
   * this layout would be the wordmark.
   */
  preheader: string;
  /** The heading above the body in HTML. Plain text leaves it to the subject. */
  heading: string;
  /** „Hallo Stefan,“ -- the first line of both versions. */
  greeting?: string;
  blocks: readonly MailBlock[];
  /** Why the reader gets this and where it is switched off. Muted, below a rule. */
  footer?: readonly string[];
}
