/**
 * The seam between a media block and its host: what the block may ask about a
 * file, and the shapes the answers come in.
 *
 * Split out of `media.ts` so the contract a host implements can be read without
 * the node definition and the DOM code around it (issue #97).
 */

/**
 * What an extraction knows about a document, as the block needs it.
 *
 * Structurally identical to the relevant part of `DocumentTextMetadata` in
 * `@exocortex/contracts`, but declared here rather than imported: this package
 * is a leaf and depends on no other Exocortex package (see
 * `scripts/dependency-graph.mjs`). The host passes its contract object straight
 * in; TypeScript accepts it because the shapes line up.
 */
export interface MediaDocumentMetadata {
  title: string | null;
  author: string | null;
  creator: string | null;
  createdAt: string | null;
  pageCount: number | null;
  tableCount: number | null;
  pictureCount: number | null;
  ocrUsed: boolean | null;
}

/**
 * Records that a person edited the extracted text by hand (issue #2).
 *
 * Metadata only, no text: this rides along on every `read()`, so the meta bar
 * can show "von Hand korrigiert" without pulling the correction itself.
 */
export interface MediaDocumentCorrection {
  editedAt: string;
  editedById: string;
}

export interface MediaDocumentInfo {
  status: 'not_applicable' | 'pending' | 'ready' | 'failed';
  metadata: MediaDocumentMetadata | null;
  /** The English detail of a failed read, kept for rows from before `errorCode`. */
  error: string | null;
  /** Why the read failed, as a code the host's words turn into a sentence (issue #98). */
  errorCode: string | null;
  /**
   * The stored file name, used when the block has none of its own.
   *
   * The slash menu inserts a media block with only a `src` (see `mediaBlocks`
   * in `media.ts`: the file prompt resolves to a URL and nothing else), so those
   * blocks would otherwise show the download URL where the file name belongs.
   * Documents written that way are already out there, so the label is repaired
   * from the resolved answer rather than only at insertion time.
   */
  filename: string | null;
  /**
   * Whether this file has a text layer worth chasing at all.
   *
   * `not_applicable` means two different things depending on it. For an image
   * or a zip it is the final answer and the block stays silent. For a PDF it
   * means nobody ever asked -- true of every PDF uploaded before extraction
   * existed -- and staying silent there would leave the reader with a block
   * that shows nothing and offers nothing.
   */
  extractable: boolean;
  /** Present once a person has corrected the extracted text; absent otherwise. */
  correction: MediaDocumentCorrection | null;
  /** True when the extracted text was cut off at the server's character cap. */
  truncated: boolean;
}

/**
 * `MediaDocumentInfo` plus the two fields that can be 400,000 characters long
 * (issue #2). Loaded only when a reader actually asks to see the text, through
 * `MediaInfoResolver.readText`, never as part of the render-time `read`.
 */
export interface MediaDocumentDetail extends MediaDocumentInfo {
  /** The version to show and to edit: the correction if there is one. */
  text: string | null;
  /** The raw machine result, regardless of whether a correction exists. */
  machineText: string | null;
}

/**
 * How a block learns what a file contains.
 *
 * The editor never talks to the API itself -- it does not know the route shape
 * and must not -- so the host injects this through
 * `buildEditorExtensions({ mediaInfo })`. Without it the blocks render exactly
 * as before, which is what keeps server-side rendering and the tests unchanged.
 */
export interface MediaInfoResolver {
  /**
   * Reads the current state for a media `src`. Must be free of side effects: it
   * runs on every render, so it may not start an extraction.
   *
   * Null when `src` is nothing the host can describe.
   */
  read(src: string): Promise<MediaDocumentInfo | null>;
  /**
   * Asks for an extraction to (re-)run. Absent when the reader may not.
   *
   * This and `forceReextract` are function properties rather than methods
   * because the block hands them to a button as they are, without a `this`.
   */
  request?: (src: string) => Promise<MediaDocumentInfo | null>;
  /**
   * Loads the full text for the "Ansehen" dialog (issue #2). Absent when the
   * reader may not view it -- which never happens today, but keeps the same
   * "absent means not offered" shape as `request`.
   */
  readText?(src: string): Promise<MediaDocumentDetail | null>;
  /**
   * Forces a fresh extraction even though the current one is already `ready`
   * (issue #2). Distinct from `request`, which never re-runs a `ready` one.
   * Absent when the reader may not.
   */
  forceReextract?: (src: string) => Promise<MediaDocumentInfo | null>;
  /**
   * Writes a human correction of the extracted text, or with `text: null`
   * clears one (issue #2). Absent when the reader may not edit.
   */
  correctText?(src: string, text: string | null): Promise<MediaDocumentDetail | null>;
  /**
   * Draws the PDF itself into `container`, and returns how to take it down
   * again (issue #70).
   *
   * Injected rather than done here, and that is the whole point of it being on
   * this interface. Showing a PDF means pdf.js, and this package is also read
   * by the server -- materialization, Markdown, HTML export -- so a browser
   * renderer inside it would travel into bundles that never draw anything. The
   * host has one already; this is how it reaches the block.
   *
   * Absent on the server and in the tests, and then the block renders exactly
   * as it did before: the file's name, the two actions, and no preview.
   */
  renderPdf?(container: HTMLElement, src: string): () => void;
}
