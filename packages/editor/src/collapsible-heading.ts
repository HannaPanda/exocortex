import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** Attribute that marks a heading as collapsed. */
export const HEADING_COLLAPSED_ATTRIBUTE = 'collapsed';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    collapsibleHeading: {
      /** Collapses or expands the heading the cursor is in. */
      toggleHeadingCollapsed: () => ReturnType;
    };
  }
}

const collapsibleHeadingKey = new PluginKey('exocortexCollapsibleHeading');

/**
 * Collapsible headings (Notion's "Umschaltbare Überschrift").
 *
 * The document stores one boolean per heading. Which blocks are *hidden* is
 * derived on every render from that boolean plus the heading levels, and is
 * expressed as decorations, never as document structure. Two reasons:
 *
 *  * collapsing must not move content into a wrapper node — a collaborator with a
 *    cursor in the section would have it remapped, and a Markdown export would
 *    have to invent nesting the source never had;
 *  * a heading level change instantly changes what belongs to the section, with no
 *    migration and no stale wrapper.
 *
 * The trade-off is that a hidden block is still in the document (and still in the
 * search index), which is the correct behaviour: it is collapsed, not deleted.
 */
export const CollapsibleHeading = Extension.create({
  name: 'collapsibleHeading',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          [HEADING_COLLAPSED_ATTRIBUTE]: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute('data-collapsed') === 'true',
            renderHTML: (attributes) =>
              attributes[HEADING_COLLAPSED_ATTRIBUTE] === true ? { 'data-collapsed': 'true' } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      toggleHeadingCollapsed:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth >= 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.name !== 'heading') continue;
            const collapsed = node.attrs[HEADING_COLLAPSED_ATTRIBUTE] === true;
            return chain()
              .command(({ tr }) => {
                tr.setNodeAttribute($from.before(depth), HEADING_COLLAPSED_ATTRIBUTE, !collapsed);
                return true;
              })
              .run();
          }
          return false;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: collapsibleHeadingKey,
        props: {
          decorations: (state) => {
            const hidden = collapsedDecorations(state.doc);
            // The affordance is a widget rather than a node view: a node view on
            // `heading` would replace the DOM every other extension styles.
            return hidden.add(state.doc, headingToggleWidgets(state.doc, this.editor.isEditable));
          },
        },
      }),
    ];
  },
});

/**
 * Hides every top-level block that follows a collapsed heading, up to the next
 * heading of the same or a higher level.
 *
 * Only top-level children are considered: a heading inside a column or a toggle
 * governs that container's content, and the same walk runs there.
 */
export function collapsedDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];

  const walk = (parent: PmNode, parentStart: number): void => {
    /** Levels of the collapsed headings currently in effect, ascending. */
    const collapsedLevels: number[] = [];
    let offset = parentStart;

    parent.forEach((child) => {
      const from = offset;
      offset += child.nodeSize;

      if (child.type.name === 'heading') {
        const level = typeof child.attrs.level === 'number' ? child.attrs.level : 1;
        // A heading of the same or a higher level ends every deeper section.
        while (collapsedLevels.length > 0 && (collapsedLevels.at(-1) as number) >= level) {
          collapsedLevels.pop();
        }
        // A heading nested inside a collapsed section is hidden itself.
        if (collapsedLevels.length > 0) {
          decorations.push(hide(from, from + child.nodeSize));
        } else if (child.attrs[HEADING_COLLAPSED_ATTRIBUTE] === true) {
          collapsedLevels.push(level);
        }
        return;
      }

      if (collapsedLevels.length > 0) {
        decorations.push(hide(from, from + child.nodeSize));
        return;
      }

      // Containers govern their own content, so recurse into them.
      if (child.type.name === 'columnList' || child.type.name === 'column') {
        walk(child, from + 1);
      }
    });
  };

  walk(doc, 0);
  return DecorationSet.create(doc, decorations);
}

function hide(from: number, to: number): Decoration {
  return Decoration.node(from, to, { class: 'exocortex-collapsed' });
}

/**
 * A disclosure button in front of every heading, so the state is reachable with
 * the pointer and with the keyboard and is announced by a screen reader.
 *
 * `aria-expanded` on a real `<button>` is what makes this an accessible
 * disclosure; the arrow glyph is decoration on top of it.
 */
function headingToggleWidgets(doc: PmNode, editable: boolean): Decoration[] {
  if (!editable) return [];
  const widgets: Decoration[] = [];
  let offset = 0;

  doc.forEach((child) => {
    const from = offset;
    offset += child.nodeSize;
    if (child.type.name !== 'heading') return;

    const collapsed = child.attrs[HEADING_COLLAPSED_ATTRIBUTE] === true;
    widgets.push(
      Decoration.widget(
        from + 1,
        (view, getPos) => {
          const button = window.document.createElement('button');
          button.type = 'button';
          button.className = 'exocortex-heading-toggle';
          button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          button.setAttribute(
            'aria-label',
            collapsed ? 'Abschnitt ausklappen' : 'Abschnitt einklappen',
          );
          button.textContent = collapsed ? '▸' : '▾';
          button.addEventListener('mousedown', (event) => {
            event.preventDefault();
            const pos = getPos();
            if (pos === undefined) return;
            view.dispatch(
              view.state.tr.setNodeAttribute(pos - 1, HEADING_COLLAPSED_ATTRIBUTE, !collapsed),
            );
          });
          return button;
        },
        { side: -1, ignoreSelection: true, key: `heading-toggle-${from}-${String(collapsed)}` },
      ),
    );
  });

  return widgets;
}
