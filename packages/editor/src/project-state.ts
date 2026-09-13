import * as Y from 'yjs';

/**
 * The Yjs shape of a project's file tree (issue #43, ADR-027).
 *
 * A project is a `Document` with `type: PROJECT`, so its canonical state is the
 * same `DocumentContent.yjsState` column, the same Hocuspocus room and the same
 * snapshots as a page. What differs is what is inside: a page holds a
 * ProseMirror `XmlFragment`, a project holds a map of paths.
 *
 *     Y.Doc
 *       └── Y.Map "projectFiles"
 *             ├── "main.tex"          -> Y.Map { kind: 'TEXT',  text: Y.Text }
 *             ├── "chapters/intro.tex"-> Y.Map { kind: 'TEXT',  text: Y.Text }
 *             └── "images/plot.png"   -> Y.Map { kind: 'ASSET', attachmentId, … }
 *
 * Three decisions are worth stating because the alternatives look tempting:
 *
 * *One document per project, not per file.* A project is one collaboration and
 * permission boundary; one room means one ticket, one authorization decision
 * and one snapshot, and opening the tenth file in a project opens no tenth
 * socket.
 *
 * *Paths are keys, directories are not entries.* A directory is the prefix of
 * the paths under it. That makes an empty directory impossible to represent,
 * which is a loss worth taking: it also makes a rename a prefix substitution
 * and removes the entire class of bug where a tree and its files disagree.
 *
 * *Binary bytes are never here.* An asset entry holds an attachment id and its
 * size. Putting a font or a photograph into a CRDT would make every client
 * download every byte of every revision for ever.
 */

/** Top-level map in a project document. */
export const PROJECT_FILES_FIELD = 'projectFiles';

/** Keys inside one file entry. */
const KIND_KEY = 'kind';
const TEXT_KEY = 'text';
const ATTACHMENT_KEY = 'attachmentId';
const BYTE_SIZE_KEY = 'byteSize';
const MIME_TYPE_KEY = 'mimeType';

export type ProjectFileEntryKind = 'TEXT' | 'ASSET';

/** One path in the tree, as it comes out of the Yjs state. */
export interface ProjectFileEntry {
  path: string;
  kind: ProjectFileEntryKind;
  /** The source, for a text file. Null for an asset. */
  content: string | null;
  /** Where the bytes are, for an asset. Null for a text file. */
  attachmentId: string | null;
  mimeType: string | null;
  /** UTF-8 length for a text file, the attachment's size for an asset. */
  byteSize: number;
}

/** What an asset entry needs beyond its path. */
export interface ProjectAssetInput {
  attachmentId: string;
  byteSize: number;
  mimeType: string | null;
}

export class ProjectStateError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectStateError';
    this.code = code;
  }
}

type FileEntryMap = Y.Map<unknown>;

/**
 * Bytes, not characters.
 *
 * `TextEncoder` rather than `Buffer.byteLength`: this module is imported by the
 * browser bundle as well as by the worker, and `Buffer` does not exist there.
 */
const UTF8 = new TextEncoder();

function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}

/** The files map of a project document, created on first access. */
export function projectFilesMap(doc: Y.Doc): Y.Map<FileEntryMap> {
  return doc.getMap<FileEntryMap>(PROJECT_FILES_FIELD);
}

function readEntry(path: string, entry: FileEntryMap): ProjectFileEntry {
  const kind = entry.get(KIND_KEY) === 'ASSET' ? 'ASSET' : 'TEXT';
  if (kind === 'ASSET') {
    const size = entry.get(BYTE_SIZE_KEY);
    return {
      path,
      kind,
      content: null,
      attachmentId:
        typeof entry.get(ATTACHMENT_KEY) === 'string' ? String(entry.get(ATTACHMENT_KEY)) : null,
      mimeType:
        typeof entry.get(MIME_TYPE_KEY) === 'string' ? String(entry.get(MIME_TYPE_KEY)) : null,
      byteSize: typeof size === 'number' ? size : 0,
    };
  }
  const text = entry.get(TEXT_KEY);
  const content = text instanceof Y.Text ? text.toString() : '';
  return {
    path,
    kind,
    content,
    attachmentId: null,
    mimeType: null,
    byteSize: utf8Length(content),
  };
}

/**
 * Every path in the project, sorted.
 *
 * Sorted here rather than by each caller: the file tree, the build archive and
 * the input hash all need a stable order, and three orders that agree by
 * accident are three orders that will eventually disagree.
 */
export function readProjectTree(doc: Y.Doc): ProjectFileEntry[] {
  const files = projectFilesMap(doc);
  const entries: ProjectFileEntry[] = [];
  for (const [path, entry] of files.entries()) {
    entries.push(readEntry(path, entry));
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** How many paths the project holds. */
export function projectFileCount(doc: Y.Doc): number {
  return projectFilesMap(doc).size;
}

/** Whether something already sits at this path. */
export function projectHasPath(doc: Y.Doc, path: string): boolean {
  return projectFilesMap(doc).has(path);
}

/** Just the paths, sorted. Cheaper than `readProjectTree` for an existence check. */
export function readProjectPaths(doc: Y.Doc): string[] {
  return [...projectFilesMap(doc).keys()].sort();
}

/** The source of one text file, or null when the path holds nothing or an asset. */
export function readProjectFileText(doc: Y.Doc, path: string): string | null {
  const entry = projectFilesMap(doc).get(path);
  if (entry === undefined) return null;
  const text = entry.get(TEXT_KEY);
  return text instanceof Y.Text ? text.toString() : null;
}

/**
 * Replaces a `Y.Text`'s content with as small an edit as possible.
 *
 * A delete-everything-then-insert would work and is what a first version
 * writes. It also moves every collaborator's cursor to the start of the file,
 * discards their selection, and puts the whole file into the update -- for a
 * write that changed one word. Trimming the common prefix and suffix costs two
 * loops and leaves the untouched parts untouched, which is what a CRDT is for.
 */
function applyTextEdit(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;

  let prefix = 0;
  const maxPrefix = Math.min(current.length, next.length);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(current.length - prefix, next.length - prefix);
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const removed = current.length - prefix - suffix;
  if (removed > 0) text.delete(prefix, removed);
  const inserted = next.slice(prefix, next.length - suffix);
  if (inserted.length > 0) text.insert(prefix, inserted);
}

function requireEntry(files: Y.Map<FileEntryMap>, path: string): FileEntryMap {
  const entry = files.get(path);
  if (entry === undefined) {
    throw new ProjectStateError('file_not_found', `No file at "${path}"`);
  }
  return entry;
}

/**
 * Creates or overwrites a text file.
 *
 * `createOnly` refuses an existing path rather than overwriting it, which is
 * the difference between "add a chapter" and "save this chapter" -- one flag
 * instead of two functions, because a caller unsure whether the file exists is
 * exactly the caller that would pick the wrong one of two.
 */
export function writeProjectTextFile(
  doc: Y.Doc,
  path: string,
  content: string,
  options: { createOnly?: boolean } = {},
): void {
  const files = projectFilesMap(doc);
  doc.transact(() => {
    const existing = files.get(path);
    if (existing !== undefined) {
      if (options.createOnly === true) {
        throw new ProjectStateError('file_exists', `A file already exists at "${path}"`);
      }
      const text = existing.get(TEXT_KEY);
      if (text instanceof Y.Text) {
        applyTextEdit(text, content);
        return;
      }
      // The path holds an asset. Replacing it with a text file is a deliberate
      // overwrite, so the entry is rebuilt rather than patched.
      files.delete(path);
    }
    const entry = new Y.Map<unknown>();
    files.set(path, entry);
    entry.set(KIND_KEY, 'TEXT');
    const text = new Y.Text();
    entry.set(TEXT_KEY, text);
    if (content.length > 0) text.insert(0, content);
  });
}

/**
 * Replaces an exact piece of text inside a file.
 *
 * Refuses rather than guesses: `oldText` that is absent, or present more than
 * once without `replaceAll`, changes nothing. That refusal is the point -- an
 * agent that patched the wrong of three identical lines would produce a build
 * that succeeds and a document that is wrong.
 */
export function patchProjectTextFile(
  doc: Y.Doc,
  path: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean } = {},
): number {
  const files = projectFilesMap(doc);
  const entry = requireEntry(files, path);
  const text = entry.get(TEXT_KEY);
  if (!(text instanceof Y.Text)) {
    throw new ProjectStateError('not_a_text_file', `"${path}" is not a text file`);
  }

  const current = text.toString();
  const occurrences: number[] = [];
  let at = current.indexOf(oldText);
  while (at !== -1) {
    occurrences.push(at);
    at = current.indexOf(oldText, at + oldText.length);
  }

  if (occurrences.length === 0) {
    throw new ProjectStateError('patch_not_found', `"${path}" does not contain that text`);
  }
  if (occurrences.length > 1 && options.replaceAll !== true) {
    throw new ProjectStateError(
      'patch_not_unique',
      `"${path}" contains that text ${String(occurrences.length)} times`,
    );
  }

  const targets = options.replaceAll === true ? occurrences : [occurrences[0] as number];
  doc.transact(() => {
    // Back to front, so an earlier replacement cannot move a later offset.
    for (const offset of [...targets].reverse()) {
      text.delete(offset, oldText.length);
      if (newText.length > 0) text.insert(offset, newText);
    }
  });
  return targets.length;
}

/** Binds an already uploaded attachment to a path. */
export function addProjectAsset(doc: Y.Doc, path: string, asset: ProjectAssetInput): void {
  const files = projectFilesMap(doc);
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    files.set(path, entry);
    entry.set(KIND_KEY, 'ASSET');
    entry.set(ATTACHMENT_KEY, asset.attachmentId);
    entry.set(BYTE_SIZE_KEY, asset.byteSize);
    entry.set(MIME_TYPE_KEY, asset.mimeType);
  });
}

/**
 * Moves one path, or a whole directory when `recursive` is set.
 *
 * A move is a delete and an insert, not a rename: a `Y.Map` key cannot be
 * renamed, and re-creating the `Y.Text` at the new key is what a rename would
 * have to do anyway. Anyone typing in the file at that moment loses their
 * cursor, which is the honest consequence of the file having moved out from
 * under them.
 */
export function moveProjectPath(
  doc: Y.Doc,
  from: string,
  to: string,
  options: { recursive?: boolean } = {},
): string[] {
  const files = projectFilesMap(doc);
  const recursive = options.recursive === true;

  const sources = [...files.keys()].filter(
    (key) => key === from || (recursive && key.startsWith(`${from}/`)),
  );
  if (sources.length === 0) {
    throw new ProjectStateError('file_not_found', `No file at "${from}"`);
  }

  const moves = sources.map((source) => ({
    from: source,
    to: source === from ? to : `${to}${source.slice(from.length)}`,
  }));

  for (const move of moves) {
    if (move.from !== move.to && files.has(move.to)) {
      throw new ProjectStateError('file_exists', `A file already exists at "${move.to}"`);
    }
  }

  const moved: string[] = [];
  doc.transact(() => {
    for (const move of moves) {
      if (move.from === move.to) continue;
      const entry = requireEntry(files, move.from);
      const snapshot = readEntry(move.from, entry);
      files.delete(move.from);

      const next = new Y.Map<unknown>();
      files.set(move.to, next);
      if (snapshot.kind === 'ASSET') {
        next.set(KIND_KEY, 'ASSET');
        next.set(ATTACHMENT_KEY, snapshot.attachmentId);
        next.set(BYTE_SIZE_KEY, snapshot.byteSize);
        next.set(MIME_TYPE_KEY, snapshot.mimeType);
      } else {
        next.set(KIND_KEY, 'TEXT');
        const text = new Y.Text();
        next.set(TEXT_KEY, text);
        const content = snapshot.content ?? '';
        if (content.length > 0) text.insert(0, content);
      }
      moved.push(move.to);
    }
  });
  return moved.sort();
}

/** Removes one path, or a whole directory when `recursive` is set. */
export function deleteProjectPath(
  doc: Y.Doc,
  path: string,
  options: { recursive?: boolean } = {},
): string[] {
  const files = projectFilesMap(doc);
  const recursive = options.recursive === true;
  const targets = [...files.keys()].filter(
    (key) => key === path || (recursive && key.startsWith(`${path}/`)),
  );
  if (targets.length === 0) {
    throw new ProjectStateError('file_not_found', `No file at "${path}"`);
  }
  doc.transact(() => {
    for (const target of targets) files.delete(target);
  });
  return targets.sort();
}

/**
 * Binary Yjs state for a brand-new project.
 *
 * The only place a project's state is built rather than edited: creating one
 * through the API has no live document to write into yet, so the first state is
 * encoded here and stored, exactly like a page created from Markdown.
 */
export function projectFilesToYjsState(
  files: readonly { path: string; content: string }[],
): Uint8Array {
  const doc = new Y.Doc();
  try {
    for (const file of files) {
      writeProjectTextFile(doc, file.path, file.content);
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
