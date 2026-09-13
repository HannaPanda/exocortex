import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  addProjectAsset,
  deleteProjectPath,
  moveProjectPath,
  patchProjectTextFile,
  projectFilesToYjsState,
  ProjectStateError,
  readProjectFileText,
  readProjectPaths,
  readProjectTree,
  writeProjectTextFile,
} from './project-state';

function project(files: Record<string, string> = {}): Y.Doc {
  const doc = new Y.Doc();
  for (const [path, content] of Object.entries(files)) {
    writeProjectTextFile(doc, path, content);
  }
  return doc;
}

describe('project state', () => {
  it('reads back what was written, sorted by path', () => {
    const doc = project({ 'main.tex': 'root', 'chapters/intro.tex': 'intro' });

    expect(readProjectPaths(doc)).toEqual(['chapters/intro.tex', 'main.tex']);
    expect(readProjectFileText(doc, 'main.tex')).toBe('root');
  });

  it('counts bytes rather than characters', () => {
    const doc = project({ 'a.tex': 'Grüße' });

    const entry = readProjectTree(doc)[0];
    expect(entry?.byteSize).toBe(7);
  });

  it('refuses to create a file that already exists', () => {
    const doc = project({ 'main.tex': 'root' });

    expect(() => {
      writeProjectTextFile(doc, 'main.tex', 'other', { createOnly: true });
    }).toThrow(ProjectStateError);
    expect(readProjectFileText(doc, 'main.tex')).toBe('root');
  });

  it('rewrites only the part of a text that actually changed', () => {
    const doc = project({ 'main.tex': 'aaa MIDDLE zzz' });
    const text = doc.getMap('projectFiles').get('main.tex') as Y.Map<unknown>;
    const target = text.get('text') as Y.Text;

    const deletes: number[] = [];
    target.observe((event) => {
      let offset = 0;
      for (const change of event.changes.delta) {
        if (typeof change.retain === 'number') offset += change.retain;
        if (typeof change.delete === 'number') deletes.push(offset);
      }
    });

    writeProjectTextFile(doc, 'main.tex', 'aaa CENTRE zzz');

    // The common prefix "aaa " is four characters, so nothing before it moved.
    expect(deletes).toEqual([4]);
    expect(readProjectFileText(doc, 'main.tex')).toBe('aaa CENTRE zzz');
  });

  it('replaces an anchored piece of text', () => {
    const doc = project({ 'main.tex': '\\section{Alt}\nText' });

    const count = patchProjectTextFile(doc, 'main.tex', '\\section{Alt}', '\\section{Neu}');

    expect(count).toBe(1);
    expect(readProjectFileText(doc, 'main.tex')).toBe('\\section{Neu}\nText');
  });

  it('refuses an ambiguous patch and changes nothing', () => {
    const doc = project({ 'main.tex': 'x\nx\n' });

    expect(() => patchProjectTextFile(doc, 'main.tex', 'x', 'y')).toThrow(/twice|2 times/);
    expect(readProjectFileText(doc, 'main.tex')).toBe('x\nx\n');
  });

  it('replaces every occurrence when asked, back to front', () => {
    const doc = project({ 'main.tex': 'a-a-a' });

    const count = patchProjectTextFile(doc, 'main.tex', 'a', 'bb', { replaceAll: true });

    expect(count).toBe(3);
    expect(readProjectFileText(doc, 'main.tex')).toBe('bb-bb-bb');
  });

  it('refuses a patch whose anchor is absent', () => {
    const doc = project({ 'main.tex': 'text' });

    expect(() => patchProjectTextFile(doc, 'main.tex', 'nope', 'x')).toThrow(ProjectStateError);
  });

  it('keeps an asset out of the text side of the tree', () => {
    const doc = project();
    addProjectAsset(doc, 'images/plot.png', {
      attachmentId: 'att1',
      byteSize: 4096,
      mimeType: 'image/png',
    });

    const entry = readProjectTree(doc)[0];
    expect(entry).toMatchObject({
      path: 'images/plot.png',
      kind: 'ASSET',
      attachmentId: 'att1',
      byteSize: 4096,
      content: null,
    });
    expect(readProjectFileText(doc, 'images/plot.png')).toBeNull();
  });

  it('moves a directory by prefix and leaves a similarly named one alone', () => {
    const doc = project({
      'chapters/intro.tex': 'a',
      'chapters/results.tex': 'b',
      'chapters-old/intro.tex': 'c',
    });

    const moved = moveProjectPath(doc, 'chapters', 'teile', { recursive: true });

    expect(moved).toEqual(['teile/intro.tex', 'teile/results.tex']);
    expect(readProjectPaths(doc)).toEqual([
      'chapters-old/intro.tex',
      'teile/intro.tex',
      'teile/results.tex',
    ]);
    expect(readProjectFileText(doc, 'teile/results.tex')).toBe('b');
  });

  it('refuses a move onto an occupied path', () => {
    const doc = project({ 'a.tex': 'a', 'b.tex': 'b' });

    expect(() => moveProjectPath(doc, 'a.tex', 'b.tex')).toThrow(ProjectStateError);
    expect(readProjectFileText(doc, 'b.tex')).toBe('b');
  });

  it('carries an asset through a move without touching its attachment', () => {
    const doc = project();
    addProjectAsset(doc, 'img/a.png', {
      attachmentId: 'att1',
      byteSize: 10,
      mimeType: 'image/png',
    });

    moveProjectPath(doc, 'img/a.png', 'bilder/a.png');

    expect(readProjectTree(doc)[0]).toMatchObject({
      path: 'bilder/a.png',
      kind: 'ASSET',
      attachmentId: 'att1',
    });
  });

  it('deletes a directory only when asked recursively', () => {
    const doc = project({ 'chapters/intro.tex': 'a', 'main.tex': 'b' });

    expect(() => deleteProjectPath(doc, 'chapters')).toThrow(ProjectStateError);

    const removed = deleteProjectPath(doc, 'chapters', { recursive: true });
    expect(removed).toEqual(['chapters/intro.tex']);
    expect(readProjectPaths(doc)).toEqual(['main.tex']);
  });

  it('builds loadable state for a fresh project', () => {
    const state = projectFilesToYjsState([{ path: 'main.tex', content: 'hallo' }]);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    expect(readProjectFileText(doc, 'main.tex')).toBe('hallo');
  });

  it('merges two clients editing different files without conflict', () => {
    const first = project({ 'a.tex': '', 'b.tex': '' });
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));

    writeProjectTextFile(first, 'a.tex', 'from first');
    writeProjectTextFile(second, 'b.tex', 'from second');

    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));

    expect(readProjectFileText(first, 'a.tex')).toBe('from first');
    expect(readProjectFileText(first, 'b.tex')).toBe('from second');
    expect(readProjectFileText(second, 'a.tex')).toBe('from first');
  });
});
