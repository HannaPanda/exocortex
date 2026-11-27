// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { DOMParser as PmDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  CALLOUT_EDIT_EVENT,
  calloutAttributes,
  calloutAttributesFromHeader,
  type CalloutEditEventDetail,
  calloutMarkdownHeader,
  resolveCallout,
  updateCalloutAt,
} from './callout';
import { migrateCalloutsInYjsDoc, migrateCalloutsInYjsState } from './callout-yjs';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildEditorExtensions } from './extensions';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { migrateDocument } from './migrations';
import { getExocortexSchema } from './schema';
import { SCHEMA_V6_MIGRATION } from './schema-v6';
import {
  proseMirrorJsonToYjsState,
  YJS_DOCUMENT_FIELD,
  yjsStateToDocument,
  yjsStateToProseMirrorJson,
} from './yjs';

/**
 * Issue #306: one callout with a symbol, a heading and a colour, and the five
 * old variants carried over without loss.
 */

function legacyCallout(variant: string, title: string | null, text: string): ProseMirrorNode {
  return {
    type: 'callout',
    attrs: { variant, ...(title === null ? {} : { title }) },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

/** Every old variant once, one of them with a heading and one nested in another. */
const LEGACY_DOCUMENT = doc(
  legacyCallout('info', 'Wichtig', 'Info-Text'),
  legacyCallout('note', null, 'Notiz-Text'),
  legacyCallout('success', null, 'Erfolg-Text'),
  legacyCallout('warning', 'Achtung', 'Warn-Text'),
  {
    type: 'callout',
    attrs: { variant: 'danger' },
    content: [legacyCallout('warning', null, 'Innen')],
  },
);

describe('resolveCallout', () => {
  it('reads every old variant as the symbol and colour it stood for', () => {
    expect(resolveCallout({ variant: 'info' })).toEqual({
      emoji: 'ℹ️',
      title: null,
      color: 'blue',
    });
    expect(resolveCallout({ variant: 'note' })).toEqual({ emoji: '📝', title: null, color: null });
    expect(resolveCallout({ variant: 'success' })).toEqual({
      emoji: '✅',
      title: null,
      color: 'green',
    });
    expect(resolveCallout({ variant: 'warning', title: 'Achtung' })).toEqual({
      emoji: '⚠️',
      title: 'Achtung',
      color: 'yellow',
    });
    expect(resolveCallout({ variant: 'danger' })).toEqual({
      emoji: '🚨',
      title: null,
      color: 'red',
    });
  });

  it('lets an explicit attribute win over the variant', () => {
    expect(resolveCallout({ variant: 'warning', emoji: '🔥', color: 'purple' })).toEqual({
      emoji: '🔥',
      title: null,
      color: 'purple',
    });
  });

  it('starts a callout without anything with the light bulb on the plain frame', () => {
    expect(resolveCallout({})).toEqual({ emoji: '💡', title: null, color: null });
    expect(resolveCallout({ color: 'default', title: '  ' })).toEqual({
      emoji: '💡',
      title: null,
      color: null,
    });
  });
});

describe('calloutAttributes', () => {
  it('writes the resolved values out and clears the variant, so one change keeps the rest', () => {
    expect(calloutAttributes({ variant: 'warning' }, { color: 'blue' })).toMatchObject({
      emoji: '⚠️',
      title: null,
      color: 'blue',
      variant: null,
    });
  });
});

describe('Markdown', () => {
  it('writes the keyword of the colour, the symbol and the heading', () => {
    expect(calloutMarkdownHeader({ emoji: '⚠️', title: 'Achtung', color: 'yellow' })).toBe(
      '[!warning] ⚠️ Achtung',
    );
    expect(calloutMarkdownHeader({ emoji: '💡' })).toBe('[!note] 💡');
    expect(calloutMarkdownHeader({ emoji: '🌸', color: 'pink' })).toBe('[!pink] 🌸');
    // An old variant is exported in the new form.
    expect(calloutMarkdownHeader({ variant: 'danger', title: 'Gefahr' })).toBe(
      '[!danger] 🚨 Gefahr',
    );
  });

  it('reads the old notation with the variant symbol, and the new one with its own', () => {
    expect(calloutAttributesFromHeader('warning', 'Achtung')).toEqual({
      emoji: '⚠️',
      title: 'Achtung',
      color: 'yellow',
    });
    expect(calloutAttributesFromHeader('warning', '💡 Achtung')).toEqual({
      emoji: '💡',
      title: 'Achtung',
      color: 'yellow',
    });
    expect(calloutAttributesFromHeader('note', '👩🏽‍💻')).toEqual({
      emoji: '👩🏽‍💻',
      title: null,
      color: null,
    });
  });

  it('reads GitHub alerts, Obsidian types and unknown keywords', () => {
    expect(calloutAttributesFromHeader('NOTE', '')).toMatchObject({ emoji: '📝', color: null });
    expect(calloutAttributesFromHeader('TIP', '')).toMatchObject({ emoji: '💡', color: 'green' });
    expect(calloutAttributesFromHeader('CAUTION', '')).toMatchObject({ color: 'red' });
    expect(calloutAttributesFromHeader('question', 'Warum?')).toMatchObject({
      emoji: '❓',
      title: 'Warum?',
    });
    expect(calloutAttributesFromHeader('purple', '')).toMatchObject({ color: 'purple' });
    expect(calloutAttributesFromHeader('irgendwas', 'Titel')).toEqual({
      emoji: '💡',
      title: 'Titel',
      color: null,
    });
  });

  it('round-trips symbol, heading, colour and body', () => {
    const source = [
      '> [!pink] 🌸 Für später',
      '> Erste Zeile.',
      '>',
      '> - Punkt',
      '',
      '> [!warning] ⚠️',
      '> Ohne Überschrift.',
      '',
    ].join('\n');
    const { document } = parseMarkdown(source);
    const [first, second] = document.content ?? [];
    expect(first?.attrs).toMatchObject({ emoji: '🌸', title: 'Für später', color: 'pink' });
    expect(second?.attrs).toMatchObject({ emoji: '⚠️', title: null, color: 'yellow' });

    const markdown = serializeMarkdown(document);
    expect(markdown).toContain('> [!pink] 🌸 Für später\n> Erste Zeile.');
    expect(serializeMarkdown(parseMarkdown(markdown).document)).toBe(markdown);
  });

  it('keeps the block id behind the heading', () => {
    const { document } = parseMarkdown('> [!info] ℹ️ Titel ^abc123def456\n> Text\n');
    expect(document.content?.[0]?.attrs).toMatchObject({ title: 'Titel', blockId: 'abc123def456' });
    expect(serializeMarkdown(document, { includeBlockIds: true })).toContain(
      '> [!info] ℹ️ Titel ^abc123def456',
    );
  });

  it('accepts the Obsidian fold marker and metadata', () => {
    const { document } = parseMarkdown('> [!tip|wide]- 🍀 Glück\n> Text\n');
    expect(document.content?.[0]?.attrs).toMatchObject({
      emoji: '🍀',
      title: 'Glück',
      color: 'green',
    });
  });

  it('exports an old callout in the new notation', () => {
    const markdown = serializeMarkdown(LEGACY_DOCUMENT);
    expect(markdown).toContain('> [!info] ℹ️ Wichtig');
    expect(markdown).toContain('> [!note] 📝');
    expect(markdown).toContain('> [!warning] ⚠️ Achtung');
    expect(markdown).toContain('> [!danger] 🚨');
    expect(markdown).toContain('> > [!warning] ⚠️');
  });
});

describe('schema 6 migration', () => {
  it('turns every variant into symbol and colour, keeps headings and content', () => {
    const migrated = SCHEMA_V6_MIGRATION.migrate(LEGACY_DOCUMENT);
    const attrs = (migrated.content ?? []).map((node) => node.attrs);
    expect(attrs).toEqual([
      { variant: null, emoji: 'ℹ️', title: 'Wichtig', color: 'blue' },
      { variant: null, emoji: '📝', title: null, color: null },
      { variant: null, emoji: '✅', title: null, color: 'green' },
      { variant: null, emoji: '⚠️', title: 'Achtung', color: 'yellow' },
      { variant: null, emoji: '🚨', title: null, color: 'red' },
    ]);
    expect(migrated.content?.[4]?.content?.[0]?.attrs).toMatchObject({
      emoji: '⚠️',
      color: 'yellow',
    });
    expect(serializeMarkdown(migrated)).toBe(serializeMarkdown(LEGACY_DOCUMENT));
  });

  it('leaves a migrated document untouched', () => {
    const once = SCHEMA_V6_MIGRATION.migrate(LEGACY_DOCUMENT);
    expect(SCHEMA_V6_MIGRATION.migrate(once)).toBe(once);
  });

  it('is part of the registered upgrade path', () => {
    const result = migrateDocument(LEGACY_DOCUMENT, 5);
    expect(result.toVersion).toBe(6);
    expect(result.document.content?.[3]?.attrs?.emoji).toBe('⚠️');
  });
});

describe('migrating the stored Yjs state in place', () => {
  it('sets the attributes on the stored elements and keeps the history', () => {
    const state = proseMirrorJsonToYjsState(LEGACY_DOCUMENT);
    const result = migrateCalloutsInYjsState(state);
    expect(result.migrated).toBe(6);
    const next = result.yjsState;
    if (next === null) throw new Error('expected a migrated state');

    // Applied on top of the old state rather than replacing it: an update made
    // from the old state merges into the new one without duplicating anything.
    const old = yjsStateToDocument(state);
    Y.applyUpdate(old, next);
    const merged = yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(old));
    expect(merged).toEqual(yjsStateToProseMirrorJson(next));
    expect(merged.content).toHaveLength(5);

    const element = old.getXmlFragment(YJS_DOCUMENT_FIELD).get(3) as Y.XmlElement;
    expect(element.getAttributes()).toEqual({ emoji: '⚠️', title: 'Achtung', color: 'yellow' });
    old.destroy();

    expect(serializeMarkdown(yjsStateToProseMirrorJson(next))).toBe(
      serializeMarkdown(LEGACY_DOCUMENT),
    );
  });

  it('writes nothing for a page that is already migrated or has no callout', () => {
    const migrated = migrateCalloutsInYjsState(proseMirrorJsonToYjsState(LEGACY_DOCUMENT));
    if (migrated.yjsState === null) throw new Error('expected a migrated state');
    expect(migrateCalloutsInYjsState(migrated.yjsState)).toEqual({ yjsState: null, migrated: 0 });

    const plain = doc({ type: 'paragraph', content: [{ type: 'text', text: 'Nur Text' }] });
    expect(migrateCalloutsInYjsState(proseMirrorJsonToYjsState(plain)).migrated).toBe(0);
  });

  it('migrates a live document and reports the count', () => {
    const live = yjsStateToDocument(proseMirrorJsonToYjsState(LEGACY_DOCUMENT));
    expect(migrateCalloutsInYjsDoc(live)).toBe(6);
    expect(migrateCalloutsInYjsDoc(live)).toBe(0);
    live.destroy();
  });
});

describe('in the editor', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(content: ProseMirrorDocument): Editor {
    editor = new Editor({ extensions: buildEditorExtensions(), content });
    return editor;
  }

  it('draws the symbol as a named button and the heading above the content', () => {
    const instance = mount(doc(legacyCallout('warning', 'Achtung', 'Text')));
    const box = instance.view.dom.querySelector('aside.exocortex-callout');
    expect(box?.getAttribute('role')).toBe('note');
    expect(box?.getAttribute('data-color')).toBe('yellow');
    const emoji = box?.querySelector('button[data-callout-emoji]');
    expect(emoji?.textContent).toBe('⚠️');
    expect(emoji?.getAttribute('aria-label')).toBe('Symbol ⚠️, Hinweis anpassen');
    const title = box?.querySelector<HTMLElement>('[data-callout-title]');
    expect(title?.textContent).toBe('Achtung');
    expect(title?.hidden).toBe(false);
    expect(box?.querySelector('.exocortex-callout-content')?.textContent).toBe('Text');
  });

  it('paints a change in place, so the button a menu is anchored to stays', () => {
    const callout = legacyCallout('info', null, 'Text');
    callout.attrs = { ...callout.attrs, blockId: 'callout00001' };
    const paragraph = callout.content?.[0];
    if (paragraph !== undefined) paragraph.attrs = { blockId: 'paragraph001' };
    const instance = mount(doc(callout));
    const before = instance.view.dom.querySelector('button[data-callout-emoji]');
    const tr = instance.state.tr;
    expect(updateCalloutAt(tr, 0, { emoji: '🔥', title: 'Heiß', color: 'red' })).toBe(true);
    instance.view.dispatch(tr);

    const after = instance.view.dom.querySelector('button[data-callout-emoji]');
    expect(after).toBe(before);
    expect(after?.textContent).toBe('🔥');
    expect(instance.view.dom.querySelector('aside')?.getAttribute('data-color')).toBe('red');
    expect(instance.view.dom.querySelector('[data-callout-title]')?.textContent).toBe('Heiß');
    expect(instance.state.doc.firstChild?.attrs).toMatchObject({
      emoji: '🔥',
      title: 'Heiß',
      color: 'red',
      variant: null,
    });
  });

  it('changes attributes without moving any position, so an open menu keeps its box', () => {
    const instance = mount(doc({ type: 'paragraph' }, legacyCallout('note', null, 'Text')));
    const pos = instance.state.doc.firstChild?.nodeSize ?? 0;
    const tr = instance.state.tr;
    expect(updateCalloutAt(tr, pos, { title: 'Achtung' })).toBe(true);
    // `setNodeMarkup` would map `pos` as deleted, which closed the menu.
    const mapped = tr.mapping.mapResult(pos);
    expect(mapped.deleted).toBe(false);
    expect(mapped.pos).toBe(pos);
    expect(tr.doc.nodeAt(pos)?.attrs.title).toBe('Achtung');
  });

  it('announces a press on the symbol with the callout position', () => {
    const instance = mount(doc({ type: 'paragraph' }, legacyCallout('note', null, 'Text')));
    const seen: CalloutEditEventDetail[] = [];
    instance.view.dom.addEventListener(CALLOUT_EDIT_EVENT, (event) => {
      seen.push((event as CustomEvent<CalloutEditEventDetail>).detail);
    });
    instance.view.dom.querySelector<HTMLButtonElement>('button[data-callout-emoji]')?.click();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.part).toBe('emoji');
    expect(instance.state.doc.nodeAt(seen[0]?.pos ?? -1)?.type.name).toBe('callout');
  });

  it('inserts a new callout with the light bulb', () => {
    const instance = mount(doc({ type: 'paragraph', content: [{ type: 'text', text: 'Hallo' }] }));
    instance.commands.setTextSelection(2);
    expect(instance.commands.setCallout()).toBe(true);
    expect(instance.state.doc.firstChild?.attrs).toMatchObject({ emoji: '💡', color: null });
  });

  it('copies as HTML that keeps symbol and heading readable and parses back', () => {
    const schema = getExocortexSchema();
    const node = schema.nodeFromJSON(
      doc({
        type: 'callout',
        attrs: { emoji: '⚠️', title: 'Achtung', color: 'yellow' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }],
      }),
    );
    const html = document.createElement('div');
    html.append(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
    expect(html.textContent).toBe('⚠️AchtungText');

    const parsed = PmDOMParser.fromSchema(schema).parse(html);
    expect(parsed.firstChild?.attrs).toMatchObject({
      emoji: '⚠️',
      title: 'Achtung',
      color: 'yellow',
    });
    expect(parsed.firstChild?.textContent).toBe('Text');
  });

  it('parses HTML from before #306 with its variant', () => {
    const schema = getExocortexSchema();
    const html = document.createElement('div');
    html.innerHTML =
      '<aside data-callout data-variant="danger" data-title="Gefahr"><p>Alt</p></aside>';
    const parsed = PmDOMParser.fromSchema(schema).parse(html);
    expect(resolveCallout(parsed.firstChild?.attrs)).toEqual({
      emoji: '🚨',
      title: 'Gefahr',
      color: 'red',
    });
    expect(parsed.firstChild?.textContent).toBe('Alt');
  });
});
