import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { foreignRootTypes } from './foreign-history';

function page(...nodeNames: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  fragment.insert(
    0,
    nodeNames.map((name) => {
      const node = new Y.XmlElement(name);
      node.insert(0, [new Y.XmlText(name)]);
      return node;
    }),
  );
  return doc;
}

/** A second document that starts from `source`, the way a browser does after a sync. */
function relative(source: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  return copy;
}

/** What `copy` would send `server`: everything the server does not have yet. */
function diff(copy: Y.Doc, server: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(copy, Y.encodeStateVector(server));
}

describe('foreignRootTypes', () => {
  it('refuses a copy that was built without the stored history', () => {
    const server = page('heading', 'paragraph');
    const stale = page('heading', 'paragraph');

    expect(foreignRootTypes(server, diff(stale, server))).toEqual(['default']);
  });

  it('accepts an edit from a copy that started from the stored state', () => {
    const server = page('heading', 'paragraph');
    const browser = relative(server);
    browser.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    browser.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);

    expect(foreignRootTypes(server, diff(browser, server))).toEqual([]);
  });

  it('accepts typing into a nested node', () => {
    const server = page('paragraph');
    const browser = relative(server);
    const paragraph = browser.getXmlFragment('default').get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(0, 'more ');

    expect(foreignRootTypes(server, diff(browser, server))).toEqual([]);
  });

  it('accepts the first content of an empty page', () => {
    const server = new Y.Doc();
    const browser = page('paragraph');

    expect(foreignRootTypes(server, diff(browser, server))).toEqual([]);
  });

  it('refuses a stranger even when everything the server held was deleted', () => {
    const server = page('paragraph');
    server.getXmlFragment('default').delete(0, 1);
    const stale = page('paragraph');

    expect(foreignRootTypes(server, diff(stale, server))).toEqual(['default']);
  });

  it('accepts a resend of items the server already holds', () => {
    const server = page('heading');
    const browser = relative(server);

    expect(foreignRootTypes(server, Y.encodeStateAsUpdate(browser))).toEqual([]);
  });

  it('leaves map entries alone', () => {
    const server = new Y.Doc();
    server.getMap('meta').set('a', 1);
    const other = new Y.Doc();
    other.getMap('meta').set('b', 2);

    expect(foreignRootTypes(server, diff(other, server))).toEqual([]);
  });
});
